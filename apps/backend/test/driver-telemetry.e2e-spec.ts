import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';
import { CACHE_KEYS } from '../src/common/constants/index.js';

describe('Driver Status & Telemetry Ingestion (E2E)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redisService: RedisService;

  const createdUserIds: string[] = [];
  const createdAssignmentIds: string[] = [];
  const createdAttemptIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdPickupPointIds: string[] = [];

  let approvedDriverToken: string;
  let approvedDriverUserId: string;
  let approvedDriverProfileId: string;

  let pendingDriverToken: string;
  let passengerToken: string;

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

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    redisService = moduleFixture.get<RedisService>(RedisService);

    // 1. Create and authenticate Admin for approving drivers
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${Date.now()}@pdeu.ac.in`,
        fullName: 'Security Transport Admin',
        role: 'ADMIN',
        roles: {
          create: { roleName: 'ADMIN' },
        },
      },
    });
    const adminUserId = adminUser.id;
    createdUserIds.push(adminUserId);

    const adminLoginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({
        idToken: `mock-google-id-token:admin-sub-${Date.now()}:${adminUser.email}:Security Admin`,
      });
    const adminToken = adminLoginRes.body.data.accessToken;

    // 2. Create Approved Driver
    const driverGoogleToken = `mock-google-id-token:sub-drv-appr-${Date.now()}:driver.appr@pdeu.ac.in:Driver Approved`;
    const driverRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: driverGoogleToken });
    approvedDriverUserId = driverRes.body.data.user.id;
    createdUserIds.push(approvedDriverUserId);
    approvedDriverToken = driverRes.body.data.accessToken;

    const uniqueLic1 = `GJ-01-APP-${Date.now()}`;
    const uniqueReg1 = `GJ-01-RA-${Date.now()}`;
    const onboardRes1 = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${approvedDriverToken}`)
      .send({
        licenseNumber: uniqueLic1,
        vehicle: {
          registrationNumber: uniqueReg1,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo 2026',
        },
      });
    approvedDriverProfileId = onboardRes1.body.data.driverProfile.id;

    // Approve the driver via admin
    await request(app.getHttpServer())
      .post(`/api/v1/admin/drivers/${approvedDriverProfileId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Refresh driver token to ensure updated roles/context
    const refreshDriverRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: driverGoogleToken });
    approvedDriverToken = refreshDriverRes.body.data.accessToken;

    // 3. Create Pending (Unapproved) Driver
    const pendingGoogleToken = `mock-google-id-token:sub-drv-pend-${Date.now()}:driver.pend@pdeu.ac.in:Driver Pending`;
    const pendingRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: pendingGoogleToken });
    const pendingUserId = pendingRes.body.data.user.id;
    createdUserIds.push(pendingUserId);
    pendingDriverToken = pendingRes.body.data.accessToken;

    const uniqueLic2 = `GJ-01-PND-${Date.now()}`;
    const uniqueReg2 = `GJ-01-RP-${Date.now()}`;
    await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${pendingDriverToken}`)
      .send({
        licenseNumber: uniqueLic2,
        vehicle: {
          registrationNumber: uniqueReg2,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo 2026',
        },
      });
    const refreshPendingRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: pendingGoogleToken });
    pendingDriverToken = refreshPendingRes.body.data.accessToken;

    // 4. Create Standard Passenger User
    const passGoogleToken = `mock-google-id-token:sub-pass-${Date.now()}:commuter@pdeu.ac.in:Commuter User`;
    const passRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: passGoogleToken });
    const passUserId = passRes.body.data.user.id;
    createdUserIds.push(passUserId);
    passengerToken = passRes.body.data.accessToken;
  });

  afterAll(async () => {
    // Clean up created entities
    for (const id of createdAssignmentIds) {
      await prisma.driverAssignment.delete({ where: { id } }).catch(() => {});
    }
    for (const id of createdAttemptIds) {
      await prisma.dispatchAttempt.delete({ where: { id } }).catch(() => {});
    }
    for (const id of createdGroupIds) {
      await prisma.rideGroup.delete({ where: { id } }).catch(() => {});
    }
    for (const id of createdPickupPointIds) {
      await prisma.pickupPoint.delete({ where: { id } }).catch(() => {});
    }
    for (const userId of createdUserIds) {
      await prisma.userSession.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.authIdentity.deleteMany({ where: { userId } }).catch(() => {});
      const driver = await prisma.driverProfile.findUnique({ where: { userId } }).catch(() => null);
      if (driver) {
        await prisma.driverDocument.deleteMany({ where: { driverProfileId: driver.id } }).catch(() => {});
        await prisma.vehicle.deleteMany({ where: { driverProfileId: driver.id } }).catch(() => {});
        await prisma.driverProfile.delete({ where: { id: driver.id } }).catch(() => {});
      }
      await prisma.userRole.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }

    if (approvedDriverProfileId) {
      const client = redisService.getClient();
      await client.del(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${approvedDriverProfileId}`);
    }

    await app.close();
  });

  describe('PATCH /api/v1/drivers/status', () => {
    it('should allow an approved driver to go online and transition to AVAILABLE', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ isOnline: true })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isOnline).toBe(true);
      expect(res.body.data.operationalStatus).toBe('AVAILABLE');
      expect(res.body.data.verificationStatus).toBe('APPROVED');

      // Verify in DB
      const driverInDb = await prisma.driverProfile.findUnique({
        where: { id: approvedDriverProfileId },
      });
      expect(driverInDb!.isOnline).toBe(true);
      expect(driverInDb!.operationalStatus).toBe('AVAILABLE');
    });

    it('should allow an unassigned approved driver to go offline and transition to OFFLINE', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ isOnline: false })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isOnline).toBe(false);
      expect(res.body.data.operationalStatus).toBe('OFFLINE');

      const driverInDb = await prisma.driverProfile.findUnique({
        where: { id: approvedDriverProfileId },
      });
      expect(driverInDb!.isOnline).toBe(false);
      expect(driverInDb!.operationalStatus).toBe('OFFLINE');
    });

    it('should reject unapproved driver with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${pendingDriverToken}`)
        .send({ isOnline: true })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should reject non-driver user with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ isOnline: true })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should reject unauthenticated request with 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .send({ isOnline: true })
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('UNAUTHORIZED');
    });

    it('should reject invalid payload with 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ isOnline: 'yes-please' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('VALIDATION_ERROR');
    });

    it('should prevent driver with RESERVED assignment from going offline (409 Conflict)', async () => {
      // First ensure driver is online
      await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ isOnline: true })
        .expect(200);

      // Create a test pickup point, group, attempt and assignment in RESERVED status
      const pickupPoint = await prisma.pickupPoint.findFirst();
      const pId = pickupPoint?.id ?? randomUUID();

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pId,
          rideType: 'SHARED',
          groupVersion: 1,
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 5000,
          totalRouteDistanceMeters: 3000,
          totalRouteDurationSec: 400,
        },
      });
      createdGroupIds.push(group.id);

      const attempt = await prisma.dispatchAttempt.create({
        data: {
          rideGroupId: group.id,
          groupVersion: 1,
          status: 'ACTIVE',
        },
      });
      createdAttemptIds.push(attempt.id);

      const assignment = await prisma.driverAssignment.create({
        data: {
          dispatchAttemptId: attempt.id,
          rideGroupId: group.id,
          driverId: approvedDriverProfileId,
          status: 'RESERVED',
        },
      });
      createdAssignmentIds.push(assignment.id);

      // Try going offline
      const res = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ isOnline: false })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('active or reserved assignment');

      // Update assignment to ACTIVE and verify still blocked
      await prisma.driverAssignment.update({
        where: { id: assignment.id },
        data: { status: 'ACTIVE' },
      });

      const resActive = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ isOnline: false })
        .expect(409);

      expect(resActive.body.success).toBe(false);
      expect(resActive.body.message).toContain('active or reserved assignment');

      // Clean up assignment and verify driver can now go offline
      await prisma.driverAssignment.delete({ where: { id: assignment.id } });
      const idx = createdAssignmentIds.indexOf(assignment.id);
      if (idx !== -1) createdAssignmentIds.splice(idx, 1);

      const resAllowed = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ isOnline: false })
        .expect(200);

      expect(resAllowed.body.data.operationalStatus).toBe('OFFLINE');
      expect(resAllowed.body.data.isOnline).toBe(false);
    });
  });

  describe('POST /api/v1/drivers/location', () => {
    it('should ingest valid GPS fix into Redis with 30-second TTL', async () => {
      const payload = {
        latitude: 23.1555,
        longitude: 72.667,
        heading: 180.5,
        speed: 6.2,
      };

      const res = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send(payload)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.driverId).toBe(approvedDriverProfileId);
      expect(res.body.data.latitude).toBe(23.1555);
      expect(res.body.data.longitude).toBe(72.667);
      expect(res.body.data.heading).toBe(180.5);
      expect(res.body.data.speed).toBe(6.2);
      expect(res.body.data.updatedAt).toBeDefined();

      // Check Redis key and TTL directly
      const client = redisService.getClient();
      const redisKey = `${CACHE_KEYS.DRIVER_GPS_PREFIX}${approvedDriverProfileId}`;
      const raw = await client.get(redisKey);
      expect(raw).not.toBeNull();

      const stored = JSON.parse(raw!);
      expect(stored.latitude).toBe(23.1555);
      expect(stored.longitude).toBe(72.667);
      expect(stored.heading).toBe(180.5);
      expect(stored.speed).toBe(6.2);

      const ttl = await client.ttl(redisKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });

    it('should accept optional heading and speed omitted', async () => {
      const payload = {
        latitude: 23.16,
        longitude: 72.67,
      };

      const res = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send(payload)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.heading).toBeNull();
      expect(res.body.data.speed).toBeNull();
    });

    it('should accept boundary coordinates at exact limits (lat 90/-90, lng 180/-180)', async () => {
      const resMax = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({
          latitude: 90.0,
          longitude: 180.0,
        })
        .expect(200);

      expect(resMax.body.success).toBe(true);
      expect(resMax.body.data.latitude).toBe(90.0);
      expect(resMax.body.data.longitude).toBe(180.0);

      const resMin = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({
          latitude: -90.0,
          longitude: -180.0,
        })
        .expect(200);

      expect(resMin.body.success).toBe(true);
      expect(resMin.body.data.latitude).toBe(-90.0);
      expect(resMin.body.data.longitude).toBe(-180.0);
    });

    it('should reject values just outside latitude limits (90.0001 and -90.0001) with 400 Bad Request', async () => {
      const resAbove = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({
          latitude: 90.0001,
          longitude: 72.667,
        })
        .expect(400);

      expect(resAbove.body.success).toBe(false);
      expect(resAbove.body.errorCode).toBe('VALIDATION_ERROR');

      const resBelow = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({
          latitude: -90.0001,
          longitude: 72.667,
        })
        .expect(400);

      expect(resBelow.body.success).toBe(false);
      expect(resBelow.body.errorCode).toBe('VALIDATION_ERROR');
    });

    it('should reject values just outside longitude limits (180.0001 and -180.0001) with 400 Bad Request', async () => {
      const resAbove = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({
          latitude: 23.15,
          longitude: 180.0001,
        })
        .expect(400);

      expect(resAbove.body.success).toBe(false);
      expect(resAbove.body.errorCode).toBe('VALIDATION_ERROR');

      const resBelow = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({
          latitude: 23.15,
          longitude: -180.0001,
        })
        .expect(400);

      expect(resBelow.body.success).toBe(false);
      expect(resBelow.body.errorCode).toBe('VALIDATION_ERROR');
    });

    it('should reject suspended driver with 403 Forbidden for both status and location', async () => {
      await prisma.driverProfile.update({
        where: { id: approvedDriverProfileId },
        data: { operationalStatus: 'SUSPENDED' },
      });

      const resStatus = await request(app.getHttpServer())
        .patch('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ isOnline: true })
        .expect(403);

      expect(resStatus.body.success).toBe(false);

      const resLoc = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${approvedDriverToken}`)
        .send({ latitude: 23.155, longitude: 72.667 })
        .expect(403);

      expect(resLoc.body.success).toBe(false);

      // Restore driver operational status
      await prisma.driverProfile.update({
        where: { id: approvedDriverProfileId },
        data: { operationalStatus: 'AVAILABLE' },
      });
    });

    it('should reject unapproved driver with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${pendingDriverToken}`)
        .send({
          latitude: 23.155,
          longitude: 72.667,
        })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should reject non-driver user with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          latitude: 23.155,
          longitude: 72.667,
        })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should reject unauthenticated request with 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .send({
          latitude: 23.155,
          longitude: 72.667,
        })
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('UNAUTHORIZED');
    });
  });
});
