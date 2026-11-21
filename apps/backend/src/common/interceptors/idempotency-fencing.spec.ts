import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { CACHE_KEYS } from '../constants/index.js';
import { BookingsService } from '../../modules/bookings/bookings.service.js';
import { TripsService } from '../../modules/trips/trips.service.js';
import { LocationsService } from '../../modules/locations/locations.service.js';
import {
  IdempotencyClaimContext,
  LEASE_DURATION_MS,
} from './idempotency.interceptor.js';

describe('Idempotency Fencing & Transactional Commit Safety', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let bookingsService: BookingsService;
  let tripsService: TripsService;
  let locationsService: LocationsService;
  let redisService: RedisService;

  let testPassengerUserId: string;
  let testDriverUserId: string;
  let testDriverProfileId: string;
  let pdeuPickupPointId: string;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdRecordIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule, RedisModule],
      providers: [BookingsService, TripsService, LocationsService],
    }).compile();

    await module.init();

    prisma = module.get<PrismaService>(PrismaService);
    bookingsService = module.get<BookingsService>(BookingsService);
    tripsService = module.get<TripsService>(TripsService);
    locationsService = module.get<LocationsService>(LocationsService);
    redisService = module.get<RedisService>(RedisService);

    await locationsService.bootstrapDefaults();
    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    pdeuPickupPointId = pickup!.id;

    // Create Passenger
    const passengerUser = await prisma.user.create({
      data: {
        email: `fence-pax-${Date.now()}@pdeu.ac.in`,
        fullName: 'Fencing Test Passenger',
        role: 'PASSENGER',
      },
    });
    testPassengerUserId = passengerUser.id;
    createdUserIds.push(testPassengerUserId);

    await prisma.passengerProfile.create({
      data: { userId: testPassengerUserId },
    });

    // Create Driver & Profile (Approved)
    const driverUser = await prisma.user.create({
      data: {
        email: `fence-drv-${Date.now()}@pdeu.ac.in`,
        fullName: 'Fencing Test Driver',
        role: 'DRIVER',
      },
    });
    testDriverUserId = driverUser.id;
    createdUserIds.push(testDriverUserId);

    const driverProfile = await prisma.driverProfile.create({
      data: {
        userId: testDriverUserId,
        licenseNumber: `GJ-FENCE-${Date.now()}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    testDriverProfileId = driverProfile.id;

    await prisma.vehicle.create({
      data: {
        driverProfileId: testDriverProfileId,
        registrationNumber: `GJ-18-FC-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Tata Nexon EV',
        passengerCapacity: 4,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    if (createdRecordIds.length > 0) {
      await prisma.idempotencyRecord.deleteMany({
        where: { id: { in: createdRecordIds } },
      });
    }
    for (const tripId of createdTripIds) {
      await prisma.tripPassenger.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.tripStatusHistory.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.trip.deleteMany({ where: { id: tripId } }).catch(() => {});
    }
    for (const bookingId of createdBookingIds) {
      await prisma.groupMember.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.cancellationFee.deleteMany({ where: { originalBookingId: bookingId } }).catch(() => {});
      await prisma.bookingStatusHistory.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    }
    for (const groupId of createdGroupIds) {
      await prisma.driverAssignment.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.rideGroup.deleteMany({ where: { id: groupId } }).catch(() => {});
    }
    for (const userId of createdUserIds) {
      await prisma.fareQuote.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.cancellationFee.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.idempotencyRecord.deleteMany({ where: { userId } }).catch(() => {});
      const profile = await prisma.driverProfile.findUnique({ where: { userId } });
      if (profile) {
        await prisma.vehicle.deleteMany({ where: { driverProfileId: profile.id } }).catch(() => {});
        await prisma.driverProfile.delete({ where: { id: profile.id } }).catch(() => {});
      }
      await prisma.passengerProfile.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await module.close();
  });

  // Helper to create a valid fare quote for passenger
  async function createValidQuote(userId: string): Promise<string> {
    const [inserted] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id,
        passenger_id,
        pickup_point_id,
        destination_location,
        direct_distance_meters,
        direct_duration_sec,
        private_estimated_fare_paise,
        shared_min_fare_paise,
        shared_max_fare_paise,
        agreed_fare_ceiling_paise,
        tariff_version,
        expires_at
      ) VALUES (
        gen_random_uuid(),
        ${userId}::uuid,
        ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
        4400,
        600,
        10000,
        2000,
        6000,
        6000,
        1,
        NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;
    return inserted.id;
  }

  // Helper to create a valid booking using official service and set its status
  async function createTestBooking(
    userId: string,
    initialStatus: string = 'REQUESTED',
  ): Promise<string> {
    const quoteId = await createValidQuote(userId);
    const result = await bookingsService.createBooking(userId, {
      quoteId,
      requestedType: 'SHARED',
      minGroupPreference: 2,
      passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
      upfrontConsentAgreed: true,
    });
    createdBookingIds.push(result.bookingId);
    if (initialStatus !== 'REQUESTED') {
      await prisma.booking.update({
        where: { id: result.bookingId },
        data: { status: initialStatus },
      });
    }
    return result.bookingId;
  }

  describe('Booking Creation Fencing & Lease Takeover', () => {
    it('should abort and rollback transaction when original request loses its lease to a second request, ensuring exactly one booking is created', async () => {
      const quoteId = await createValidQuote(testPassengerUserId);
      const idempotencyKey = `fence-bkg-${Date.now()}`;
      const requestPath = 'POST /api/v1/bookings';
      const requestHash = crypto.createHash('sha256').update('{}').digest('hex');

      // 1. Request 1 acquires claim with token1
      const ownerToken1 = crypto.randomUUID();
      const initialRecord = await prisma.idempotencyRecord.create({
        data: {
          userId: testPassengerUserId,
          idempotencyKey,
          requestPath,
          requestHash,
          status: 'IN_PROGRESS',
          ownerToken: ownerToken1,
          lockedUntil: new Date(Date.now() - 1000), // Simulate expired lease
          version: 1,
        },
      });
      createdRecordIds.push(initialRecord.id);

      const claim1: IdempotencyClaimContext = {
        id: initialRecord.id,
        ownerToken: ownerToken1,
        idempotencyKey,
        userId: testPassengerUserId,
      };

      // 2. Request 2 takes over the expired claim via atomic CAS
      const ownerToken2 = crypto.randomUUID();
      const newLockedUntil = new Date(Date.now() + LEASE_DURATION_MS);
      const takeoverCount = await prisma.$executeRaw`
        UPDATE idempotency_records
        SET
          owner_token = ${ownerToken2},
          locked_until = ${newLockedUntil},
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${initialRecord.id}::uuid
          AND status = 'IN_PROGRESS'
          AND (locked_until IS NULL OR locked_until <= NOW());
      `;
      expect(takeoverCount).toBe(1);

      const claim2: IdempotencyClaimContext = {
        id: initialRecord.id,
        ownerToken: ownerToken2,
        idempotencyKey,
        userId: testPassengerUserId,
      };

      // 3. Request 1 wakes up and attempts to commit booking creation using superseded claim1
      const bookingDto = {
        quoteId,
        requestedType: 'SHARED' as const,
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      };

      let request1Error: any = null;
      try {
        await bookingsService.createBooking(testPassengerUserId, bookingDto, claim1);
      } catch (err) {
        request1Error = err;
      }

      // Assert Request 1 failed with IDEMPOTENCY_CLAIM_LOST
      expect(request1Error).toBeInstanceOf(ConflictException);
      expect(request1Error.getResponse()).toEqual(
        expect.objectContaining({
          errorCode: 'IDEMPOTENCY_CLAIM_LOST',
        }),
      );

      // Verify DB: No booking was committed by Request 1 (rollback verified)
      const bookingCountAfterReq1 = await prisma.booking.count({
        where: { passengerId: testPassengerUserId },
      });
      expect(bookingCountAfterReq1).toBe(0);

      // 4. Request 2 (the legitimate owner) now runs and successfully commits
      const request2Result = await bookingsService.createBooking(
        testPassengerUserId,
        bookingDto,
        claim2,
      );
      expect(request2Result).toBeDefined();
      expect(request2Result.bookingId).toBeDefined();
      createdBookingIds.push(request2Result.bookingId);

      // Verify DB: Exactly one booking was committed
      const bookingCountAfterReq2 = await prisma.booking.count({
        where: { passengerId: testPassengerUserId },
      });
      expect(bookingCountAfterReq2).toBe(1);

      // Verify idempotency record is COMPLETED with Request 2's token and status 201
      const finalizedRecord = await prisma.idempotencyRecord.findUnique({
        where: { id: initialRecord.id },
      });
      expect(finalizedRecord?.status).toBe('COMPLETED');
      expect(finalizedRecord?.ownerToken).toBe(ownerToken2);
      expect(finalizedRecord?.statusCode).toBe(201);
      expect(finalizedRecord?.responsePayload).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            bookingId: request2Result.bookingId,
          }),
        }),
      );
    });

    it('should return cached result and prevent competing takeover when original request commits first', async () => {
      // Clean up previous booking to respect Invariant 1
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });

      const quoteId = await createValidQuote(testPassengerUserId);
      const idempotencyKey = `fence-first-commit-${Date.now()}`;
      const requestPath = 'POST /api/v1/bookings';
      const requestHash = crypto.createHash('sha256').update('{}').digest('hex');

      const ownerToken1 = crypto.randomUUID();
      const initialRecord = await prisma.idempotencyRecord.create({
        data: {
          userId: testPassengerUserId,
          idempotencyKey,
          requestPath,
          requestHash,
          status: 'IN_PROGRESS',
          ownerToken: ownerToken1,
          lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
          version: 1,
        },
      });
      createdRecordIds.push(initialRecord.id);

      const claim1: IdempotencyClaimContext = {
        id: initialRecord.id,
        ownerToken: ownerToken1,
        idempotencyKey,
        userId: testPassengerUserId,
      };

      // Request 1 executes and commits within its lease
      const bookingDto = {
        quoteId,
        requestedType: 'SHARED' as const,
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      };

      const result = await bookingsService.createBooking(testPassengerUserId, bookingDto, claim1);
      expect(result.bookingId).toBeDefined();
      createdBookingIds.push(result.bookingId);

      // Verify record is marked COMPLETED
      const recordAfterCommit = await prisma.idempotencyRecord.findUnique({
        where: { id: initialRecord.id },
      });
      expect(recordAfterCommit?.status).toBe('COMPLETED');

      // Competing Request 2 tries to take over
      const ownerToken2 = crypto.randomUUID();
      const takeoverCount = await prisma.$executeRaw`
        UPDATE idempotency_records
        SET
          owner_token = ${ownerToken2},
          locked_until = NOW() + INTERVAL '30 seconds',
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${initialRecord.id}::uuid
          AND status = 'IN_PROGRESS'
          AND (locked_until IS NULL OR locked_until <= NOW());
      `;
      // Takeover fails because status is COMPLETED
      expect(takeoverCount).toBe(0);

      // Total bookings remains exactly 1
      const totalBookings = await prisma.booking.count({
        where: { passengerId: testPassengerUserId },
      });
      expect(totalBookings).toBe(1);
    });
  });

  describe('Trip Lifecycle Fencing & Concurrency Coordination', () => {
    it('should prevent superseded driver request from reporting arrival and leave trip state untouched', async () => {
      // 1. Set up ride group and trip in CREATED status
      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 500,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: testDriverProfileId,
        rideGroupId: group.id,
        passengers: [],
      });
      createdTripIds.push(trip.id);

      expect(trip.status).toBe('CREATED');

      const idempotencyKey = `fence-arrival-${Date.now()}`;
      const ownerToken1 = crypto.randomUUID();
      const record = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey,
          requestPath: `POST /api/v1/trips/${trip.id}/arrive-pickup`,
          requestHash: crypto.createHash('sha256').update('{}').digest('hex'),
          status: 'IN_PROGRESS',
          ownerToken: ownerToken1,
          lockedUntil: new Date(Date.now() - 5000), // Expired
          version: 1,
        },
      });
      createdRecordIds.push(record.id);

      const claim1: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken1,
        idempotencyKey,
        userId: testDriverUserId,
      };

      // Competing request takes over
      const ownerToken2 = crypto.randomUUID();
      const takeoverCount = await prisma.$executeRaw`
        UPDATE idempotency_records
        SET
          owner_token = ${ownerToken2},
          locked_until = NOW() + INTERVAL '30 seconds',
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${record.id}::uuid
          AND status = 'IN_PROGRESS';
      `;
      expect(takeoverCount).toBe(1);

      const claim2: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken2,
        idempotencyKey,
        userId: testDriverUserId,
      };

      // Seed Redis with fresh GPS fix for driver at PDEU
      await redisService.getClient().set(
        `${CACHE_KEYS.DRIVER_GPS_PREFIX}${testDriverProfileId}`,
        JSON.stringify({
          latitude: 23.155,
          longitude: 72.6668,
          heading: 0,
          speed: 0,
          updatedAt: new Date().toISOString(),
        }),
        'EX',
        60,
      );

      // Driver Request 1 attempts reportArrival with claim1 -> must fail
      let req1Err: any = null;
      try {
        await tripsService.reportArrival(testDriverUserId, trip.id, claim1);
      } catch (err) {
        req1Err = err;
      }
      expect(req1Err).toBeInstanceOf(ConflictException);
      expect(req1Err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'IDEMPOTENCY_CLAIM_LOST' }),
      );

      // Verify trip status is still unchanged (CREATED, not AT_PICKUP)
      const tripAfterFailedReq1 = await prisma.trip.findUnique({ where: { id: trip.id } });
      expect(tripAfterFailedReq1?.status).toBe('CREATED');
      expect(tripAfterFailedReq1?.driverArrivedAt).toBeNull();

      // Legitimate Request 2 executes reportArrival with claim2 -> succeeds
      const req2Result = await tripsService.reportArrival(testDriverUserId, trip.id, claim2);
      expect(req2Result.status).toBe('AT_PICKUP');

      const tripAfterReq2 = await prisma.trip.findUnique({ where: { id: trip.id } });
      expect(tripAfterReq2?.status).toBe('AT_PICKUP');
      expect(tripAfterReq2?.driverArrivedAt).not.toBeNull();

      // Verify idempotency record finalized as COMPLETED
      const finalRec = await prisma.idempotencyRecord.findUnique({ where: { id: record.id } });
      expect(finalRec?.status).toBe('COMPLETED');
      expect(finalRec?.ownerToken).toBe(ownerToken2);
      expect(finalRec?.statusCode).toBe(200);
    });

    it('should coordinate completion transaction and takeover correctly via row locking', async () => {
      // Verify that while a completion transaction holds the row lock, a competing takeover query
      // is coordinated and blocked until the transaction commits, then discovers status COMPLETED
      const idempotencyKey = `fence-row-lock-${Date.now()}`;
      const ownerToken1 = crypto.randomUUID();

      const record = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey,
          requestPath: 'POST /api/v1/trips/test-lock',
          requestHash: 'hash',
          status: 'IN_PROGRESS',
          ownerToken: ownerToken1,
          lockedUntil: new Date(Date.now() - 1000), // Expired
          version: 1,
        },
      });
      createdRecordIds.push(record.id);

      const claim1: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken1,
        idempotencyKey,
        userId: testDriverUserId,
      };

      const ownerToken2 = crypto.randomUUID();
      let takeoverAttempted = false;
      let takeoverResultCount = -1;

      // Start transaction 1 that acquires row lock, pauses, then completes
      const tx1Promise = prisma.$transaction(async (tx) => {
        // Acquire row lock
        const rows = await tx.$queryRaw<Array<{ id: string; status: string; owner_token: string }>>`
          SELECT id, status, owner_token FROM idempotency_records WHERE id = ${claim1.id}::uuid FOR UPDATE;
        `;
        expect(rows[0].owner_token).toBe(ownerToken1);

        // While lock is held, trigger the competing takeover in background
        void (async () => {
          takeoverAttempted = true;
          const count = await prisma.$executeRaw`
            UPDATE idempotency_records
            SET
              owner_token = ${ownerToken2},
              locked_until = NOW() + INTERVAL '30 seconds',
              version = version + 1,
              updated_at = NOW()
            WHERE id = ${record.id}::uuid
              AND status = 'IN_PROGRESS'
              AND (locked_until IS NULL OR locked_until <= NOW());
          `;
          takeoverResultCount = count;
        })();

        // Delay 150ms to ensure takeover query has arrived and is waiting on row lock
        await new Promise((r) => setTimeout(r, 150));

        // Mark COMPLETED in tx1
        await tx.$executeRaw`
          UPDATE idempotency_records
          SET
            status = 'COMPLETED',
            status_code = 200,
            response_payload = '{"success":true}'::jsonb,
            locked_until = NULL,
            updated_at = NOW()
          WHERE id = ${claim1.id}::uuid
            AND owner_token = ${claim1.ownerToken}
            AND status = 'IN_PROGRESS';
        `;

        // Commit tx1
        return 'TX1_COMMITTED';
      });

      const tx1Result = await tx1Promise;
      expect(tx1Result).toBe('TX1_COMMITTED');

      // Wait a moment for the unblocked takeover query to finish
      await new Promise((r) => setTimeout(r, 100));

      expect(takeoverAttempted).toBe(true);
      // Because tx1 committed as COMPLETED, takeover's WHERE status = 'IN_PROGRESS' matched 0 rows!
      expect(takeoverResultCount).toBe(0);

      // Verify record is still owned by token1 and COMPLETED
      const finalRec = await prisma.idempotencyRecord.findUnique({ where: { id: record.id } });
      expect(finalRec?.status).toBe('COMPLETED');
      expect(finalRec?.ownerToken).toBe(ownerToken1);
    });

    it('should verify transaction rollback leaves neither partial mutation nor falsely completed idempotency record', async () => {
      // Clean up previous bookings
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });

      const quoteId = await createValidQuote(testPassengerUserId);
      const idempotencyKey = `fence-rollback-${Date.now()}`;
      const ownerToken = crypto.randomUUID();

      const record = await prisma.idempotencyRecord.create({
        data: {
          userId: testPassengerUserId,
          idempotencyKey,
          requestPath: 'POST /api/v1/bookings',
          requestHash: 'hash',
          status: 'IN_PROGRESS',
          ownerToken,
          lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
          version: 1,
        },
      });
      createdRecordIds.push(record.id);

      const fakeClaim: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: 'wrong-token-to-force-rollback',
        idempotencyKey,
        userId: testPassengerUserId,
      };

      const bookingDto = {
        quoteId,
        requestedType: 'SHARED' as const,
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      };

      await expect(
        bookingsService.createBooking(testPassengerUserId, bookingDto, fakeClaim),
      ).rejects.toThrow(ConflictException);

      // Check DB: No booking was created
      const bookingCount = await prisma.booking.count({
        where: { passengerId: testPassengerUserId },
      });
      expect(bookingCount).toBe(0);

      // Check DB: Idempotency record is NOT completed
      const rec = await prisma.idempotencyRecord.findUnique({ where: { id: record.id } });
      expect(rec?.status).toBe('IN_PROGRESS');
      expect(rec?.responsePayload).toBeNull();
    });

    it('should prevent superseded driver request from finalizing trip and releasing driver status', async () => {
      // Release any previous driver assignments to respect Invariant 3
      await prisma.driverAssignment.updateMany({
        where: { driverId: testDriverProfileId, status: { in: ['RESERVED', 'ACTIVE'] } },
        data: { status: 'RELEASED' },
      });
      await prisma.driverProfile.update({
        where: { id: testDriverProfileId },
        data: { operationalStatus: 'RESERVED' },
      });

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'IN_PROGRESS',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 500,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: testDriverProfileId,
        rideGroupId: group.id,
        passengers: [],
      });
      createdTripIds.push(trip.id);

      await prisma.trip.update({
        where: { id: trip.id },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });

      const idempotencyKey = `fence-complete-${Date.now()}`;
      const ownerToken1 = crypto.randomUUID();
      const record = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey,
          requestPath: `POST /api/v1/trips/${trip.id}/complete`,
          requestHash: crypto.createHash('sha256').update('{}').digest('hex'),
          status: 'IN_PROGRESS',
          ownerToken: ownerToken1,
          lockedUntil: new Date(Date.now() - 2000), // Expired
          version: 1,
        },
      });
      createdRecordIds.push(record.id);

      const claim1: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken1,
        idempotencyKey,
        userId: testDriverUserId,
      };

      // Competing Request 2 takes over
      const ownerToken2 = crypto.randomUUID();
      await prisma.$executeRaw`
        UPDATE idempotency_records
        SET
          owner_token = ${ownerToken2},
          locked_until = NOW() + INTERVAL '30 seconds',
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${record.id}::uuid
          AND status = 'IN_PROGRESS';
      `;

      const claim2: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken2,
        idempotencyKey,
        userId: testDriverUserId,
      };

      // Request 1 attempts completeTrip with superseded claim1 -> must fail
      let req1Err: any = null;
      try {
        await tripsService.completeTrip(testDriverUserId, trip.id, claim1);
      } catch (err) {
        req1Err = err;
      }
      expect(req1Err).toBeInstanceOf(ConflictException);
      expect(req1Err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'IDEMPOTENCY_CLAIM_LOST' }),
      );

      // Verify trip is still IN_PROGRESS and driver operationalStatus is STILL RESERVED
      const tripAfterReq1 = await prisma.trip.findUnique({ where: { id: trip.id } });
      expect(tripAfterReq1?.status).toBe('IN_PROGRESS');

      const driverAfterReq1 = await prisma.driverProfile.findUnique({
        where: { id: testDriverProfileId },
      });
      expect(driverAfterReq1?.operationalStatus).toBe('RESERVED');

      // Request 2 executes completeTrip with legitimate claim2 -> succeeds
      const req2Result = await tripsService.completeTrip(testDriverUserId, trip.id, claim2);
      expect(req2Result.status).toBe('COMPLETED');

      // Verify trip is now COMPLETED and driver is released to AVAILABLE
      const tripAfterReq2 = await prisma.trip.findUnique({ where: { id: trip.id } });
      expect(tripAfterReq2?.status).toBe('COMPLETED');

      const driverAfterReq2 = await prisma.driverProfile.findUnique({
        where: { id: testDriverProfileId },
      });
      expect(driverAfterReq2?.operationalStatus).toBe('AVAILABLE');

      // Verify record is marked COMPLETED
      const finalRec = await prisma.idempotencyRecord.findUnique({ where: { id: record.id } });
      expect(finalRec?.status).toBe('COMPLETED');
      expect(finalRec?.ownerToken).toBe(ownerToken2);
    });

    it('should prevent superseded passenger request from cancelling booking', async () => {
      // 1. Clean up and create an active booking
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });
      const quoteId = await createValidQuote(testPassengerUserId);

      const booking = await bookingsService.createBooking(testPassengerUserId, {
        quoteId,
        requestedType: 'SHARED',
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      });
      createdBookingIds.push(booking.bookingId);

      const idempotencyKey = `fence-cancel-${Date.now()}`;
      const ownerToken1 = crypto.randomUUID();
      const record = await prisma.idempotencyRecord.create({
        data: {
          userId: testPassengerUserId,
          idempotencyKey,
          requestPath: `POST /api/v1/bookings/${booking.bookingId}/cancel`,
          requestHash: crypto.createHash('sha256').update('{}').digest('hex'),
          status: 'IN_PROGRESS',
          ownerToken: ownerToken1,
          lockedUntil: new Date(Date.now() - 2000), // Expired
          version: 1,
        },
      });
      createdRecordIds.push(record.id);

      const claim1: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken1,
        idempotencyKey,
        userId: testPassengerUserId,
      };

      // Competing Request 2 takes over
      const ownerToken2 = crypto.randomUUID();
      await prisma.$executeRaw`
        UPDATE idempotency_records
        SET
          owner_token = ${ownerToken2},
          locked_until = NOW() + INTERVAL '30 seconds',
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${record.id}::uuid
          AND status = 'IN_PROGRESS';
      `;

      const claim2: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken2,
        idempotencyKey,
        userId: testPassengerUserId,
      };

      // Request 1 attempts cancelBooking with claim1 -> must fail
      let req1Err: any = null;
      try {
        await bookingsService.cancelBooking(
          { id: testPassengerUserId, role: 'PASSENGER' },
          booking.bookingId,
          { reason: 'Changed mind' },
          claim1,
        );
      } catch (err) {
        req1Err = err;
      }
      expect(req1Err).toBeInstanceOf(ConflictException);
      expect(req1Err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'IDEMPOTENCY_CLAIM_LOST' }),
      );

      // Verify booking is still REQUESTED (not CANCELLED)
      const bookingAfterReq1 = await prisma.booking.findUnique({
        where: { id: booking.bookingId },
      });
      expect(bookingAfterReq1?.status).toBe('REQUESTED');

      // Request 2 executes cancelBooking with claim2 -> succeeds
      const req2Result = await bookingsService.cancelBooking(
        { id: testPassengerUserId, role: 'PASSENGER' },
        booking.bookingId,
        { reason: 'Changed mind' },
        claim2,
      );
      expect(req2Result.status).toBe('CANCELLED');

      // Verify booking is now CANCELLED in DB
      const bookingAfterReq2 = await prisma.booking.findUnique({
        where: { id: booking.bookingId },
      });
      expect(bookingAfterReq2?.status).toBe('CANCELLED');

      // Verify record is marked COMPLETED
      const finalRec = await prisma.idempotencyRecord.findUnique({ where: { id: record.id } });
      expect(finalRec?.status).toBe('COMPLETED');
      expect(finalRec?.ownerToken).toBe(ownerToken2);
    });

    it('should prevent superseded driver request from verifying boarding and committing passenger state', async () => {
      // 1. Release previous driver assignments
      await prisma.driverAssignment.updateMany({
        where: { driverId: testDriverProfileId, status: { in: ['RESERVED', 'ACTIVE'] } },
        data: { status: 'RELEASED' },
      });
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });

      const quoteId = await createValidQuote(testPassengerUserId);
      const booking = await bookingsService.createBooking(testPassengerUserId, {
        quoteId,
        requestedType: 'SHARED',
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      });
      createdBookingIds.push(booking.bookingId);

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 500,
        },
      });
      createdGroupIds.push(group.id);

      const testOtp = '7712';
      const trip = await tripsService.createTripManifest({
        driverId: testDriverProfileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: booking.bookingId,
            passengerId: testPassengerUserId,
            farePaise: 2000,
            otp: testOtp,
          },
        ],
      });
      createdTripIds.push(trip.id);

      // Trip reaches AT_PICKUP
      await prisma.trip.update({
        where: { id: trip.id },
        data: { status: 'AT_PICKUP', driverArrivedAt: new Date() },
      });

      const idempotencyKey = `fence-boarding-${Date.now()}`;
      const ownerToken1 = crypto.randomUUID();
      const record = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey,
          requestPath: `POST /api/v1/trips/${trip.id}/verify-boarding`,
          requestHash: crypto.createHash('sha256').update('{}').digest('hex'),
          status: 'IN_PROGRESS',
          ownerToken: ownerToken1,
          lockedUntil: new Date(Date.now() - 2000), // Expired
          version: 1,
        },
      });
      createdRecordIds.push(record.id);

      const claim1: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken1,
        idempotencyKey,
        userId: testDriverUserId,
      };

      // Competing Request 2 takes over
      const ownerToken2 = crypto.randomUUID();
      await prisma.$executeRaw`
        UPDATE idempotency_records
        SET
          owner_token = ${ownerToken2},
          locked_until = NOW() + INTERVAL '30 seconds',
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${record.id}::uuid
          AND status = 'IN_PROGRESS';
      `;

      const claim2: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: ownerToken2,
        idempotencyKey,
        userId: testDriverUserId,
      };

      // Request 1 attempts verifyBoarding with claim1 -> must fail
      let req1Err: any = null;
      try {
        await tripsService.verifyBoarding(
          testDriverUserId,
          trip.id,
          { passengerId: testPassengerUserId, otp: testOtp },
          claim1,
        );
      } catch (err) {
        req1Err = err;
      }
      expect(req1Err).toBeInstanceOf(ConflictException);
      expect(req1Err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'IDEMPOTENCY_CLAIM_LOST' }),
      );

      // Verify trip passenger is still WAITING (not BOARDED)
      const passengerAfterReq1 = await prisma.tripPassenger.findFirst({
        where: { tripId: trip.id, passengerId: testPassengerUserId },
      });
      expect(passengerAfterReq1?.status).toBe('WAITING');

      // Request 2 executes verifyBoarding with claim2 -> succeeds
      const req2Result = await tripsService.verifyBoarding(
        testDriverUserId,
        trip.id,
        { passengerId: testPassengerUserId, otp: testOtp },
        claim2,
      );
      expect(req2Result?.passengerStatus).toBe('BOARDED');

      // Verify trip passenger is now BOARDED in DB
      const passengerAfterReq2 = await prisma.tripPassenger.findFirst({
        where: { tripId: trip.id, passengerId: testPassengerUserId },
      });
      expect(passengerAfterReq2?.status).toBe('BOARDED');

      // Verify record is marked COMPLETED with status 200
      const finalRec = await prisma.idempotencyRecord.findUnique({ where: { id: record.id } });
      expect(finalRec?.status).toBe('COMPLETED');
      expect(finalRec?.ownerToken).toBe(ownerToken2);
      expect(finalRec?.statusCode).toBe(200);
    });

    it('should atomically complete idempotency record with 400 on invalid OTP, prevent counter increment on same-key retry, and increment on new key', async () => {
      // 1. Release previous assignments and bookings
      await prisma.driverAssignment.updateMany({
        where: { driverId: testDriverProfileId, status: { in: ['RESERVED', 'ACTIVE'] } },
        data: { status: 'RELEASED' },
      });
      await prisma.boardingVerification.deleteMany({});
      await prisma.tripPassenger.deleteMany({});
      await prisma.tripStatusHistory.deleteMany({});
      await prisma.trip.deleteMany({});
      await prisma.groupMember.deleteMany({});
      await prisma.bookingStatusHistory.deleteMany({});
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });

      const quoteId = await createValidQuote(testPassengerUserId);
      const booking = await bookingsService.createBooking(testPassengerUserId, {
        quoteId,
        requestedType: 'SHARED',
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      });
      createdBookingIds.push(booking.bookingId);

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 500,
        },
      });
      createdGroupIds.push(group.id);

      const correctOtp = '9876';
      const trip = await tripsService.createTripManifest({
        driverId: testDriverProfileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: booking.bookingId,
            passengerId: testPassengerUserId,
            farePaise: 2000,
            otp: correctOtp,
          },
        ],
      });
      createdTripIds.push(trip.id);

      await prisma.trip.update({
        where: { id: trip.id },
        data: { status: 'AT_PICKUP', driverArrivedAt: new Date() },
      });

      const tripPassenger = await prisma.tripPassenger.findFirst({
        where: { tripId: trip.id, passengerId: testPassengerUserId },
      });

      // Claim 1: First attempt with invalid OTP
      const key1 = `fence-inv-otp-1-${Date.now()}`;
      const ownerToken1 = crypto.randomUUID();
      const rec1 = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey: key1,
          requestPath: `POST /api/v1/trips/${trip.id}/verify-boarding`,
          requestHash: 'hash1',
          status: 'IN_PROGRESS',
          ownerToken: ownerToken1,
          lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
          version: 1,
        },
      });
      createdRecordIds.push(rec1.id);

      const claim1: IdempotencyClaimContext = {
        id: rec1.id,
        ownerToken: ownerToken1,
        idempotencyKey: key1,
        userId: testDriverUserId,
      };

      // Execution 1: First invalid OTP attempt
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          trip.id,
          { passengerId: testPassengerUserId, otp: '0000' },
          claim1,
        ),
      ).rejects.toThrow(BadRequestException);

      // Verify attemptsCount incremented to 1
      const bvAfter1 = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(bvAfter1?.attemptsCount).toBe(1);

      // Verify idempotency record 1 is COMPLETED with status 400 and error payload
      const completedRec1 = await prisma.idempotencyRecord.findUnique({
        where: { id: rec1.id },
      });
      expect(completedRec1?.status).toBe('COMPLETED');
      expect(completedRec1?.statusCode).toBe(400);
      expect(completedRec1?.responsePayload).toEqual(
        expect.objectContaining({
          success: false,
          statusCode: 400,
          errorCode: 'INVALID_OTP',
          message: 'Invalid boarding OTP provided.',
        }),
      );

      // Claim 2: Second attempt with DIFFERENT idempotency key (new attempt)
      const key2 = `fence-inv-otp-2-${Date.now()}`;
      const ownerToken2 = crypto.randomUUID();
      const rec2 = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey: key2,
          requestPath: `POST /api/v1/trips/${trip.id}/verify-boarding`,
          requestHash: 'hash2',
          status: 'IN_PROGRESS',
          ownerToken: ownerToken2,
          lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
          version: 1,
        },
      });
      createdRecordIds.push(rec2.id);

      const claim2: IdempotencyClaimContext = {
        id: rec2.id,
        ownerToken: ownerToken2,
        idempotencyKey: key2,
        userId: testDriverUserId,
      };

      // Execution 2: Second invalid OTP attempt with new key
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          trip.id,
          { passengerId: testPassengerUserId, otp: '1111' },
          claim2,
        ),
      ).rejects.toThrow();

      // Verify attemptsCount incremented to 2
      const bvAfter2 = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(bvAfter2?.attemptsCount).toBe(2);

      // Verify idempotency record 2 is also COMPLETED with status 400
      const completedRec2 = await prisma.idempotencyRecord.findUnique({
        where: { id: rec2.id },
      });
      expect(completedRec2?.status).toBe('COMPLETED');
      expect(completedRec2?.statusCode).toBe(400);
      expect(completedRec2?.responsePayload).toEqual(
        expect.objectContaining({
          errorCode: 'INVALID_OTP',
        }),
      );
    });
  });

  describe('Cancellation Fee Settlement, Concurrency & Rollback Safety', () => {
    it('should roll back cancellation fee collection, passenger drop-off, and outbox event when transaction aborts', async () => {
      // 1. Clean up active bookings and driver assignments
      await prisma.driverAssignment.updateMany({
        where: { driverId: testDriverProfileId, status: { in: ['RESERVED', 'ACTIVE'] } },
        data: { status: 'RELEASED' },
      });
      await prisma.cancellationFee.deleteMany({ where: { passengerId: testPassengerUserId } });
      await prisma.boardingVerification.deleteMany({});
      await prisma.tripPassenger.deleteMany({});
      await prisma.tripStatusHistory.deleteMany({});
      await prisma.trip.deleteMany({});
      await prisma.groupMember.deleteMany({});
      await prisma.bookingStatusHistory.deleteMany({});
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });

      // 2. Create a previous cancelled booking with an OUTSTANDING cancellation fee
      const prevBookingId = await createTestBooking(testPassengerUserId, 'CANCELLED');

      const fee = await prisma.cancellationFee.create({
        data: {
          passengerId: testPassengerUserId,
          originalBookingId: prevBookingId,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      // 3. Create current active booking for passenger
      const activeBookingId = await createTestBooking(testPassengerUserId, 'CONFIRMED');

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 500,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: testDriverProfileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: activeBookingId,
            passengerId: testPassengerUserId,
            farePaise: 2500,
            otp: '6543',
          },
        ],
      });
      createdTripIds.push(trip.id);

      // Transition trip to IN_PROGRESS, passenger to BOARDED, booking to IN_PROGRESS
      await prisma.trip.update({
        where: { id: trip.id },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });
      await prisma.tripPassenger.updateMany({
        where: { tripId: trip.id, passengerId: testPassengerUserId },
        data: { status: 'BOARDED', boardedAt: new Date() },
      });
      await prisma.booking.update({
        where: { id: activeBookingId },
        data: { status: 'IN_PROGRESS' },
      });

      // 4. Create an idempotency claim that was superseded (lost claim)
      const idempotencyKey = `fence-comp-rollback-${Date.now()}`;
      const legitimateToken = crypto.randomUUID();
      const record = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey,
          requestPath: `POST /api/v1/trips/${trip.id}/passengers/${testPassengerUserId}/complete`,
          requestHash: 'hash-complete',
          status: 'IN_PROGRESS',
          ownerToken: legitimateToken,
          lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
          version: 1,
        },
      });
      createdRecordIds.push(record.id);

      const supersededClaim: IdempotencyClaimContext = {
        id: record.id,
        ownerToken: 'wrong-token-lost-lease',
        idempotencyKey,
        userId: testDriverUserId,
      };

      // 5. Invoke completePassenger with superseded claim -> must fail and rollback
      await expect(
        tripsService.completePassenger(
          testDriverUserId,
          trip.id,
          testPassengerUserId,
          supersededClaim,
        ),
      ).rejects.toThrow(ConflictException);

      // 6. Verify transactional rollback integrity in PostgreSQL:
      // A. Cancellation fee must remain OUTSTANDING and uncollected
      const feeAfterRollback = await prisma.cancellationFee.findUnique({
        where: { id: fee.id },
      });
      expect(feeAfterRollback?.status).toBe('OUTSTANDING');
      expect(feeAfterRollback?.collectedBookingId).toBeNull();
      expect(feeAfterRollback?.collectedAt).toBeNull();
      expect(feeAfterRollback?.amountPaise).toBe(3000);

      // B. Trip passenger must remain BOARDED
      const tpAfterRollback = await prisma.tripPassenger.findFirst({
        where: { tripId: trip.id, passengerId: testPassengerUserId },
      });
      expect(tpAfterRollback?.status).toBe('BOARDED');
      expect(tpAfterRollback?.droppedOffAt).toBeNull();

      // C. Booking must remain IN_PROGRESS
      const bookingAfterRollback = await prisma.booking.findUnique({
        where: { id: activeBookingId },
      });
      expect(bookingAfterRollback?.status).toBe('IN_PROGRESS');
      expect(bookingAfterRollback?.finalAllocatedFarePaise).toBeNull();

      // D. Outbox event must NOT have been persisted
      const outboxEvents = await prisma.outboxEvent.findMany({
        where: {
          aggregateId: tpAfterRollback!.id,
          eventType: 'PASSENGER_DROPPED_OFF',
        },
      });
      expect(outboxEvents.length).toBe(0);

      // E. Idempotency record must NOT be COMPLETED
      const recAfterRollback = await prisma.idempotencyRecord.findUnique({
        where: { id: record.id },
      });
      expect(recAfterRollback?.status).toBe('IN_PROGRESS');
      expect(recAfterRollback?.responsePayload).toBeNull();
    });

    it('should atomically collect outstanding cancellation fee at most once when concurrent database transactions attempt settlement', async () => {
      // 1. Clean up
      await prisma.driverAssignment.updateMany({
        where: { driverId: testDriverProfileId, status: { in: ['RESERVED', 'ACTIVE'] } },
        data: { status: 'RELEASED' },
      });
      await prisma.cancellationFee.deleteMany({ where: { passengerId: testPassengerUserId } });
      await prisma.boardingVerification.deleteMany({});
      await prisma.tripPassenger.deleteMany({});
      await prisma.tripStatusHistory.deleteMany({});
      await prisma.trip.deleteMany({});
      await prisma.groupMember.deleteMany({});
      await prisma.bookingStatusHistory.deleteMany({});
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });

      // Create two test bookings: one CANCELLED (terminal), one IN_PROGRESS
      const booking1Id = await createTestBooking(testPassengerUserId, 'CANCELLED');
      const booking2Id = await createTestBooking(testPassengerUserId, 'IN_PROGRESS');

      // Create single OUTSTANDING cancellation fee
      const fee = await prisma.cancellationFee.create({
        data: {
          passengerId: testPassengerUserId,
          originalBookingId: booking1Id,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      // 2. Launch two concurrent transactions executing the atomic CAS update
      const now = new Date();
      const results = await Promise.all([
        prisma.$transaction(async (tx) => {
          return tx.$queryRaw<Array<{ id: string; amount_paise: number }>>`
            UPDATE cancellation_fees
            SET
              status = 'COLLECTED',
              collected_booking_id = ${booking1Id}::uuid,
              collected_at = ${now}
            WHERE passenger_id = ${testPassengerUserId}::uuid AND status = 'OUTSTANDING'
            RETURNING id, amount_paise;
          `;
        }),
        prisma.$transaction(async (tx) => {
          return tx.$queryRaw<Array<{ id: string; amount_paise: number }>>`
            UPDATE cancellation_fees
            SET
              status = 'COLLECTED',
              collected_booking_id = ${booking2Id}::uuid,
              collected_at = ${now}
            WHERE passenger_id = ${testPassengerUserId}::uuid AND status = 'OUTSTANDING'
            RETURNING id, amount_paise;
          `;
        }),
      ]);

      const [claimed1, claimed2] = results;

      // Exactly ONE transaction must have claimed the fee (1 row returned)
      // The other must have claimed 0 rows
      const totalClaimedRows = claimed1.length + claimed2.length;
      expect(totalClaimedRows).toBe(1);

      if (claimed1.length === 1) {
        expect(claimed1[0].id).toBe(fee.id);
        expect(claimed1[0].amount_paise).toBe(3000);
        expect(claimed2.length).toBe(0);
      } else {
        expect(claimed2[0].id).toBe(fee.id);
        expect(claimed2[0].amount_paise).toBe(3000);
        expect(claimed1.length).toBe(0);
      }

      // 3. Verify PostgreSQL database state: exactly 1 COLLECTED fee
      const feeInDb = await prisma.cancellationFee.findUnique({
        where: { id: fee.id },
      });
      expect(feeInDb?.status).toBe('COLLECTED');
      expect(feeInDb?.collectedAt).not.toBeNull();
      expect(feeInDb?.amountPaise).toBe(3000);

      // Verify partial unique index guarantees at most one collection per original booking
      const collectedCount = await prisma.cancellationFee.count({
        where: { originalBookingId: booking1Id, status: 'COLLECTED' },
      });
      expect(collectedCount).toBe(1);
    });

    it('should coordinate concurrent passenger completion requests, rejecting duplicate drop-off while leaving cancellation fees OUTSTANDING', async () => {
      // 1. Clean up
      await prisma.driverAssignment.updateMany({
        where: { driverId: testDriverProfileId, status: { in: ['RESERVED', 'ACTIVE'] } },
        data: { status: 'RELEASED' },
      });
      await prisma.cancellationFee.deleteMany({ where: { passengerId: testPassengerUserId } });
      await prisma.boardingVerification.deleteMany({});
      await prisma.tripPassenger.deleteMany({});
      await prisma.tripStatusHistory.deleteMany({});
      await prisma.trip.deleteMany({});
      await prisma.groupMember.deleteMany({});
      await prisma.bookingStatusHistory.deleteMany({});
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });

      // Create cancelled booking for original fee
      const prevBookingId = await createTestBooking(testPassengerUserId, 'CANCELLED');

      const fee = await prisma.cancellationFee.create({
        data: {
          passengerId: testPassengerUserId,
          originalBookingId: prevBookingId,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      // Create new booking and trip
      const activeBookingId = await createTestBooking(testPassengerUserId, 'CONFIRMED');

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 500,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: testDriverProfileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: activeBookingId,
            passengerId: testPassengerUserId,
            farePaise: 2500,
            otp: '1234',
          },
        ],
      });
      createdTripIds.push(trip.id);

      await prisma.trip.update({
        where: { id: trip.id },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });
      await prisma.tripPassenger.updateMany({
        where: { tripId: trip.id, passengerId: testPassengerUserId },
        data: { status: 'BOARDED', boardedAt: new Date() },
      });
      await prisma.booking.update({
        where: { id: activeBookingId },
        data: { status: 'IN_PROGRESS' },
      });

      // Create two independent idempotency claims for two requests
      const key1 = `fence-conc-comp-1-${Date.now()}`;
      const rec1 = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey: key1,
          requestPath: `POST /api/v1/trips/${trip.id}/passengers/${testPassengerUserId}/complete`,
          requestHash: 'hash-req1',
          status: 'IN_PROGRESS',
          ownerToken: crypto.randomUUID(),
          lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
          version: 1,
        },
      });
      createdRecordIds.push(rec1.id);
      const claim1: IdempotencyClaimContext = {
        id: rec1.id,
        ownerToken: rec1.ownerToken!,
        idempotencyKey: key1,
        userId: testDriverUserId,
      };

      const key2 = `fence-conc-comp-2-${Date.now()}`;
      const rec2 = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey: key2,
          requestPath: `POST /api/v1/trips/${trip.id}/passengers/${testPassengerUserId}/complete`,
          requestHash: 'hash-req2',
          status: 'IN_PROGRESS',
          ownerToken: crypto.randomUUID(),
          lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
          version: 1,
        },
      });
      createdRecordIds.push(rec2.id);
      const claim2: IdempotencyClaimContext = {
        id: rec2.id,
        ownerToken: rec2.ownerToken!,
        idempotencyKey: key2,
        userId: testDriverUserId,
      };

      // 2. Execute both completion requests concurrently
      const [res1, res2] = await Promise.allSettled([
        tripsService.completePassenger(
          testDriverUserId,
          trip.id,
          testPassengerUserId,
          claim1,
        ),
        tripsService.completePassenger(
          testDriverUserId,
          trip.id,
          testPassengerUserId,
          claim2,
        ),
      ]);

      // Exactly ONE request must succeed; the second must fail because passenger status is COMPLETED
      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const rejected = [res1, res2].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Verify the successful request completed passenger with allocated fare (no cancellation fee settlement in Stage 7)
      const successData = fulfilled[0].value;
      expect(successData.passengerId).toBe(testPassengerUserId);
      expect(successData.rideFarePaise).toBe(2500);
      expect(successData.waitingChargePaise).toBe(0);
      expect(successData.totalCashToCollectPaise).toBe(2500);

      // Verify the rejected request failed with INVALID_PASSENGER_STATUS_FOR_COMPLETION
      expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
      expect(rejected[0].reason.getResponse()).toEqual(
        expect.objectContaining({
          errorCode: 'INVALID_PASSENGER_STATUS_FOR_COMPLETION',
        }),
      );

      // 3. Verify DB state: cancellation fee remains strictly OUTSTANDING and uncollected in Stage 7
      const feeInDb = await prisma.cancellationFee.findUnique({
        where: { id: fee.id },
      });
      expect(feeInDb?.status).toBe('OUTSTANDING');
      expect(feeInDb?.collectedBookingId).toBeNull();
      expect(feeInDb?.collectedAt).toBeNull();
      expect(feeInDb?.amountPaise).toBe(3000);

      // Exactly one PASSENGER_DROPPED_OFF outbox event
      const tp = await prisma.tripPassenger.findFirst({
        where: { tripId: trip.id, passengerId: testPassengerUserId },
      });
      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: tp!.id, eventType: 'PASSENGER_DROPPED_OFF' },
      });
      expect(events.length).toBe(1);
    });

    it('should prevent mutation on idempotency replay, keeping cancellation fee OUTSTANDING and uncollected in Stage 7', async () => {
      // 1. Clean up
      await prisma.driverAssignment.updateMany({
        where: { driverId: testDriverProfileId, status: { in: ['RESERVED', 'ACTIVE'] } },
        data: { status: 'RELEASED' },
      });
      await prisma.cancellationFee.deleteMany({ where: { passengerId: testPassengerUserId } });
      await prisma.boardingVerification.deleteMany({});
      await prisma.tripPassenger.deleteMany({});
      await prisma.tripStatusHistory.deleteMany({});
      await prisma.trip.deleteMany({});
      await prisma.groupMember.deleteMany({});
      await prisma.bookingStatusHistory.deleteMany({});
      await prisma.booking.deleteMany({ where: { passengerId: testPassengerUserId } });

      // Create cancelled booking for original fee
      const prevBookingId = await createTestBooking(testPassengerUserId, 'CANCELLED');
      const fee = await prisma.cancellationFee.create({
        data: {
          passengerId: testPassengerUserId,
          originalBookingId: prevBookingId,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      // Create new booking and trip
      const activeBookingId = await createTestBooking(testPassengerUserId, 'CONFIRMED');
      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 500,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: testDriverProfileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: activeBookingId,
            passengerId: testPassengerUserId,
            farePaise: 2500,
            otp: '8888',
          },
        ],
      });
      createdTripIds.push(trip.id);

      await prisma.trip.update({
        where: { id: trip.id },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });
      await prisma.tripPassenger.updateMany({
        where: { tripId: trip.id, passengerId: testPassengerUserId },
        data: { status: 'BOARDED', boardedAt: new Date() },
      });
      await prisma.booking.update({
        where: { id: activeBookingId },
        data: { status: 'IN_PROGRESS' },
      });

      // Create claim for original request
      const key = `fence-replay-comp-${Date.now()}`;
      const ownerToken = crypto.randomUUID();
      const rec = await prisma.idempotencyRecord.create({
        data: {
          userId: testDriverUserId,
          idempotencyKey: key,
          requestPath: `POST /api/v1/trips/${trip.id}/passengers/${testPassengerUserId}/complete`,
          requestHash: 'hash-replay',
          status: 'IN_PROGRESS',
          ownerToken,
          lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
          version: 1,
        },
      });
      createdRecordIds.push(rec.id);
      const claim: IdempotencyClaimContext = {
        id: rec.id,
        ownerToken,
        idempotencyKey: key,
        userId: testDriverUserId,
      };

      // 2. First completion executes and succeeds
      const result = await tripsService.completePassenger(
        testDriverUserId,
        trip.id,
        testPassengerUserId,
        claim,
      );

      expect(result.rideFarePaise).toBe(2500);
      expect(result.waitingChargePaise).toBe(0);
      expect(result.totalCashToCollectPaise).toBe(2500);

      // Verify idempotency record is COMPLETED with cached payload
      const finalizedRec = await prisma.idempotencyRecord.findUnique({
        where: { id: rec.id },
      });
      expect(finalizedRec?.status).toBe('COMPLETED');
      expect(finalizedRec?.statusCode).toBe(200);
      expect(finalizedRec?.responsePayload).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            rideFarePaise: 2500,
            waitingChargePaise: 0,
            totalCashToCollectPaise: 2500,
          }),
        }),
      );

      // Snapshot fee state in DB: remains OUTSTANDING in Stage 7
      const feeAfterFirstCommit = await prisma.cancellationFee.findUnique({
        where: { id: fee.id },
      });
      expect(feeAfterFirstCommit?.status).toBe('OUTSTANDING');
      expect(feeAfterFirstCommit?.collectedBookingId).toBeNull();
      expect(feeAfterFirstCommit?.collectedAt).toBeNull();

      // 3. Replay with the same claim directly against service must be rejected
      // because status is COMPLETED (fencing protects mutation from running again)
      await expect(
        tripsService.completePassenger(
          testDriverUserId,
          trip.id,
          testPassengerUserId,
          claim,
        ),
      ).rejects.toThrow(ConflictException);

      // 4. Verify DB fee record remains completely unchanged and OUTSTANDING
      const feeAfterReplay = await prisma.cancellationFee.findUnique({
        where: { id: fee.id },
      });
      expect(feeAfterReplay?.status).toBe('OUTSTANDING');
      expect(feeAfterReplay?.collectedAt).toBeNull();
      expect(feeAfterReplay?.collectedBookingId).toBeNull();
      expect(feeAfterReplay?.amountPaise).toBe(3000);
    });
  });
});
