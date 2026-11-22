import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeGateway } from './realtime.gateway.js';
import { CACHE_KEYS } from '../../common/constants/index.js';

describe('RealtimeGateway (Unit Tests)', () => {
  let gateway: RealtimeGateway;
  let prismaMock: any;
  let redisMock: any;
  let redisServiceMock: any;
  let sessionServiceMock: any;
  let realtimeServiceMock: any;
  let serverMock: any;

  beforeEach(() => {
    prismaMock = {
      user: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          return Promise.resolve({
            id: where.id,
            isActive: true,
            role: 'PASSENGER',
            roles: [{ roleName: 'PASSENGER' }],
          });
        }),
      },
      driverProfile: {
        findUnique: vi.fn(),
      },
    };

    redisMock = {
      getdel: vi.fn(),
    };

    redisServiceMock = {
      getClient: vi.fn().mockReturnValue(redisMock),
    };

    sessionServiceMock = {
      validateSession: vi.fn().mockResolvedValue(true),
    };

    realtimeServiceMock = {
      setServer: vi.fn(),
      canJoinTrip: vi.fn(),
      canJoinBooking: vi.fn(),
      canJoinGroup: vi.fn(),
      ingestDriverLocation: vi.fn(),
      createEnvelope: vi.fn((event, entityType, entityId, version, time, data) => ({
        eventId: 'env-1',
        event,
        entityType,
        entityId,
        entityVersion: version,
        occurredAt: time,
        data,
      })),
    };

    serverMock = {
      to: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };

    gateway = new RealtimeGateway(
      prismaMock,
      redisServiceMock,
      sessionServiceMock,
      realtimeServiceMock,
    );
    gateway.server = serverMock;
  });

  describe('Connection & Handshake Authentication', () => {
    const validTicketUuid = 'a0000000-0000-4000-8000-000000000001';

    it('rejects connection when ticket is missing', async () => {
      const socketMock: any = {
        id: 'sock-1',
        handshake: { auth: {}, query: {} },
        emit: vi.fn(),
        disconnect: vi.fn(),
      };

      await gateway.handleConnection(socketMock);

      expect(socketMock.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
        message: 'Valid socket ticket UUID required in handshake auth',
      });
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);
      expect(redisMock.getdel).not.toHaveBeenCalled();
    });

    it('rejects connection when ticket is not a valid UUID format', async () => {
      const socketMock: any = {
        id: 'sock-invalid-uuid',
        handshake: { auth: { ticket: 'not-a-valid-uuid-123' } },
        emit: vi.fn(),
        disconnect: vi.fn(),
      };

      await gateway.handleConnection(socketMock);

      expect(socketMock.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
        message: 'Valid socket ticket UUID required in handshake auth',
      });
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);
      expect(redisMock.getdel).not.toHaveBeenCalled();
    });

    it('rejects connection when ticket was already consumed, invalid, or expired', async () => {
      const socketMock: any = {
        id: 'sock-2',
        handshake: { auth: { ticket: validTicketUuid } },
        emit: vi.fn(),
        disconnect: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(null);

      await gateway.handleConnection(socketMock);

      expect(redisMock.getdel).toHaveBeenCalledWith(
        `${CACHE_KEYS.SOCKET_TICKET_PREFIX}${validTicketUuid}`,
      );
      expect(socketMock.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
        message: 'Invalid, expired, or already consumed socket ticket',
      });
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects connection when ticket userContext is incomplete', async () => {
      const socketMock: any = {
        id: 'sock-incomplete',
        handshake: { auth: { ticket: validTicketUuid } },
        emit: vi.fn(),
        disconnect: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(
        JSON.stringify({ userId: 'u-1' }), // Missing sessionId and role
      );

      await gateway.handleConnection(socketMock);

      expect(socketMock.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
        message: 'Incomplete ticket authentication context',
      });
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects connection if session is revoked in PostgreSQL', async () => {
      const socketMock: any = {
        id: 'sock-3',
        handshake: { auth: { ticket: validTicketUuid } },
        emit: vi.fn(),
        disconnect: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(
        JSON.stringify({
          userId: 'u-1',
          role: 'PASSENGER',
          sessionId: 'revoked-session-id',
        }),
      );
      sessionServiceMock.validateSession.mockResolvedValueOnce(false);

      await gateway.handleConnection(socketMock);

      expect(sessionServiceMock.validateSession).toHaveBeenCalledWith('revoked-session-id');
      expect(socketMock.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
        message: 'Session has been revoked or expired',
      });
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);
    });

    it('authenticates passenger, consumes ticket atomically, and auto-joins personal rooms', async () => {
      const ticket = 'a0000000-0000-4000-8000-000000000002';
      const socketMock: any = {
        id: 'sock-pass',
        handshake: { auth: { ticket } },
        emit: vi.fn(),
        disconnect: vi.fn(),
        join: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(
        JSON.stringify({
          userId: 'user-pass-1',
          role: 'PASSENGER',
          sessionId: 'active-session-id',
        }),
      );

      await gateway.handleConnection(socketMock);

      expect(redisMock.getdel).toHaveBeenCalledWith(
        `${CACHE_KEYS.SOCKET_TICKET_PREFIX}${ticket}`,
      );
      expect(socketMock.data.user.userId).toBe('user-pass-1');
      expect(socketMock.join).toHaveBeenCalledWith('user:user-pass-1');
      expect(socketMock.join).toHaveBeenCalledWith('passenger:user-pass-1');
      expect(socketMock.emit).toHaveBeenCalledWith('connected', {
        userId: 'user-pass-1',
        authenticated: true,
        rooms: expect.arrayContaining(['user:user-pass-1', 'passenger:user-pass-1']),
      });
    });

    it('authenticates approved driver and auto-joins driver room', async () => {
      const ticket = 'a0000000-0000-4000-8000-000000000003';
      const socketMock: any = {
        id: 'sock-driv',
        handshake: { auth: { ticket } },
        emit: vi.fn(),
        disconnect: vi.fn(),
        join: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(
        JSON.stringify({
          userId: 'user-driv-1',
          role: 'DRIVER',
          sessionId: 'active-session-id',
        }),
      );
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-driv-1',
        isActive: true,
        role: 'DRIVER',
        roles: [{ roleName: 'DRIVER' }],
      });
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: 'driver-profile-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
      });

      await gateway.handleConnection(socketMock);

      expect(socketMock.join).toHaveBeenCalledWith('user:user-driv-1');
      expect(socketMock.join).toHaveBeenCalledWith('driver:driver-profile-1');
      expect(socketMock.emit).toHaveBeenCalledWith('connected', {
        userId: 'user-driv-1',
        authenticated: true,
        rooms: expect.arrayContaining(['user:user-driv-1', 'driver:driver-profile-1']),
      });
    });

    it('authenticates admin and auto-joins admin room', async () => {
      const ticket = 'a0000000-0000-4000-8000-000000000004';
      const socketMock: any = {
        id: 'sock-admin',
        handshake: { auth: { ticket } },
        emit: vi.fn(),
        disconnect: vi.fn(),
        join: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(
        JSON.stringify({
          userId: 'user-admin-1',
          role: 'ADMIN',
          sessionId: 'active-session-id',
        }),
      );
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-admin-1',
        isActive: true,
        role: 'ADMIN',
        roles: [{ roleName: 'ADMIN' }],
      });

      await gateway.handleConnection(socketMock);

      expect(socketMock.join).toHaveBeenCalledWith('user:user-admin-1');
      expect(socketMock.join).toHaveBeenCalledWith('admin');
      expect(socketMock.emit).toHaveBeenCalledWith('connected', {
        userId: 'user-admin-1',
        authenticated: true,
        rooms: expect.arrayContaining(['user:user-admin-1', 'admin']),
      });
    });

    it('rejects connection if user does not exist in PostgreSQL', async () => {
      const ticket = 'a0000000-0000-4000-8000-000000000005';
      const socketMock: any = {
        id: 'sock-missing-user',
        handshake: { auth: { ticket } },
        emit: vi.fn(),
        disconnect: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(
        JSON.stringify({
          userId: 'user-missing',
          role: 'PASSENGER',
          sessionId: 'active-session-id',
        }),
      );
      prismaMock.user.findUnique.mockResolvedValueOnce(null);

      await gateway.handleConnection(socketMock);

      expect(socketMock.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
        message: 'User account not found',
      });
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects connection if user account is deactivated / inactive in PostgreSQL', async () => {
      const ticket = 'a0000000-0000-4000-8000-000000000006';
      const socketMock: any = {
        id: 'sock-inactive-user',
        handshake: { auth: { ticket } },
        emit: vi.fn(),
        disconnect: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(
        JSON.stringify({
          userId: 'user-inactive',
          role: 'PASSENGER',
          sessionId: 'active-session-id',
        }),
      );
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-inactive',
        isActive: false,
        role: 'PASSENGER',
        roles: [{ roleName: 'PASSENGER' }],
      });

      await gateway.handleConnection(socketMock);

      expect(socketMock.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
        message: 'User account is deactivated or suspended',
      });
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects connection if ticket role does not match authoritative database account roles', async () => {
      const ticket = 'a0000000-0000-4000-8000-000000000007';
      const socketMock: any = {
        id: 'sock-role-mismatch',
        handshake: { auth: { ticket } },
        emit: vi.fn(),
        disconnect: vi.fn(),
      };
      redisMock.getdel.mockResolvedValueOnce(
        JSON.stringify({
          userId: 'user-mismatch',
          role: 'DRIVER', // Ticket claims driver
          sessionId: 'active-session-id',
        }),
      );
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-mismatch',
        isActive: true,
        role: 'PASSENGER', // Database only has passenger
        roles: [{ roleName: 'PASSENGER' }],
      });

      await gateway.handleConnection(socketMock);

      expect(socketMock.emit).toHaveBeenCalledWith('error', {
        code: 'UNAUTHORIZED',
        message: 'User role mismatch with authoritative database account',
      });
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('Room Subscriptions & Authorization Enforcement', () => {
    const validUuid = '11111111-1111-4111-a111-111111111111';

    it('subscribe:trip joins room when authorized by RealtimeService', async () => {
      const socketMock: any = {
        id: 'sock-1',
        data: {
          user: { userId: 'u-1', role: 'PASSENGER' },
          joinedRooms: new Set<string>(),
        },
        join: vi.fn(),
      };
      realtimeServiceMock.canJoinTrip.mockResolvedValueOnce(true);

      const ack = await gateway.handleSubscribeTrip(socketMock, { tripId: validUuid });

      expect(ack).toEqual({ success: true, room: `trip:${validUuid}` });
      expect(socketMock.join).toHaveBeenCalledWith(`trip:${validUuid}`);
    });

    it('subscribe:trip returns FORBIDDEN when user is unauthorized', async () => {
      const socketMock: any = {
        id: 'sock-1',
        data: {
          user: { userId: 'u-stranger', role: 'PASSENGER' },
          joinedRooms: new Set<string>(),
        },
        join: vi.fn(),
      };
      realtimeServiceMock.canJoinTrip.mockResolvedValueOnce(false);

      const ack = await gateway.handleSubscribeTrip(socketMock, { tripId: validUuid });

      expect(ack).toEqual({
        success: false,
        error: 'FORBIDDEN',
        message: 'Not authorized for trip room',
      });
      expect(socketMock.join).not.toHaveBeenCalled();
    });

    it('subscribe:booking validates authorization before joining', async () => {
      const socketMock: any = {
        id: 'sock-1',
        data: {
          user: { userId: 'u-1', role: 'PASSENGER' },
          joinedRooms: new Set<string>(),
        },
        join: vi.fn(),
      };
      realtimeServiceMock.canJoinBooking.mockResolvedValueOnce(true);

      const ack = await gateway.handleSubscribeBooking(socketMock, { bookingId: validUuid });

      expect(ack).toEqual({ success: true, room: `booking:${validUuid}` });
      expect(socketMock.join).toHaveBeenCalledWith(`booking:${validUuid}`);
    });

    it('subscribe:group validates authorization before joining', async () => {
      const socketMock: any = {
        id: 'sock-1',
        data: {
          user: { userId: 'u-1', role: 'PASSENGER' },
          joinedRooms: new Set<string>(),
        },
        join: vi.fn(),
      };
      realtimeServiceMock.canJoinGroup.mockResolvedValueOnce(true);

      const ack = await gateway.handleSubscribeGroup(socketMock, { groupId: validUuid });

      expect(ack).toEqual({ success: true, room: `group:${validUuid}` });
      expect(socketMock.join).toHaveBeenCalledWith(`group:${validUuid}`);
    });
  });

  describe('Driver GPS Telemetry Stream', () => {
    it('rejects GPS update from non-driver user', async () => {
      const socketMock: any = {
        data: { user: { userId: 'u-pass', role: 'PASSENGER' } },
      };

      const ack = await gateway.handleDriverLocationUpdate(socketMock, {
        latitude: 23.18,
        longitude: 72.63,
      });

      expect(ack).toEqual({ success: false, error: 'FORBIDDEN' });
      expect(realtimeServiceMock.ingestDriverLocation).not.toHaveBeenCalled();
    });

    it('rejects GPS update from unapproved driver', async () => {
      const socketMock: any = {
        data: {
          user: {
            userId: 'u-driv',
            role: 'DRIVER',
            driverVerificationStatus: 'PENDING',
          },
        },
      };

      const ack = await gateway.handleDriverLocationUpdate(socketMock, {
        latitude: 23.18,
        longitude: 72.63,
      });

      expect(ack).toEqual({ success: false, error: 'FORBIDDEN' });
      expect(realtimeServiceMock.ingestDriverLocation).not.toHaveBeenCalled();
    });

    it('ingests valid driver GPS, emits to trip room & admin room, returns success ack', async () => {
      const socketMock: any = {
        data: {
          user: {
            userId: 'u-driv',
            role: 'DRIVER',
            driverVerificationStatus: 'APPROVED',
          },
        },
      };
      realtimeServiceMock.ingestDriverLocation.mockResolvedValueOnce({
        broadcastData: {
          driverId: 'd-1',
          tripId: 'trip-active-1',
          latitude: 23.18,
          longitude: 72.63,
          heading: 180,
          speed: 25,
          updatedAt: '2026-11-22T12:00:00.000Z',
        },
        activeTripId: 'trip-active-1',
      });

      const ack = await gateway.handleDriverLocationUpdate(socketMock, {
        latitude: 23.18,
        longitude: 72.63,
        heading: 180,
        speed: 25,
      });

      expect(ack).toEqual({ success: true, updatedAt: '2026-11-22T12:00:00.000Z' });
      expect(serverMock.to).toHaveBeenCalledWith('trip:trip-active-1');
      expect(serverMock.to).toHaveBeenCalledWith('admin');
      expect(serverMock.emit).toHaveBeenCalledWith(
        'driver.location.updated',
        expect.objectContaining({ event: 'driver.location.updated' }),
      );
    });
  });
});
