import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { RealtimeService } from '../src/modules/realtime/realtime.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';
import { CACHE_KEYS } from '../src/common/constants/index.js';

describe('Realtime Socket Gateway & Sync API (E2E)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redisService: RedisService;
  let realtimeService: RealtimeService;
  let serverPort: number;

  const createdUserIds: string[] = [];
  const activeSockets: ClientSocket[] = [];

  let passengerToken: string;
  let passengerUserId: string;

  let driverToken: string;
  let driverUserId: string;
  let driverProfileId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'health/ready', 'health/live'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());

    await app.init();
    await app.listen(0);

    const httpServer = app.getHttpServer();
    const addr = httpServer.address();
    serverPort = typeof addr === 'string' ? 3000 : addr.port;

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    redisService = moduleFixture.get<RedisService>(RedisService);
    realtimeService = moduleFixture.get<RealtimeService>(RealtimeService);

    // 1. Authenticate Passenger via Google Mock Auth
    const passGoogleToken = `mock-google-id-token:sub-pass-${Date.now()}:passenger.${Date.now()}@pdeu.ac.in:Passenger Realtime`;
    const passRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: passGoogleToken });
    passengerUserId = passRes.body.data.user.id;
    passengerToken = passRes.body.data.accessToken;
    createdUserIds.push(passengerUserId);

    // 2. Authenticate Driver via Google Mock Auth & Onboard
    const driverGoogleToken = `mock-google-id-token:sub-drv-${Date.now()}:driver.${Date.now()}@pdeu.ac.in:Driver Realtime`;
    const driverRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: driverGoogleToken });
    driverUserId = driverRes.body.data.user.id;
    driverToken = driverRes.body.data.accessToken;
    createdUserIds.push(driverUserId);

    const onboardRes = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        licenseNumber: `GJ-01-RT-${Date.now()}`,
        vehicle: {
          registrationNumber: `GJ-01-V-${Date.now()}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo 2026',
        },
      });
    driverProfileId = onboardRes.body.data.driverProfile.id;

    // Approve driver in PostgreSQL directly for testing
    await prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });

    await prisma.user.update({
      where: { id: driverUserId },
      data: { role: 'DRIVER' },
    });
    await prisma.userRole.create({
      data: {
        userId: driverUserId,
        roleName: 'DRIVER',
      },
    }).catch(() => {});

    // Refresh driver token to ensure updated roles/context
    const refreshDriverRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: driverGoogleToken });
    driverToken = refreshDriverRes.body.data.accessToken;
  });

  afterAll(async () => {
    // Disconnect any lingering client sockets
    for (const s of activeSockets) {
      if (s.connected) s.disconnect();
    }

    // Clean up created test data
    if (createdUserIds.length > 0) {
      await prisma.vehicle.deleteMany({ where: { driverProfileId } }).catch(() => {});
      await prisma.driverProfile.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.passengerProfile.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }

    await app.close();
  });

  describe('1. Socket Ticket Generation & Single-Use Handshake', () => {
    it('generates a 60-second single-use ticket via GET /api/v1/auth/socket-ticket', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/socket-ticket')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.ticket).toBeDefined();
      expect(res.body.data.expiresIn).toBe(60);

      // Verify ticket is stored in Redis
      const redis = redisService.getClient();
      const raw = await redis.get(`${CACHE_KEYS.SOCKET_TICKET_PREFIX}${res.body.data.ticket}`);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.userId).toBe(passengerUserId);
    });

    it('authenticates Socket.IO connection and burns ticket atomically via GETDEL', async () => {
      // 1. Get ticket
      const ticketRes = await request(app.getHttpServer())
        .get('/api/v1/auth/socket-ticket')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      const ticket = ticketRes.body.data.ticket;

      // 2. Connect client socket
      const client = io(`http://127.0.0.1:${serverPort}/realtime`, {
        forceNew: true,
        auth: { ticket },
        transports: ['websocket'],
        reconnection: false,
      });
      activeSockets.push(client);

      const connectedPromise = new Promise<{ authenticated: boolean; rooms: string[] }>((resolve) => {
        client.on('connected', (data) => resolve(data));
      });

      const ack = await connectedPromise;
      expect(ack.authenticated).toBe(true);
      expect(ack.rooms).toContain(`user:${passengerUserId}`);
      expect(ack.rooms).toContain(`passenger:${passengerUserId}`);

      // 3. Verify ticket was burned immediately
      const redis = redisService.getClient();
      const postBurn = await redis.get(`${CACHE_KEYS.SOCKET_TICKET_PREFIX}${ticket}`);
      expect(postBurn).toBeNull();

      // 4. Second connection attempt using the burned ticket must be rejected
      const replayClient = io(`http://127.0.0.1:${serverPort}/realtime`, {
        forceNew: true,
        auth: { ticket },
        transports: ['websocket'],
        reconnection: false,
      });
      activeSockets.push(replayClient);

      const errorPromise = new Promise<{ code: string; message: string }>((resolve) => {
        replayClient.on('error', (err) => resolve(err));
      });

      const errorAck = await errorPromise;
      expect(errorAck.code).toBe('UNAUTHORIZED');
      expect(errorAck.message).toContain('already consumed');
    });

    it('rejects connection when ticket is not a valid UUID string', async () => {
      const invalidClient = io(`http://127.0.0.1:${serverPort}/realtime`, {
        forceNew: true,
        auth: { ticket: 'malformed-ticket-string-123' },
        transports: ['websocket'],
        reconnection: false,
      });
      activeSockets.push(invalidClient);

      const errorPromise = new Promise<{ code: string; message: string }>((resolve) => {
        invalidClient.on('error', (err) => resolve(err));
      });

      const errorAck = await errorPromise;
      expect(errorAck.code).toBe('UNAUTHORIZED');
      expect(errorAck.message).toContain('Valid socket ticket UUID required');
    });

    it('rejects connection when authoritative user is deactivated in PostgreSQL', async () => {
      // 1. Get passenger ticket
      const ticketRes = await request(app.getHttpServer())
        .get('/api/v1/auth/socket-ticket')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      const ticket = ticketRes.body.data.ticket;

      // 2. Temporarily deactivate passenger in PostgreSQL
      await prisma.user.update({
        where: { id: passengerUserId },
        data: { isActive: false },
      });

      // 3. Connect client socket
      const client = io(`http://127.0.0.1:${serverPort}/realtime`, {
        forceNew: true,
        auth: { ticket },
        transports: ['websocket'],
        reconnection: false,
      });
      activeSockets.push(client);

      const errorPromise = new Promise<{ code: string; message: string }>((resolve) => {
        client.on('error', (err) => resolve(err));
      });

      const errorAck = await errorPromise;
      expect(errorAck.code).toBe('UNAUTHORIZED');
      expect(errorAck.message).toContain('deactivated or suspended');

      // 4. Restore user active status
      await prisma.user.update({
        where: { id: passengerUserId },
        data: { isActive: true },
      });
    });
  });

  describe('2. Driver GPS Telemetry Stream & Broadcast', () => {
    it('driver streams GPS coordinates and receives acknowledgement', async () => {
      // 1. Get driver ticket
      const ticketRes = await request(app.getHttpServer())
        .get('/api/v1/auth/socket-ticket')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);

      const driverSocket = io(`http://127.0.0.1:${serverPort}/realtime`, {
        forceNew: true,
        autoConnect: false,
        auth: { ticket: ticketRes.body.data.ticket },
        transports: ['websocket'],
        reconnection: false,
      });
      activeSockets.push(driverSocket);

      const connectPromise = new Promise((resolve) => driverSocket.on('connected', resolve));
      driverSocket.connect();
      await connectPromise;

      // 2. Emit driver location update
      const updateAck = await new Promise<{ success: boolean; updatedAt?: string }>((resolve) => {
        driverSocket.emit(
          'driver.location.update',
          {
            latitude: 23.188,
            longitude: 72.632,
            heading: 45,
            speed: 20,
          },
          (res: any) => resolve(res),
        );
      });

      expect(updateAck.success).toBe(true);
      expect(updateAck.updatedAt).toBeDefined();

      // 3. Verify Redis has fresh driver GPS
      const redis = redisService.getClient();
      const rawGps = await redis.get(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${driverProfileId}`);
      expect(rawGps).not.toBeNull();
      const parsedGps = JSON.parse(rawGps!);
      expect(parsedGps.latitude).toBe(23.188);
      expect(parsedGps.longitude).toBe(72.632);
    });

    it('rejects GPS update with DRIVER_OFFLINE when driver is offline and has no active trip', async () => {
      // Mark driver offline
      await prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: { isOnline: false, operationalStatus: 'OFFLINE' },
      });

      const ticketRes = await request(app.getHttpServer())
        .get('/api/v1/auth/socket-ticket')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);

      const driverSocket = io(`http://127.0.0.1:${serverPort}/realtime`, {
        forceNew: true,
        autoConnect: false,
        auth: { ticket: ticketRes.body.data.ticket },
        transports: ['websocket'],
        reconnection: false,
      });
      activeSockets.push(driverSocket);

      const connectPromise = new Promise((resolve) => driverSocket.on('connected', resolve));
      driverSocket.connect();
      await connectPromise;

      const updateAck = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        driverSocket.emit(
          'driver.location.update',
          {
            latitude: 23.188,
            longitude: 72.632,
          },
          (res: any) => resolve(res),
        );
      });

      expect(updateAck.success).toBe(false);
      expect(updateAck.error).toBe('DRIVER_OFFLINE');

      // Restore driver to online
      await prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: { isOnline: true, operationalStatus: 'AVAILABLE' },
      });
    });
  });

  describe('3. Room Subscription Authorization Enforcement', () => {
    it('rejects subscription to unauthorized trip room with FORBIDDEN', async () => {
      const ticketRes = await request(app.getHttpServer())
        .get('/api/v1/auth/socket-ticket')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      const passengerSocket = io(`http://127.0.0.1:${serverPort}/realtime`, {
        forceNew: true,
        autoConnect: false,
        auth: { ticket: ticketRes.body.data.ticket },
        transports: ['websocket'],
        reconnection: false,
      });
      activeSockets.push(passengerSocket);

      const connectPromise = new Promise((resolve) => passengerSocket.on('connected', resolve));
      passengerSocket.connect();
      await connectPromise;

      const strangerTripId = '99999999-9999-4999-a999-999999999999';
      const ack = await new Promise<{ success: boolean; error?: string; message?: string }>((resolve) => {
        passengerSocket.emit('subscribe:trip', { tripId: strangerTripId }, (res: any) => resolve(res));
      });

      expect(ack.success).toBe(false);
      expect(ack.error).toBe('FORBIDDEN');
      expect(ack.message).toContain('Not authorized for trip room');
    });
  });

  describe('4. Outbox Event Broadcasting over Socket.IO', () => {
    it('broadcasts domain events to target rooms', async () => {
      // 1. Get passenger ticket and connect
      const ticketRes = await request(app.getHttpServer())
        .get('/api/v1/auth/socket-ticket')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      const passengerSocket = io(`http://127.0.0.1:${serverPort}/realtime`, {
        forceNew: true,
        autoConnect: false,
        auth: { ticket: ticketRes.body.data.ticket },
        transports: ['websocket'],
        reconnection: false,
      });
      activeSockets.push(passengerSocket);

      const passConnectPromise = new Promise((resolve) => passengerSocket.on('connected', resolve));
      passengerSocket.connect();
      await passConnectPromise;

      // 2. Prepare event listener on passenger room
      const receivedPromise = new Promise<any>((resolve) => {
        passengerSocket.on('booking.status.updated', (envelope) => resolve(envelope));
      });

      // 3. Simulate outbox event publication
      await realtimeService.broadcastOutboxEvent({
        id: 'outbox-test-1',
        eventType: 'BOOKING_RETURNED_TO_MATCHING',
        aggregateType: 'BOOKING',
        aggregateId: 'booking-test-uuid',
        payload: {
          passengerId: passengerUserId,
          reason: 'REMATCHING',
        },
      });

      const envelope = await receivedPromise;
      expect(envelope.event).toBe('booking.status.updated');
      expect(envelope.entityType).toBe('BOOKING');
      expect(envelope.entityId).toBe('booking-test-uuid');
      expect(envelope.data.passengerId).toBe(passengerUserId);
    });
  });

  describe('4. Reconnection State Synchronization (POST /api/v1/sync)', () => {
    it('returns authoritative passenger state snapshot for reconnected commuter', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/sync')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          lastKnownEntityVersion: 1,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.role).toBe('PASSENGER');
      expect(res.body.serverTimestamp).toBeDefined();
      expect(res.body.passengerState).toBeDefined();
      expect(res.body.reconciled).toBe(false);
    });

    it('returns authoritative driver state snapshot for reconnected driver', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/sync')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.role).toBe('DRIVER');
      expect(res.body.driverState).toBeDefined();
      expect(res.body.driverState.driverProfile.verificationStatus).toBe('APPROVED');
      expect(res.body.driverState.driverProfile.id).toBe(driverProfileId);
    });

    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/sync')
        .send({})
        .expect(401);
    });
  });
});
