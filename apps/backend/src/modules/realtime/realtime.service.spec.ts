import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeService } from './realtime.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';

describe('RealtimeService (Unit Tests)', () => {
  let service: RealtimeService;
  let prismaMock: any;
  let redisMock: any;
  let redisServiceMock: any;
  let serverMock: any;

  beforeEach(() => {
    prismaMock = {
      trip: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      tripPassenger: {
        findFirst: vi.fn(),
      },
      booking: {
        findFirst: vi.fn(),
      },
      groupMember: {
        findFirst: vi.fn(),
      },
      driverProfile: {
        findUnique: vi.fn(),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    redisMock = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };

    redisServiceMock = {
      getClient: vi.fn().mockReturnValue(redisMock),
    };

    serverMock = {
      to: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };

    service = new RealtimeService(prismaMock, redisServiceMock);
    service.setServer(serverMock);
  });

  describe('createEnvelope & emitToRoom', () => {
    it('creates standard realtime event envelope with UUID, version and timestamp', () => {
      const envelope = service.createEnvelope(
        'trip.status.updated',
        'TRIP',
        '11111111-1111-1111-1111-111111111111',
        2,
        '2026-11-22T10:00:00.000Z',
        { status: 'IN_PROGRESS' },
      );

      expect(envelope.eventId).toBeDefined();
      expect(envelope.event).toBe('trip.status.updated');
      expect(envelope.entityType).toBe('TRIP');
      expect(envelope.entityId).toBe('11111111-1111-1111-1111-111111111111');
      expect(envelope.entityVersion).toBe(2);
      expect(envelope.occurredAt).toBe('2026-11-22T10:00:00.000Z');
      expect(envelope.data).toEqual({ status: 'IN_PROGRESS' });
    });

    it('emits to target room when socket server is configured', () => {
      const envelope = service.createEnvelope('test.event', 'TEST', 'id-1', 1, new Date().toISOString(), {});
      service.emitToRoom('trip:trip-1', 'test.event', envelope);

      expect(serverMock.to).toHaveBeenCalledWith('trip:trip-1');
      expect(serverMock.emit).toHaveBeenCalledWith('test.event', envelope);
    });

    it('emits to user personal room', () => {
      const envelope = service.createEnvelope('test.user', 'USER', 'u-1', 1, new Date().toISOString(), {});
      service.emitToUser('user-1', 'test.user', envelope);

      expect(serverMock.to).toHaveBeenCalledWith('user:user-1');
      expect(serverMock.emit).toHaveBeenCalledWith('test.user', envelope);
    });
  });

  describe('Room Authorization Checks', () => {
    const userId = 'user-uuid-1';
    const tripId = 'trip-uuid-1';
    const bookingId = 'booking-uuid-1';
    const groupId = 'group-uuid-1';

    it('canJoinTrip: allows ADMIN role unconditionally', async () => {
      expect(await service.canJoinTrip(userId, tripId, 'ADMIN')).toBe(true);
      expect(prismaMock.trip.findFirst).not.toHaveBeenCalled();
    });

    it('canJoinTrip: allows operating driver', async () => {
      prismaMock.trip.findFirst.mockResolvedValueOnce({ id: tripId });
      expect(await service.canJoinTrip(userId, tripId, 'DRIVER')).toBe(true);
      expect(prismaMock.trip.findFirst).toHaveBeenCalledWith({
        where: { id: tripId, activeDriver: { userId } },
        select: { id: true },
      });
    });

    it('canJoinTrip: allows enrolled passenger with active status', async () => {
      prismaMock.trip.findFirst.mockResolvedValueOnce(null);
      prismaMock.tripPassenger.findFirst.mockResolvedValueOnce({ id: 'tp-1' });

      expect(await service.canJoinTrip(userId, tripId, 'PASSENGER')).toBe(true);
      expect(prismaMock.tripPassenger.findFirst).toHaveBeenCalledWith({
        where: {
          tripId,
          passengerId: userId,
          status: { in: ['WAITING', 'ASSIGNED', 'BOARDED', 'COMPLETED'] },
        },
        select: { id: true },
      });
    });

    it('canJoinTrip: rejects unauthorized stranger, cancelled passenger, or no-show', async () => {
      prismaMock.trip.findFirst.mockResolvedValueOnce(null);
      prismaMock.tripPassenger.findFirst.mockResolvedValueOnce(null);

      expect(await service.canJoinTrip(userId, tripId, 'PASSENGER')).toBe(false);
    });

    it('canJoinBooking: allows booking passenger and assigned trip driver, rejects stranger', async () => {
      // 1. Admin
      expect(await service.canJoinBooking(userId, bookingId, 'ADMIN')).toBe(true);

      // 2. Booking Passenger
      prismaMock.booking.findFirst.mockResolvedValueOnce({ id: bookingId });
      expect(await service.canJoinBooking(userId, bookingId, 'PASSENGER')).toBe(true);

      // 3. Assigned driver
      prismaMock.booking.findFirst.mockResolvedValueOnce(null);
      prismaMock.tripPassenger.findFirst.mockResolvedValueOnce({ id: 'tp-1' });
      expect(await service.canJoinBooking(userId, bookingId, 'DRIVER')).toBe(true);

      // 4. Stranger
      prismaMock.booking.findFirst.mockResolvedValueOnce(null);
      prismaMock.tripPassenger.findFirst.mockResolvedValueOnce(null);
      expect(await service.canJoinBooking(userId, bookingId, 'PASSENGER')).toBe(false);
    });

    it('canJoinGroup: allows active group member, rejects inactive member and stranger', async () => {
      expect(await service.canJoinGroup(userId, groupId, 'ADMIN')).toBe(true);

      prismaMock.groupMember.findFirst.mockResolvedValueOnce({ id: 'gm-1' });
      expect(await service.canJoinGroup(userId, groupId, 'PASSENGER')).toBe(true);
      expect(prismaMock.groupMember.findFirst).toHaveBeenCalledWith({
        where: {
          rideGroupId: groupId,
          booking: { passengerId: userId },
          isActiveMember: true,
        },
        select: { id: true },
      });

      prismaMock.groupMember.findFirst.mockResolvedValueOnce(null);
      expect(await service.canJoinGroup(userId, groupId, 'PASSENGER')).toBe(false);
    });
  });

  describe('Driver GPS Telemetry & Throttled Snapshots', () => {
    const userId = 'driver-user-1';
    const driverId = 'driver-profile-1';

    it('rejects if driver profile not found or not approved', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.ingestDriverLocation(userId, { latitude: 23.18, longitude: 72.63 }),
      ).rejects.toThrow('DRIVER_NOT_APPROVED');

      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: driverId,
        verificationStatus: 'PENDING',
      });
      await expect(
        service.ingestDriverLocation(userId, { latitude: 23.18, longitude: 72.63 }),
      ).rejects.toThrow('DRIVER_NOT_APPROVED');
    });

    it('rejects if driver operational status is SUSPENDED', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: driverId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'SUSPENDED',
      });
      await expect(
        service.ingestDriverLocation(userId, { latitude: 23.18, longitude: 72.63 }),
      ).rejects.toThrow('DRIVER_SUSPENDED');
    });

    it('rejects invalid coordinates outside valid geographic range', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: driverId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'ONLINE',
        isOnline: true,
      });

      await expect(
        service.ingestDriverLocation(userId, { latitude: 95.0, longitude: 72.63 }),
      ).rejects.toThrow('INVALID_COORDINATES');

      await expect(
        service.ingestDriverLocation(userId, { latitude: 23.18, longitude: 195.0 }),
      ).rejects.toThrow('INVALID_COORDINATES');

      await expect(
        service.ingestDriverLocation(userId, { latitude: NaN as any, longitude: 72.63 }),
      ).rejects.toThrow('INVALID_COORDINATES');
    });

    it('rejects invalid heading or invalid speed outside ranges', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: driverId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'ONLINE',
        isOnline: true,
      });

      await expect(
        service.ingestDriverLocation(userId, { latitude: 23.18, longitude: 72.63, heading: 400 }),
      ).rejects.toThrow('INVALID_HEADING');

      await expect(
        service.ingestDriverLocation(userId, { latitude: 23.18, longitude: 72.63, speed: -5 }),
      ).rejects.toThrow('INVALID_SPEED');
    });

    it('rejects offline driver reporting GPS when no active trip exists', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: driverId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'OFFLINE',
        isOnline: false,
      });
      prismaMock.trip.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.ingestDriverLocation(userId, { latitude: 23.18, longitude: 72.63 }),
      ).rejects.toThrow('DRIVER_OFFLINE');
    });

    it('persists valid GPS to Redis with 30s TTL when driver is online', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: driverId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'ONLINE',
        isOnline: true,
      });
      prismaMock.trip.findFirst.mockResolvedValueOnce(null);

      const result = await service.ingestDriverLocation(userId, {
        latitude: 23.185,
        longitude: 72.635,
        heading: 90,
        speed: 15,
      });

      expect(redisMock.set).toHaveBeenCalledWith(
        `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driverId}`,
        expect.stringContaining('"latitude":23.185'),
        'EX',
        30,
      );
      expect(result.broadcastData.driverId).toBe(driverId);
      expect(result.broadcastData.latitude).toBe(23.185);
      expect(result.broadcastData.heading).toBe(90);
    });

    it('persists durable PostGIS snapshot when driver is operating an active trip and atomic SET EX 15 NX succeeds', async () => {
      const activeTripId = 'trip-active-1';
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: driverId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'ONLINE',
        isOnline: true,
      });
      prismaMock.trip.findFirst.mockResolvedValueOnce({ id: activeTripId });
      // Atomic SET EX 15 NX succeeds
      redisMock.set.mockResolvedValueOnce('OK');

      const result = await service.ingestDriverLocation(userId, {
        latitude: 23.185,
        longitude: 72.635,
        tripId: activeTripId,
      });

      expect(result.activeTripId).toBe(activeTripId);
      expect(redisMock.set).toHaveBeenCalledWith(`throttle:trip_gps:${activeTripId}`, '1', 'EX', 15, 'NX');
      expect(prismaMock.$executeRaw).toHaveBeenCalled();
    });

    it('skips durable PostGIS snapshot when atomic SET EX 15 NX returns null (already throttled)', async () => {
      const activeTripId = 'trip-active-2';
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: driverId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'ONLINE',
        isOnline: true,
      });
      prismaMock.trip.findFirst.mockResolvedValueOnce({ id: activeTripId });
      // GPS key succeeds ('OK'), throttle key already held (returns null)
      redisMock.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

      const result = await service.ingestDriverLocation(userId, {
        latitude: 23.185,
        longitude: 72.635,
        tripId: activeTripId,
      });

      expect(result.activeTripId).toBe(activeTripId);
      expect(redisMock.set).toHaveBeenCalledWith(`throttle:trip_gps:${activeTripId}`, '1', 'EX', 15, 'NX');
      expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    });

    it('does not corrupt or fail GPS ingestion when Redis throws during snapshot throttling', async () => {
      const activeTripId = 'trip-active-3';
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: driverId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'ONLINE',
        isOnline: true,
      });
      prismaMock.trip.findFirst.mockResolvedValueOnce({ id: activeTripId });
      // First call is for driver GPS cache, second call is for throttle key
      redisMock.set
        .mockResolvedValueOnce('OK') // GPS key set
        .mockRejectedValueOnce(new Error('Redis connection timeout')); // Throttle key error

      const result = await service.ingestDriverLocation(userId, {
        latitude: 23.185,
        longitude: 72.635,
        tripId: activeTripId,
      });

      expect(result.broadcastData.driverId).toBe(driverId);
      expect(result.broadcastData.latitude).toBe(23.185);
    });
  });

  describe('checkStaleGps', () => {
    it('returns null if trip is not in IN_PROGRESS', async () => {
      prismaMock.trip.findUnique.mockResolvedValueOnce({ activeDriverId: 'd-1', status: 'CREATED' });
      expect(await service.checkStaleGps('trip-1')).toBeNull();
    });

    it('returns stale warning if GPS record is completely missing from Redis', async () => {
      prismaMock.trip.findUnique.mockResolvedValueOnce({ activeDriverId: 'd-1', status: 'IN_PROGRESS' });
      redisMock.get.mockResolvedValueOnce(null);

      const stale = await service.checkStaleGps('trip-1');
      expect(stale).not.toBeNull();
      expect(stale?.staleDurationSeconds).toBe(30);
      expect(stale?.warning).toContain('evicted from cache');
    });

    it('returns null if GPS fix is fresh (< 10s old)', async () => {
      prismaMock.trip.findUnique.mockResolvedValueOnce({ activeDriverId: 'd-1', status: 'IN_PROGRESS' });
      redisMock.get.mockResolvedValueOnce(
        JSON.stringify({ updatedAt: new Date(Date.now() - 3000).toISOString() }),
      );

      const stale = await service.checkStaleGps('trip-1');
      expect(stale).toBeNull();
    });

    it('returns stale warning if GPS fix is older than 10s', async () => {
      prismaMock.trip.findUnique.mockResolvedValueOnce({ activeDriverId: 'd-1', status: 'IN_PROGRESS' });
      redisMock.get.mockResolvedValueOnce(
        JSON.stringify({ updatedAt: new Date(Date.now() - 15000).toISOString() }),
      );

      const stale = await service.checkStaleGps('trip-1');
      expect(stale).not.toBeNull();
      expect(stale?.staleDurationSeconds).toBeGreaterThanOrEqual(14);
      expect(stale?.warning).toContain('stale');
    });
  });

  describe('broadcastOutboxEvent (Canonical Schema Translation)', () => {
    it('translates BOOKING_CREATED to canonical booking.created and broadcasts to passenger and booking rooms', async () => {
      const res = await service.broadcastOutboxEvent({
        id: 'outbox-1',
        eventType: 'BOOKING_CREATED',
        aggregateType: 'BOOKING',
        aggregateId: 'booking-1',
        payload: { passengerId: 'pass-1' },
      });

      expect(res).toBe(true);
      expect(serverMock.to).toHaveBeenCalledWith('passenger:pass-1');
      expect(serverMock.to).toHaveBeenCalledWith('booking:booking-1');
      expect(serverMock.emit).toHaveBeenCalledWith(
        'booking.created',
        expect.objectContaining({ event: 'booking.created', entityType: 'BOOKING' }),
      );
    });

    it('translates TRIP_DRIVER_ARRIVED to driver.arrived', async () => {
      const res = await service.broadcastOutboxEvent({
        id: 'outbox-2',
        eventType: 'TRIP_DRIVER_ARRIVED',
        aggregateType: 'TRIP',
        aggregateId: 'trip-1',
        payload: { tripId: 'trip-1', driverId: 'd-1' },
      });

      expect(res).toBe(true);
      expect(serverMock.to).toHaveBeenCalledWith('trip:trip-1');
      expect(serverMock.emit).toHaveBeenCalledWith('driver.arrived', expect.objectContaining({ event: 'driver.arrived' }));
    });

    it('translates TRIP_INTERRUPTED to trip.interrupted and broadcasts to trip and admin rooms', async () => {
      const res = await service.broadcastOutboxEvent({
        id: 'outbox-3',
        eventType: 'TRIP_INTERRUPTED',
        aggregateType: 'TRIP',
        aggregateId: 'trip-1',
        payload: { reason: 'PUNCTURE' },
      });

      expect(res).toBe(true);
      expect(serverMock.to).toHaveBeenCalledWith('trip:trip-1');
      expect(serverMock.to).toHaveBeenCalledWith('admin');
      expect(serverMock.emit).toHaveBeenCalledWith('trip.interrupted', expect.objectContaining({ event: 'trip.interrupted' }));
    });

    it('translates TRIP_CREATED to trip.created and broadcasts to trip, driver, and group rooms', async () => {
      const res = await service.broadcastOutboxEvent({
        id: 'outbox-tc-1',
        eventType: 'TRIP_CREATED',
        aggregateType: 'TRIP',
        aggregateId: 'trip-1',
        payload: { tripId: 'trip-1', activeDriverId: 'd-1', rideGroupId: 'group-1' },
      });

      expect(res).toBe(true);
      expect(serverMock.to).toHaveBeenCalledWith('trip:trip-1');
      expect(serverMock.to).toHaveBeenCalledWith('driver:d-1');
      expect(serverMock.to).toHaveBeenCalledWith('group:group-1');
      expect(serverMock.emit).toHaveBeenCalledWith('trip.created', expect.objectContaining({ event: 'trip.created' }));
    });

    it('translates DISPATCH_ATTEMPT_EXHAUSTED to group.updated and broadcasts to group and admin rooms', async () => {
      const res = await service.broadcastOutboxEvent({
        id: 'outbox-dae-1',
        eventType: 'DISPATCH_ATTEMPT_EXHAUSTED',
        aggregateType: 'DISPATCH_ATTEMPT',
        aggregateId: 'attempt-1',
        payload: { rideGroupId: 'group-1', groupVersion: 1 },
      });

      expect(res).toBe(true);
      expect(serverMock.to).toHaveBeenCalledWith('group:group-1');
      expect(serverMock.to).toHaveBeenCalledWith('admin');
      expect(serverMock.emit).toHaveBeenCalledWith('group.updated', expect.objectContaining({ event: 'group.updated' }));
    });

    it('returns false for unrecognized outbox event types', async () => {
      const res = await service.broadcastOutboxEvent({
        id: 'outbox-4',
        eventType: 'UNKNOWN_RANDOM_EVENT',
        aggregateType: 'FOO',
        aggregateId: 'foo-1',
        payload: {},
      });

      expect(res).toBe(false);
      expect(serverMock.emit).not.toHaveBeenCalled();
    });
  });
});
