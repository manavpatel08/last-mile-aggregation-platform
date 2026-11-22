import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncService } from './sync.service.js';

describe('SyncService (Unit Tests)', () => {
  let service: SyncService;
  let prismaMock: any;
  let redisMock: any;
  let redisServiceMock: any;

  beforeEach(() => {
    prismaMock = {
      booking: {
        findFirst: vi.fn(),
      },
      groupMember: {
        findFirst: vi.fn(),
      },
      tripPassenger: {
        findFirst: vi.fn(),
      },
      cancellationFee: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      driverProfile: {
        findUnique: vi.fn(),
      },
      driverDispatchOffer: {
        findFirst: vi.fn(),
      },
      trip: {
        findFirst: vi.fn(),
      },
      $queryRaw: vi.fn(),
    };

    redisMock = {
      get: vi.fn(),
    };

    redisServiceMock = {
      getClient: vi.fn().mockReturnValue(redisMock),
    };

    service = new SyncService(prismaMock, redisServiceMock);
  });

  describe('Passenger State Synchronization', () => {
    const passengerUserId = '11111111-1111-4111-a111-111111111111';
    const bookingId = '22222222-2222-4222-a222-222222222222';
    const groupId = '33333333-3333-4333-a333-333333333333';
    const tripId = '44444444-4444-4444-a444-444444444444';
    const driverId = '55555555-5555-4555-a555-555555555555';

    it('returns empty passenger state when user has no active bookings or fees', async () => {
      prismaMock.booking.findFirst.mockResolvedValueOnce(null);
      prismaMock.cancellationFee.findMany.mockResolvedValueOnce([]);

      const sync = await service.reconcileState(passengerUserId, 'PASSENGER', {});

      expect(sync.success).toBe(true);
      expect(sync.role).toBe('PASSENGER');
      expect(sync.reconciled).toBe(false);
      expect(sync.passengerState?.activeBooking).toBeNull();
      expect(sync.passengerState?.activeGroup).toBeNull();
      expect(sync.passengerState?.activeTrip).toBeNull();
      expect(sync.passengerState?.outstandingCancellationFees).toEqual([]);
    });

    it('returns full active journey state for passenger including active group, trip and latest driver GPS', async () => {
      const now = new Date();
      prismaMock.booking.findFirst.mockResolvedValueOnce({
        id: bookingId,
        status: 'IN_PROGRESS',
        passengerId: passengerUserId,
        pickupPointId: 'pickup-1',
        agreedFareCeilingPaise: 4000,
        createdAt: now,
        updatedAt: now,
      });

      prismaMock.groupMember.findFirst.mockResolvedValueOnce({
        rideGroup: {
          id: groupId,
          status: 'ASSIGNED',
          groupVersion: 2,
          pickupPointId: 'pickup-1',
          members: [{ id: 'm1' }, { id: 'm2' }],
        },
      });

      prismaMock.tripPassenger.findFirst.mockResolvedValueOnce({
        finalRideFarePaise: 3500,
        trip: {
          id: tripId,
          status: 'IN_PROGRESS',
          activeDriverId: driverId,
          currentStopOrder: 2,
          updatedAt: now,
          rideGroup: { groupVersion: 2 },
          activeDriver: {
            user: { fullName: 'Ramesh Patel' },
            vehicles: [{ registrationNumber: 'GJ-01-AB-1234' }],
          },
        },
      });

      // Latest GPS in Redis
      redisMock.get.mockResolvedValueOnce(
        JSON.stringify({
          latitude: 23.185,
          longitude: 72.635,
          updatedAt: now.toISOString(),
        }),
      );

      const sync = await service.reconcileState(passengerUserId, 'PASSENGER', {
        activeBookingId: bookingId,
        activeTripId: tripId,
        lastKnownEntityVersion: 2,
      });

      expect(sync.success).toBe(true);
      expect(sync.reconciled).toBe(false);
      expect(sync.passengerState?.activeBooking?.id).toBe(bookingId);
      expect(sync.passengerState?.activeBooking?.entityVersion).toBe(2);
      expect(sync.passengerState?.activeGroup?.id).toBe(groupId);
      expect(sync.passengerState?.activeGroup?.groupVersion).toBe(2);
      expect(sync.passengerState?.activeGroup?.memberCount).toBe(2);
      expect(sync.passengerState?.activeTrip?.id).toBe(tripId);
      expect(sync.passengerState?.activeTrip?.tripVersion).toBe(2);
      expect(sync.passengerState?.activeTrip?.driverName).toBe('Ramesh Patel');
      expect(sync.passengerState?.activeTrip?.vehicleNumber).toBe('GJ-01-AB-1234');
      expect(sync.passengerState?.activeTrip?.driverLocation?.latitude).toBe(23.185);
      expect(sync.passengerState?.activeTrip?.currentStopOrder).toBe(2);
      expect(sync.passengerState?.activeTrip?.farePaise).toBe(3500);
    });

    it('falls back to PostGIS snapshot if Redis GPS cache is empty', async () => {
      const now = new Date();
      prismaMock.booking.findFirst.mockResolvedValueOnce({
        id: bookingId,
        status: 'IN_PROGRESS',
        passengerId: passengerUserId,
        pickupPointId: 'pickup-1',
        agreedFareCeilingPaise: 4000,
        createdAt: now,
        updatedAt: now,
      });
      prismaMock.groupMember.findFirst.mockResolvedValueOnce(null);
      prismaMock.tripPassenger.findFirst.mockResolvedValueOnce({
        finalRideFarePaise: 3500,
        trip: {
          id: tripId,
          status: 'IN_PROGRESS',
          activeDriverId: driverId,
          updatedAt: now,
          activeDriver: { user: null, vehicles: [] },
        },
      });

      // Redis cache empty
      redisMock.get.mockResolvedValueOnce(null);
      // PostGIS fallback query
      prismaMock.$queryRaw.mockResolvedValueOnce([
        { latitude: 23.181, longitude: 72.631 },
      ]);

      const sync = await service.reconcileState(passengerUserId, 'PASSENGER', {});

      expect(sync.passengerState?.activeTrip?.driverLocation?.latitude).toBe(23.181);
      expect(sync.passengerState?.activeTrip?.driverLocation?.longitude).toBe(72.631);
    });

    it('detects state divergence and marks reconciled = true when version or entity ID differs', async () => {
      const now = new Date();
      prismaMock.booking.findFirst.mockResolvedValueOnce({
        id: bookingId,
        status: 'IN_PROGRESS',
        passengerId: passengerUserId,
        pickupPointId: 'pickup-1',
        agreedFareCeilingPaise: 4000,
        createdAt: now,
        updatedAt: now,
      });
      prismaMock.groupMember.findFirst.mockResolvedValueOnce(null);
      prismaMock.tripPassenger.findFirst.mockResolvedValueOnce(null);

      // Client thinks activeBookingId was a different ID
      const sync = await service.reconcileState(passengerUserId, 'PASSENGER', {
        activeBookingId: 'different-uuid',
      });

      expect(sync.reconciled).toBe(true);
    });
  });

  describe('Driver State Synchronization', () => {
    const driverUserId = 'driver-user-uuid';
    const driverProfileId = 'driver-prof-uuid';
    const groupId = 'group-uuid';
    const tripId = 'trip-uuid';

    it('returns active pending dispatch offer and active trip manifest with pickup OTPs', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce({
        id: driverProfileId,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      });

      const expiresAt = new Date(Date.now() + 15000);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValueOnce({
        id: 'offer-1',
        rideGroupId: groupId,
        groupVersion: 1,
        expiresAt,
        status: 'PENDING',
      });

      prismaMock.trip.findFirst.mockResolvedValueOnce({
        id: tripId,
        status: 'DRIVER_ARRIVED',
        rideGroupId: groupId,
        currentStopOrder: 1,
        rideGroup: { groupVersion: 1 },
        passengers: [
          {
            passengerId: 'p-1',
            bookingId: 'b-1',
            status: 'WAITING',
            pickupOtp: '1234',
          },
        ],
      });

      const sync = await service.reconcileState(driverUserId, 'DRIVER', {});

      expect(sync.success).toBe(true);
      expect(sync.driverState?.driverProfile.verificationStatus).toBe('APPROVED');
      expect(sync.driverState?.activeOffer?.id).toBe('offer-1');
      expect(sync.driverState?.activeOffer?.status).toBe('PENDING');
      expect(sync.driverState?.activeTrip?.id).toBe(tripId);
      expect(sync.driverState?.activeTrip?.tripVersion).toBe(1);
      expect(sync.driverState?.activeTrip?.currentStopOrder).toBe(1);
      expect(sync.driverState?.activeTrip?.passengerManifest[0].status).toBe('WAITING');
      expect(sync.driverState?.activeTrip?.passengerManifest[0].bookingId).toBe('b-1');
    });

    it('returns unverified default profile if driver profile does not exist', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValueOnce(null);

      const sync = await service.reconcileState('stranger-user', 'DRIVER', {});

      expect(sync.driverState?.driverProfile.verificationStatus).toBe('NOT_REGISTERED');
      expect(sync.driverState?.activeOffer).toBeNull();
      expect(sync.driverState?.activeTrip).toBeNull();
    });
  });
});
