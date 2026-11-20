import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { TripsService } from './trips.service.js';
import { LocationsService } from '../locations/locations.service.js';
import {
  IdempotencyClaimContext,
  LEASE_DURATION_MS,
} from '../../common/interceptors/idempotency.interceptor.js';

describe('Boarding OTP Verification Concurrency & Security Audit', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let bookingsService: BookingsService;
  let tripsService: TripsService;
  let locationsService: LocationsService;

  let testDriverUserId: string;
  let testDriverProfileId: string;
  let unauthorizedDriverUserId: string;
  let pdeuPickupPointId: string;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdRecordIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [BookingsService, TripsService, LocationsService],
    }).compile();

    await module.init();

    prisma = module.get<PrismaService>(PrismaService);
    bookingsService = module.get<BookingsService>(BookingsService);
    tripsService = module.get<TripsService>(TripsService);
    locationsService = module.get<LocationsService>(LocationsService);

    await locationsService.bootstrapDefaults();
    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    pdeuPickupPointId = pickup!.id;

    // 1. Create primary approved driver
    const driverUser = await prisma.user.create({
      data: {
        email: `otp-drv-${Date.now()}@pdeu.ac.in`,
        fullName: 'OTP Primary Driver',
        role: 'DRIVER',
      },
    });
    testDriverUserId = driverUser.id;
    createdUserIds.push(testDriverUserId);

    const driverProfile = await prisma.driverProfile.create({
      data: {
        userId: testDriverUserId,
        licenseNumber: `GJ-OTP-${Date.now()}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    testDriverProfileId = driverProfile.id;

    await prisma.vehicle.create({
      data: {
        driverProfileId: testDriverProfileId,
        registrationNumber: `GJ-18-OT-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Tata Nexon EV',
        passengerCapacity: 4,
        isActive: true,
      },
    });

    // 2. Create second driver (unauthorized for primary trip)
    const unauthorizedUser = await prisma.user.create({
      data: {
        email: `otp-unauth-drv-${Date.now()}@pdeu.ac.in`,
        fullName: 'OTP Unauthorized Driver',
        role: 'DRIVER',
      },
    });
    unauthorizedDriverUserId = unauthorizedUser.id;
    createdUserIds.push(unauthorizedDriverUserId);

    const unauthProfile = await prisma.driverProfile.create({
      data: {
        userId: unauthorizedDriverUserId,
        licenseNumber: `GJ-UNAUTH-${Date.now()}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });

    await prisma.vehicle.create({
      data: {
        driverProfileId: unauthProfile.id,
        registrationNumber: `GJ-18-UN-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Tata Tigor EV',
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
      await prisma.boardingVerification.deleteMany({}).catch(() => {});
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

  beforeEach(async () => {
    await prisma.driverAssignment.updateMany({
      where: { driverId: testDriverProfileId, status: { in: ['RESERVED', 'ACTIVE'] } },
      data: { status: 'RELEASED' },
    });
    await prisma.driverProfile.update({
      where: { id: testDriverProfileId },
      data: { operationalStatus: 'AVAILABLE' },
    });
  });

  // Helper to create passenger, active booking, ride group, and manifest at AT_PICKUP
  async function setupBoardingScenario(correctOtp: string) {
    const passengerUser = await prisma.user.create({
      data: {
        email: `otp-pax-${Date.now()}-${Math.floor(Math.random() * 10000)}@pdeu.ac.in`,
        fullName: 'OTP Commuter',
        role: 'PASSENGER',
      },
    });
    const passengerId = passengerUser.id;
    createdUserIds.push(passengerId);

    await prisma.passengerProfile.create({
      data: { userId: passengerId },
    });

    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise, shared_max_fare_paise,
        agreed_fare_ceiling_paise, tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${passengerId}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
        4400, 600, 10000, 2000, 6000, 6000, 1, NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;

    const booking = await bookingsService.createBooking(passengerId, {
      quoteId: quote.id,
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

    const trip = await tripsService.createTripManifest({
      driverId: testDriverProfileId,
      rideGroupId: group.id,
      passengers: [
        {
          bookingId: booking.bookingId,
          passengerId,
          farePaise: 2000,
          otp: correctOtp,
        },
      ],
    });
    createdTripIds.push(trip.id);

    // Transition trip to AT_PICKUP
    await prisma.trip.update({
      where: { id: trip.id },
      data: { status: 'AT_PICKUP', driverArrivedAt: new Date() },
    });

    const tripPassenger = await prisma.tripPassenger.findFirst({
      where: { tripId: trip.id, passengerId },
    });

    return {
      passengerId,
      bookingId: booking.bookingId,
      groupId: group.id,
      tripId: trip.id,
      tripPassengerId: tripPassenger!.id,
    };
  }

  // Helper to create an in-progress idempotency claim
  async function createClaim(
    userId: string,
    key: string,
    requestPath: string,
  ): Promise<IdempotencyClaimContext> {
    const ownerToken = crypto.randomUUID();
    const record = await prisma.idempotencyRecord.create({
      data: {
        userId,
        idempotencyKey: key,
        requestPath,
        requestHash: crypto.createHash('sha256').update(key).digest('hex'),
        status: 'IN_PROGRESS',
        ownerToken,
        lockedUntil: new Date(Date.now() + LEASE_DURATION_MS),
        version: 1,
      },
    });
    createdRecordIds.push(record.id);

    return {
      id: record.id,
      ownerToken,
      idempotencyKey: key,
      userId,
      requestUrl: requestPath,
    };
  }

  describe('OTP Verification Concurrency Invariants', () => {
    it('Scenario 1: 10 concurrent invalid OTP requests with 10 distinct keys produce exactly 3 increments, final count 3, and 7 rejections', async () => {
      const scenario = await setupBoardingScenario('7711');
      const requestPath = `POST /api/v1/trips/${scenario.tripId}/verify-boarding`;

      // Create 10 distinct claims with 10 distinct keys
      const claims: IdempotencyClaimContext[] = [];
      for (let i = 0; i < 10; i++) {
        const claim = await createClaim(
          testDriverUserId,
          `fence-conc-inv-${i}-${Date.now()}`,
          requestPath,
        );
        claims.push(claim);
      }

      // Execute all 10 invalid OTP submissions concurrently
      const promises = claims.map((claim) =>
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: '0000' },
          claim,
        ),
      );

      const settled = await Promise.allSettled(promises);

      // All 10 requests must fail with BadRequestException
      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(fulfilled.length).toBe(0);
      expect(rejected.length).toBe(10);

      const invalidOtpErrors = rejected.filter((r) => {
        const res = (r.reason as any)?.getResponse?.() || (r.reason as any);
        return res?.errorCode === 'INVALID_OTP';
      });

      const maxAttemptsErrors = rejected.filter((r) => {
        const res = (r.reason as any)?.getResponse?.() || (r.reason as any);
        return res?.errorCode === 'OTP_MAX_ATTEMPTS_EXCEEDED';
      });

      // Invariant: Exactly 3 failed attempts permitted
      expect(invalidOtpErrors.length).toBe(3);
      // Invariant: Remaining 7 requests rejected without incrementing
      expect(maxAttemptsErrors.length).toBe(7);

      // Verify PostgreSQL database state: attempts_count is strictly 3
      const bv = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: scenario.tripPassengerId },
      });
      expect(bv?.attemptsCount).toBe(3);
      expect(bv?.isVerified).toBe(false);

      // Trip passenger is still WAITING (never boarded)
      const tp = await prisma.tripPassenger.findUnique({
        where: { id: scenario.tripPassengerId },
      });
      expect(tp?.status).toBe('WAITING');

      // Zero PASSENGER_BOARDED outbox events
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: scenario.tripPassengerId, eventType: 'PASSENGER_BOARDED' },
      });
      expect(outbox.length).toBe(0);
    });

    it('Scenario 2: Replaying the same invalid OTP request with the same key returns cached error without incrementing counter', async () => {
      const scenario = await setupBoardingScenario('9922');
      const key = `fence-replay-inv-${Date.now()}`;
      const requestPath = `POST /api/v1/trips/${scenario.tripId}/verify-boarding`;

      const claim = await createClaim(testDriverUserId, key, requestPath);

      // 1. First execution with invalid OTP
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: '1111' },
          claim,
        ),
      ).rejects.toThrow(BadRequestException);

      // Verify attemptsCount incremented to 1
      const bv1 = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: scenario.tripPassengerId },
      });
      expect(bv1?.attemptsCount).toBe(1);

      // Verify idempotency record is COMPLETED with status 400
      const rec = await prisma.idempotencyRecord.findUnique({
        where: { id: claim.id },
      });
      expect(rec?.status).toBe('COMPLETED');
      expect(rec?.statusCode).toBe(400);

      // 2. Direct replay with same completed claim must be rejected by fencing
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: '1111' },
          claim,
        ),
      ).rejects.toThrow();

      // Verify counter was NOT incremented again
      const bv2 = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: scenario.tripPassengerId },
      });
      expect(bv2?.attemptsCount).toBe(1);
    });

    it('Scenario 3: Concurrent correct OTP submissions with distinct keys produce exactly one boarding transition and no duplicate events', async () => {
      const correctOtp = '4321';
      const scenario = await setupBoardingScenario(correctOtp);
      const requestPath = `POST /api/v1/trips/${scenario.tripId}/verify-boarding`;

      // 5 concurrent submissions of the correct OTP with 5 distinct keys
      const claims: IdempotencyClaimContext[] = [];
      for (let i = 0; i < 5; i++) {
        const claim = await createClaim(
          testDriverUserId,
          `fence-conc-valid-${i}-${Date.now()}`,
          requestPath,
        );
        claims.push(claim);
      }

      const promises = claims.map((claim) =>
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: correctOtp },
          claim,
        ),
      );

      const results = await Promise.allSettled(promises);

      // All 5 requests succeed (status 200, either initial or idempotent already-boarded)
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(5);

      // Invariant: Exactly 1 passenger boarding transition in PostgreSQL
      const tp = await prisma.tripPassenger.findUnique({
        where: { id: scenario.tripPassengerId },
      });
      expect(tp?.status).toBe('BOARDED');
      expect(tp?.boardedAt).not.toBeNull();

      const booking = await prisma.booking.findUnique({
        where: { id: scenario.bookingId },
      });
      expect(booking?.status).toBe('BOARDED');

      // Invariant: Exactly ONE booking_status_history row for BOARDED
      const history = await prisma.bookingStatusHistory.findMany({
        where: { bookingId: scenario.bookingId, newStatus: 'BOARDED' },
      });
      expect(history.length).toBe(1);

      // Invariant: Exactly ONE PASSENGER_BOARDED outbox event
      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: scenario.tripPassengerId, eventType: 'PASSENGER_BOARDED' },
      });
      expect(events.length).toBe(1);
    });

    it('Scenario 4: Concurrent valid and invalid OTP requests produce a consistent final state and bounded attempt count', async () => {
      const correctOtp = '6543';
      const scenario = await setupBoardingScenario(correctOtp);
      const requestPath = `POST /api/v1/trips/${scenario.tripId}/verify-boarding`;

      // 1 valid request and 4 invalid requests racing simultaneously
      const claimValid = await createClaim(
        testDriverUserId,
        `fence-race-val-${Date.now()}`,
        requestPath,
      );

      const claimsInvalid: IdempotencyClaimContext[] = [];
      for (let i = 0; i < 4; i++) {
        const c = await createClaim(
          testDriverUserId,
          `fence-race-inv-${i}-${Date.now()}`,
          requestPath,
        );
        claimsInvalid.push(c);
      }

      const allPromises = [
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: correctOtp },
          claimValid,
        ),
        ...claimsInvalid.map((c) =>
          tripsService.verifyBoarding(
            testDriverUserId,
            scenario.tripId,
            { passengerId: scenario.passengerId, otp: '0000' },
            c,
          ),
        ),
      ];

      await Promise.allSettled(allPromises);

      // Verify consistent final state:
      // Depending on whether 3 failures committed before the valid request or after:
      const tp = await prisma.tripPassenger.findUnique({
        where: { id: scenario.tripPassengerId },
      });
      const bv = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: scenario.tripPassengerId },
      });

      if (bv?.isVerified) {
        // Valid attempt won lock before 3 failures
        expect(tp?.status).toBe('BOARDED');
        expect(bv.attemptsCount).toBeLessThanOrEqual(3);
        const events = await prisma.outboxEvent.findMany({
          where: { aggregateId: scenario.tripPassengerId, eventType: 'PASSENGER_BOARDED' },
        });
        expect(events.length).toBe(1);
      } else {
        // 3 failed attempts won lock before valid request -> locked out
        expect(tp?.status).toBe('WAITING');
        expect(bv?.attemptsCount).toBe(3);
        const events = await prisma.outboxEvent.findMany({
          where: { aggregateId: scenario.tripPassengerId, eventType: 'PASSENGER_BOARDED' },
        });
        expect(events.length).toBe(0);
      }
    });

    it('Scenario 5: Once attempts_count reaches 3, neither valid nor invalid OTPs can increment counter or board passenger', async () => {
      const correctOtp = '3344';
      const scenario = await setupBoardingScenario(correctOtp);
      const requestPath = `POST /api/v1/trips/${scenario.tripId}/verify-boarding`;

      // Set attemptsCount to 3 in DB directly
      await prisma.boardingVerification.updateMany({
        where: { tripPassengerId: scenario.tripPassengerId },
        data: { attemptsCount: 3 },
      });

      // 1. Invalid attempt
      const claim1 = await createClaim(testDriverUserId, `fence-max-1-${Date.now()}`, requestPath);
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: '0000' },
          claim1,
        ),
      ).rejects.toThrow(BadRequestException);

      // 2. Valid attempt with correct OTP ('3344')
      const claim2 = await createClaim(testDriverUserId, `fence-max-2-${Date.now()}`, requestPath);
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: correctOtp },
          claim2,
        ),
      ).rejects.toThrow(BadRequestException);

      // Invariant: Counter is still strictly 3 (never 4 or 5)
      const bv = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: scenario.tripPassengerId },
      });
      expect(bv?.attemptsCount).toBe(3);
      expect(bv?.isVerified).toBe(false);

      // Invariant: Passenger remains WAITING
      const tp = await prisma.tripPassenger.findUnique({
        where: { id: scenario.tripPassengerId },
      });
      expect(tp?.status).toBe('WAITING');
    });

    it('Scenario 6: Unauthorized driver and invalid states cannot modify verification state', async () => {
      const scenario = await setupBoardingScenario('1122');
      const requestPath = `POST /api/v1/trips/${scenario.tripId}/verify-boarding`;

      // 6.1 Unauthorized driver attempts verification -> ForbiddenException
      const claimUnauth = await createClaim(
        unauthorizedDriverUserId,
        `fence-unauth-drv-${Date.now()}`,
        requestPath,
      );
      await expect(
        tripsService.verifyBoarding(
          unauthorizedDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: '1122' },
          claimUnauth,
        ),
      ).rejects.toThrow(ForbiddenException);

      // 6.2 Unrelated passenger ID -> NotFoundException
      const unrelatedUser = await prisma.user.create({
        data: {
          email: `otp-unrelated-${Date.now()}@pdeu.ac.in`,
          fullName: 'Unrelated Commuter',
          role: 'PASSENGER',
        },
      });
      createdUserIds.push(unrelatedUser.id);

      const claimUnrelatedPax = await createClaim(
        testDriverUserId,
        `fence-unrel-pax-${Date.now()}`,
        requestPath,
      );
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: unrelatedUser.id, otp: '1122' },
          claimUnrelatedPax,
        ),
      ).rejects.toThrow(NotFoundException);

      // 6.3 Trip not at pickup (e.g. IN_PROGRESS) -> BadRequestException
      await prisma.trip.update({
        where: { id: scenario.tripId },
        data: { status: 'IN_PROGRESS' },
      });

      const claimWrongTripStatus = await createClaim(
        testDriverUserId,
        `fence-wrong-trip-stat-${Date.now()}`,
        requestPath,
      );
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: '1122' },
          claimWrongTripStatus,
        ),
      ).rejects.toThrow(BadRequestException);

      // Reset trip to AT_PICKUP
      await prisma.trip.update({
        where: { id: scenario.tripId },
        data: { status: 'AT_PICKUP' },
      });

      // 6.4 Passenger declared NO_SHOW -> BadRequestException
      await prisma.tripPassenger.update({
        where: { id: scenario.tripPassengerId },
        data: { status: 'NO_SHOW' },
      });

      const claimNoShowPax = await createClaim(
        testDriverUserId,
        `fence-noshow-pax-${Date.now()}`,
        requestPath,
      );
      await expect(
        tripsService.verifyBoarding(
          testDriverUserId,
          scenario.tripId,
          { passengerId: scenario.passengerId, otp: '1122' },
          claimNoShowPax,
        ),
      ).rejects.toThrow(BadRequestException);

      // Verify verification state was never modified by any unauthorized or invalid attempt
      const bv = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: scenario.tripPassengerId },
      });
      expect(bv?.attemptsCount).toBe(0);
      expect(bv?.isVerified).toBe(false);
    });
  });
});
