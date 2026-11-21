import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { TripsService } from './trips.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';

describe('Driver Arrival & Boarding Verification Hardening (Stage 7 - Phase 2)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redisService: RedisService;
  let bookingsService: BookingsService;
  let tripsService: TripsService;
  let locationsService: LocationsService;

  let assignedDriverUserId: string;
  let assignedDriverProfileId: string;
  let unauthorizedDriverUserId: string;
  let unapprovedDriverUserId: string;

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
    redisService = module.get<RedisService>(RedisService);
    bookingsService = module.get<BookingsService>(BookingsService);
    tripsService = module.get<TripsService>(TripsService);
    locationsService = module.get<LocationsService>(LocationsService);

    await locationsService.bootstrapDefaults();
    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    pdeuPickupPointId = pickup!.id;

    // 1. Create primary approved driver
    const dUser = await prisma.user.create({
      data: {
        email: `harden-drv-${Date.now()}@pdeu.ac.in`,
        fullName: 'Harden Assigned Driver',
        role: 'DRIVER',
      },
    });
    assignedDriverUserId = dUser.id;
    createdUserIds.push(assignedDriverUserId);

    const dProfile = await prisma.driverProfile.create({
      data: {
        userId: assignedDriverUserId,
        licenseNumber: `GJ-HRD-${Date.now()}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    assignedDriverProfileId = dProfile.id;

    await prisma.vehicle.create({
      data: {
        driverProfileId: assignedDriverProfileId,
        registrationNumber: `GJ-01-HD-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Mahindra Treo Electric',
        passengerCapacity: 4,
        isActive: true,
      },
    });

    // 2. Create another approved driver (unassigned)
    const unauthDUser = await prisma.user.create({
      data: {
        email: `harden-unauth-${Date.now()}@pdeu.ac.in`,
        fullName: 'Harden Unassigned Driver',
        role: 'DRIVER',
      },
    });
    unauthorizedDriverUserId = unauthDUser.id;
    createdUserIds.push(unauthorizedDriverUserId);

    const unauthDProfile = await prisma.driverProfile.create({
      data: {
        userId: unauthorizedDriverUserId,
        licenseNumber: `GJ-UNHRD-${Date.now()}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });

    await prisma.vehicle.create({
      data: {
        driverProfileId: unauthDProfile.id,
        registrationNumber: `GJ-01-UH-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Mahindra Treo Electric',
        passengerCapacity: 4,
        isActive: true,
      },
    });

    // 3. Create unapproved driver
    const unapprDUser = await prisma.user.create({
      data: {
        email: `harden-unappr-${Date.now()}@pdeu.ac.in`,
        fullName: 'Harden Unapproved Driver',
        role: 'DRIVER',
      },
    });
    unapprovedDriverUserId = unapprDUser.id;
    createdUserIds.push(unapprovedDriverUserId);

    await prisma.driverProfile.create({
      data: {
        userId: unapprovedDriverUserId,
        licenseNumber: `GJ-PEND-${Date.now()}`,
        verificationStatus: 'PENDING',
        operationalStatus: 'OFFLINE',
        isOnline: false,
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
      await prisma.cashCollection.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: tripId } }).catch(() => {});
      const tps = await prisma.tripPassenger.findMany({ where: { tripId } }).catch(() => []);
      for (const tp of tps) {
        await prisma.boardingVerification.deleteMany({ where: { tripPassengerId: tp.id } }).catch(() => {});
        await prisma.outboxEvent.deleteMany({ where: { aggregateId: tp.id } }).catch(() => {});
      }
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
      const versions = await prisma.groupRouteVersion.findMany({ where: { rideGroupId: groupId } }).catch(() => []);
      for (const v of versions) {
        await prisma.groupRouteStop.deleteMany({ where: { groupRouteVersionId: v.id } }).catch(() => {});
      }
      await prisma.groupRouteVersion.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.groupMember.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.driverAssignment.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.dispatchAttempt.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
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

  // Helper to seed Redis with driver GPS telemetry
  async function seedDriverGps(
    profileId: string = assignedDriverProfileId,
    lat: number = 23.155,
    lng: number = 72.6668,
    ageMs: number = 0,
  ) {
    const client = redisService.getClient();
    const updatedAt = new Date(Date.now() - ageMs).toISOString();
    await client.set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${profileId}`,
      JSON.stringify({
        latitude: lat,
        longitude: lng,
        heading: 90,
        speed: 0,
        updatedAt,
      }),
      'EX',
      60,
    );
  }

  beforeEach(async () => {
    await prisma.driverAssignment.updateMany({
      where: {
        driverId: assignedDriverProfileId,
        status: { in: ['RESERVED', 'ACTIVE'] },
      },
      data: { status: 'RELEASED' },
    });
    await prisma.driverProfile.update({
      where: { id: assignedDriverProfileId },
      data: { operationalStatus: 'AVAILABLE' },
    });
    await seedDriverGps();
  });

  // Helper to create a passenger and booking
  async function createTestPassengerAndBooking() {
    const pUser = await prisma.user.create({
      data: {
        email: `pax-hrd-${Date.now()}-${Math.floor(Math.random() * 10000)}@pdeu.ac.in`,
        fullName: 'Harden Commuter',
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(pUser.id);
    await prisma.passengerProfile.create({ data: { userId: pUser.id } });

    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise, shared_max_fare_paise,
        agreed_fare_ceiling_paise, tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${pUser.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
        4400, 600, 10000, 2000, 6000, 6000, 1, NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;

    const booking = await bookingsService.createBooking(pUser.id, {
      quoteId: quote.id,
      requestedType: 'SHARED',
      minGroupPreference: 2,
      passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
      upfrontConsentAgreed: true,
    });
    createdBookingIds.push(booking.bookingId);

    return { passengerId: pUser.id, bookingId: booking.bookingId };
  }

  // Helper to setup a trip with passenger(s) in CREATED status
  async function createTripInCreatedStatus(
    passengers: Array<{ bookingId: string; passengerId: string; otp: string }>,
  ) {
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
      driverId: assignedDriverProfileId,
      rideGroupId: group.id,
      passengers: passengers.map((p) => ({
        bookingId: p.bookingId,
        passengerId: p.passengerId,
        farePaise: 2000,
        otp: p.otp,
      })),
    });
    createdTripIds.push(trip.id);

    // Set bookings to DRIVER_ASSIGNED
    for (const p of passengers) {
      await prisma.booking.update({
        where: { id: p.bookingId },
        data: { status: 'DRIVER_ASSIGNED' },
      });
    }

    return { tripId: trip.id, groupId: group.id };
  }

  // Helper to setup a trip with multiple passengers and sequential route stops
  async function createTripWithOrderedStops(
    passengersData: Array<{
      passengerId: string;
      bookingId: string;
      otp: string;
      stopOrder: number;
      farePaise: number;
    }>,
  ) {
    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: pdeuPickupPointId,
        rideType: 'SHARED',
        status: 'READY_FOR_DISPATCH',
        totalSharedFarePaise: passengersData.reduce((s, p) => s + p.farePaise, 0),
        totalRouteDistanceMeters: 4000,
        totalRouteDurationSec: 500,
      },
    });
    createdGroupIds.push(group.id);

    const routeVersion = await prisma.groupRouteVersion.create({
      data: {
        rideGroupId: group.id,
        versionNumber: 1,
        routeGeometry: { type: 'LineString', coordinates: [[72.6668, 23.155], [72.65, 23.16]] },
        totalDistanceMeters: 4000,
        totalDurationSec: 500,
      },
    });

    for (const p of passengersData) {
      const gm = await prisma.groupMember.create({
        data: {
          rideGroupId: group.id,
          bookingId: p.bookingId,
          dropoffSequenceOrder: p.stopOrder,
          directDistanceMeters: 3000,
          directDurationSec: 400,
          sharedDurationSec: 500,
          calculatedDetourPercent: 5.0,
          allocatedFarePaise: p.farePaise,
          isActiveMember: true,
        },
      });

      await prisma.$executeRaw`
        INSERT INTO group_route_stops (
          id, group_route_version_id, group_member_id, stop_order, stop_location, stop_type
        ) VALUES (
          gen_random_uuid(), ${routeVersion.id}::uuid, ${gm.id}::uuid, ${p.stopOrder},
          ST_SetSRID(ST_MakePoint(72.65, 23.16), 4326), 'DROPOFF'
        );
      `;
    }

    const trip = await tripsService.createTripManifest({
      driverId: assignedDriverProfileId,
      rideGroupId: group.id,
      passengers: passengersData.map((p) => ({
        bookingId: p.bookingId,
        passengerId: p.passengerId,
        farePaise: p.farePaise,
        otp: p.otp,
      })),
    });
    createdTripIds.push(trip.id);

    for (const p of passengersData) {
      await prisma.booking.update({
        where: { id: p.bookingId },
        data: { status: 'DRIVER_ASSIGNED' },
      });
    }

    return { tripId: trip.id, groupId: group.id, routeVersionId: routeVersion.id };
  }

  describe('1. Driver Arrival (reportArrival)', () => {
    it('should transition trip to AT_PICKUP, persist driver_arrived_at exactly once, and update bookings', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      const result = await tripsService.reportArrival(
        assignedDriverUserId,
        tripId,
      );

      expect(result.tripId).toBe(tripId);
      expect(result.status).toBe('AT_PICKUP');
      expect(result.driverArrivedAt).toBeDefined();

      // Verify PostgreSQL state
      const updatedTrip = await prisma.trip.findUnique({
        where: { id: tripId },
      });
      expect(updatedTrip?.status).toBe('AT_PICKUP');
      expect(updatedTrip?.driverArrivedAt).toBeDefined();

      const updatedBooking = await prisma.booking.findUnique({
        where: { id: p.bookingId },
      });
      expect(updatedBooking?.status).toBe('DRIVER_ARRIVED');

      // Verify status histories and outbox event
      const tripHistory = await prisma.tripStatusHistory.findMany({
        where: { tripId },
      });
      expect(tripHistory.some((h) => h.newStatus === 'AT_PICKUP')).toBe(true);

      const bookingHistory = await prisma.bookingStatusHistory.findMany({
        where: { bookingId: p.bookingId },
      });
      expect(bookingHistory.some((h) => h.newStatus === 'DRIVER_ARRIVED')).toBe(
        true,
      );

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_DRIVER_ARRIVED' },
      });
      expect(outbox.length).toBe(1);
    });

    it('should reject unapproved driver with 403 FORBIDDEN', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      await expect(
        tripsService.reportArrival(unapprovedDriverUserId, tripId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject driver not assigned to trip with 403 FORBIDDEN', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      await expect(
        tripsService.reportArrival(unauthorizedDriverUserId, tripId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject arrival when Redis GPS fix is missing with 400 MISSING_GPS_FIX', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      // Remove Redis GPS key
      const client = redisService.getClient();
      await client.del(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${assignedDriverProfileId}`);

      let err: any;
      try {
        await tripsService.reportArrival(assignedDriverUserId, tripId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'MISSING_GPS_FIX' }),
      );
    });

    it('should reject arrival when Redis GPS fix is stale (>30s old) with 400 STALE_GPS_FIX', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      // Seed GPS fix older than 30s (35 seconds old)
      await seedDriverGps(assignedDriverProfileId, 23.155, 72.6668, 35_000);

      let err: any;
      try {
        await tripsService.reportArrival(assignedDriverUserId, tripId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'STALE_GPS_FIX' }),
      );
    });

    it('should reject arrival when Redis GPS fix coordinates are invalid with 400 INVALID_GPS_FIX', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      const client = redisService.getClient();
      await client.set(
        `${CACHE_KEYS.DRIVER_GPS_PREFIX}${assignedDriverProfileId}`,
        JSON.stringify({
          latitude: 'invalid',
          longitude: 250,
          updatedAt: new Date().toISOString(),
        }),
        'EX',
        60,
      );

      let err: any;
      try {
        await tripsService.reportArrival(assignedDriverUserId, tripId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'INVALID_GPS_FIX' }),
      );
    });

    it('should reject arrival when driver Redis GPS fix is outside the 150m geofence with 400 OUTSIDE_PICKUP_GEOFENCE', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      // Seed Redis GPS coordinates ~5km away in Gandhinagar
      await seedDriverGps(assignedDriverProfileId, 23.20, 72.63);

      let err: any;
      try {
        await tripsService.reportArrival(assignedDriverUserId, tripId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'OUTSIDE_PICKUP_GEOFENCE' }),
      );
    });

    it('should reject geofence bypass attempt (client supplies PDEU coordinates while Redis fix is outside 150m geofence)', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      // Real GPS fix in Redis is ~5km away
      await seedDriverGps(assignedDriverProfileId, 23.20, 72.63);

      // Caller attempts to supply PDEU coordinates in request arguments/body
      let err: any;
      try {
        await tripsService.reportArrival(assignedDriverUserId, tripId, {
          latitude: 23.155,
          longitude: 72.6668,
        } as any);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'OUTSIDE_PICKUP_GEOFENCE' }),
      );
    });

    it('should accept arrival when driver GPS fix in Redis is fresh and within 150m geofence', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      await seedDriverGps(assignedDriverProfileId, 23.1552, 72.6669);

      const res = await tripsService.reportArrival(
        assignedDriverUserId,
        tripId,
      );
      expect(res.status).toBe('AT_PICKUP');
      expect(res.driverArrivedAt).toBeDefined();
    });

    it('should verify Redis GPS read occurs outside PostgreSQL database transaction', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      const client = redisService.getClient();
      const callOrder: string[] = [];
      const origGet = client.get.bind(client);
      const origTx = prisma.$transaction.bind(prisma);

      const getSpy = vi.spyOn(client, 'get').mockImplementation(async (...args: any[]) => {
        callOrder.push('redis.get');
        return origGet(...(args as [any]));
      });

      const txSpy = vi.spyOn(prisma, '$transaction').mockImplementation(async (...args: any[]) => {
        callOrder.push('prisma.$transaction');
        return (origTx as any)(...args);
      });

      await tripsService.reportArrival(assignedDriverUserId, tripId);

      expect(callOrder[0]).toBe('redis.get');
      expect(callOrder[1]).toBe('prisma.$transaction');

      getSpy.mockRestore();
      txSpy.mockRestore();
    });

    it('should preserve original driver_arrived_at timestamp on duplicate arrival requests', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      // First arrival
      const firstArrival = await tripsService.reportArrival(
        assignedDriverUserId,
        tripId,
      );
      const originalArrivedAt = firstArrival.driverArrivedAt;
      expect(originalArrivedAt).toBeDefined();

      // Wait a moment and call arrival again
      await new Promise((r) => setTimeout(r, 50));
      const secondArrival = await tripsService.reportArrival(
        assignedDriverUserId,
        tripId,
      );

      expect(secondArrival.status).toBe('AT_PICKUP');
      expect(secondArrival.driverArrivedAt).toBe(originalArrivedAt);

      // Verify no duplicate outbox events
      const outboxEvents = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_DRIVER_ARRIVED' },
      });
      expect(outboxEvents.length).toBe(1);
    });

    it('should handle concurrent arrival requests safely without duplicate outbox events', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      // Dispatch 3 concurrent arrival requests
      const promises = [1, 2, 3].map(() =>
        tripsService.reportArrival(assignedDriverUserId, tripId),
      );

      const results = await Promise.all(promises);
      expect(results.length).toBe(3);
      for (const r of results) {
        expect(r.status).toBe('AT_PICKUP');
      }

      // Exactly ONE TRIP_DRIVER_ARRIVED outbox event
      const outboxEvents = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_DRIVER_ARRIVED' },
      });
      expect(outboxEvents.length).toBe(1);
    });
  });

  describe('2. Boarding Verification (verifyBoarding)', () => {
    it('should verify boarding with correct OTP, set boarded_at, and transition booking to BOARDED', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);

      // Seed Redis cache
      await redisService.setPassengerBoardingOtp(p.bookingId, '4821', 1800);

      const result = await tripsService.verifyBoarding(
        assignedDriverUserId,
        tripId,
        { passengerId: p.passengerId, otp: '4821' },
      );

      expect(result.passengerStatus).toBe('BOARDED');
      expect(result.boardedAt).toBeDefined();
      expect(result.waitingChargePaise).toBe(0); // Arrived immediately

      // PostgreSQL checks
      const tp = await prisma.tripPassenger.findFirst({
        where: { tripId, passengerId: p.passengerId },
      });
      expect(tp?.status).toBe('BOARDED');
      expect(tp?.boardedAt).toBeDefined();

      const booking = await prisma.booking.findUnique({
        where: { id: p.bookingId },
      });
      expect(booking?.status).toBe('BOARDED');

      // Redis cache must be invalidated
      const cachedOtp = await redisService.getPassengerBoardingOtp(p.bookingId);
      expect(cachedOtp).toBeNull();
    });

    it('should increment attempts_count on incorrect OTP and commit the increment', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);

      // Attempt with wrong OTP
      await expect(
        tripsService.verifyBoarding(assignedDriverUserId, tripId, {
          passengerId: p.passengerId,
          otp: '0000',
        }),
      ).rejects.toThrow(BadRequestException);

      // Verify attemptsCount is 1 in PostgreSQL
      const tp = await prisma.tripPassenger.findFirst({
        where: { tripId, passengerId: p.passengerId },
      });
      const bv = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tp!.id },
      });
      expect(bv?.attemptsCount).toBe(1);
    });

    it('should allow 3 failed attempts and reject the 4th attempt even with correct OTP', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);

      // Attempt 1: wrong
      await expect(
        tripsService.verifyBoarding(assignedDriverUserId, tripId, {
          passengerId: p.passengerId,
          otp: '1111',
        }),
      ).rejects.toThrow(BadRequestException);

      // Attempt 2: wrong
      await expect(
        tripsService.verifyBoarding(assignedDriverUserId, tripId, {
          passengerId: p.passengerId,
          otp: '2222',
        }),
      ).rejects.toThrow(BadRequestException);

      // Attempt 3: wrong
      await expect(
        tripsService.verifyBoarding(assignedDriverUserId, tripId, {
          passengerId: p.passengerId,
          otp: '3333',
        }),
      ).rejects.toThrow(BadRequestException);

      const tp = await prisma.tripPassenger.findFirst({
        where: { tripId, passengerId: p.passengerId },
      });
      const bv = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tp!.id },
      });
      expect(bv?.attemptsCount).toBe(3);

      // Attempt 4: with the CORRECT OTP -> must be REJECTED!
      try {
        await tripsService.verifyBoarding(assignedDriverUserId, tripId, {
          passengerId: p.passengerId,
          otp: '4821',
        });
        expect.unreachable('Should have thrown OTP_MAX_ATTEMPTS_EXCEEDED');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.response.errorCode).toBe('OTP_MAX_ATTEMPTS_EXCEEDED');
      }
    });

    it('should return already boarded result on duplicate successful verification without duplicate outbox events', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);

      const firstRes = await tripsService.verifyBoarding(
        assignedDriverUserId,
        tripId,
        { passengerId: p.passengerId, otp: '4821' },
      );
      const originalBoardedAt = firstRes.boardedAt;

      // Duplicate verification
      const secondRes = await tripsService.verifyBoarding(
        assignedDriverUserId,
        tripId,
        { passengerId: p.passengerId, otp: '4821' },
      );

      expect(secondRes.passengerStatus).toBe('BOARDED');
      expect(secondRes.boardedAt).toBe(originalBoardedAt);

      // Exactly ONE PASSENGER_BOARDED outbox event
      const tp = await prisma.tripPassenger.findFirst({
        where: { tripId, passengerId: p.passengerId },
      });
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: tp!.id, eventType: 'PASSENGER_BOARDED' },
      });
      expect(outbox.length).toBe(1);
    });

    it('should reject verification when OTP has expired', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);

      // Set expiry to past
      const tp = await prisma.tripPassenger.findFirst({
        where: { tripId, passengerId: p.passengerId },
      });
      await prisma.boardingVerification.updateMany({
        where: { tripPassengerId: tp!.id },
        data: { expiresAt: new Date(Date.now() - 60 * 1000) },
      });

      try {
        await tripsService.verifyBoarding(assignedDriverUserId, tripId, {
          passengerId: p.passengerId,
          otp: '4821',
        });
        expect.unreachable('Should have thrown OTP_EXPIRED');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.response.errorCode).toBe('OTP_EXPIRED');
      }
    });

    it('should reject unassigned driver with 403 FORBIDDEN', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);

      await expect(
        tripsService.verifyBoarding(unauthorizedDriverUserId, tripId, {
          passengerId: p.passengerId,
          otp: '4821',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject passenger not on trip manifest with 404 NOT_FOUND', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);

      await expect(
        tripsService.verifyBoarding(assignedDriverUserId, tripId, {
          passengerId: crypto.randomUUID(),
          otp: '4821',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject verification when trip is not in AT_PICKUP status', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);
      // Do NOT call reportArrival -> trip remains in CREATED

      await expect(
        tripsService.verifyBoarding(assignedDriverUserId, tripId, {
          passengerId: p.passengerId,
          otp: '4821',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('3. Waiting Charge Calculation Integration', () => {
    it('should accurately compute waiting charge boundary: 5:00 -> ₹0, 7:01 -> ₹15, 10:00+ -> ₹25', async () => {
      const p1 = await createTestPassengerAndBooking();
      const p2 = await createTestPassengerAndBooking();
      const p3 = await createTestPassengerAndBooking();

      const { tripId } = await createTripInCreatedStatus([
        { ...p1, otp: '1111' },
        { ...p2, otp: '2222' },
        { ...p3, otp: '3333' },
      ]);

      // Set driver arrival 7 minutes and 1 second ago (421 seconds)
      const arrivedTime = new Date(Date.now() - 421 * 1000);
      await prisma.trip.update({
        where: { id: tripId },
        data: { status: 'AT_PICKUP', driverArrivedAt: arrivedTime },
      });

      // Passenger 2 boards at current time (421 seconds elapsed -> 7:01 -> ₹15 = 1500 paise)
      const resP2 = await tripsService.verifyBoarding(
        assignedDriverUserId,
        tripId,
        { passengerId: p2.passengerId, otp: '2222' },
      );
      expect(resP2.waitingChargePaise).toBe(1500);

      // Now set driver arrival 12 minutes ago for p3
      const arrivedLongAgo = new Date(Date.now() - 720 * 1000);
      await prisma.trip.update({
        where: { id: tripId },
        data: { driverArrivedAt: arrivedLongAgo },
      });

      // Passenger 3 boards (12 mins elapsed -> capped at ₹25 = 2500 paise)
      const resP3 = await tripsService.verifyBoarding(
        assignedDriverUserId,
        tripId,
        { passengerId: p3.passengerId, otp: '3333' },
      );
      expect(resP3.waitingChargePaise).toBe(2500);
    });

    it('should preserve existing waitingChargePaise on repeated calls without re-calculating or accumulating', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '4821' },
      ]);

      // 6:01 elapsed -> 1000 paise (₹10)
      const arrivedTime = new Date(Date.now() - 361 * 1000);
      await prisma.trip.update({
        where: { id: tripId },
        data: { status: 'AT_PICKUP', driverArrivedAt: arrivedTime },
      });

      const firstRes = await tripsService.verifyBoarding(
        assignedDriverUserId,
        tripId,
        { passengerId: p.passengerId, otp: '4821' },
      );
      expect(firstRes.waitingChargePaise).toBe(1000);

      // Call again later
      const secondRes = await tripsService.verifyBoarding(
        assignedDriverUserId,
        tripId,
        { passengerId: p.passengerId, otp: '4821' },
      );
      expect(secondRes.waitingChargePaise).toBe(1000); // Identical, not doubled
    });
  });

  describe('4. Trip Start (startTrip)', () => {
    it('should transition trip to IN_PROGRESS, rideGroup to IN_PROGRESS, bookings to IN_PROGRESS, and persist started_at exactly once', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId, groupId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, {
        passengerId: p.passengerId,
        otp: '1234',
      });

      const res = await tripsService.startTrip(assignedDriverUserId, tripId);
      expect(res.tripId).toBe(tripId);
      expect(res.status).toBe('IN_PROGRESS');
      expect(res.startedAt).toBeDefined();

      const trip = await prisma.trip.findUnique({ where: { id: tripId } });
      expect(trip?.status).toBe('IN_PROGRESS');
      expect(trip?.startedAt).toBeDefined();

      const group = await prisma.rideGroup.findUnique({ where: { id: groupId } });
      expect(group?.status).toBe('IN_PROGRESS');

      const booking = await prisma.booking.findUnique({ where: { id: p.bookingId } });
      expect(booking?.status).toBe('IN_PROGRESS');

      const bookingHistories = await prisma.bookingStatusHistory.findMany({
        where: { bookingId: p.bookingId },
      });
      expect(bookingHistories.some((h) => h.newStatus === 'IN_PROGRESS')).toBe(true);

      const tripHistories = await prisma.tripStatusHistory.findMany({
        where: { tripId },
      });
      expect(tripHistories.some((h) => h.newStatus === 'IN_PROGRESS')).toBe(true);

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_STARTED' },
      });
      expect(outbox.length).toBe(1);
    });

    it('should reject unauthorized or unassigned driver with 403 FORBIDDEN', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, {
        passengerId: p.passengerId,
        otp: '1234',
      });

      await expect(
        tripsService.startTrip(unauthorizedDriverUserId, tripId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject trip start when trip is not in AT_PICKUP status', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);
      // Trip is in CREATED, not AT_PICKUP
      await expect(
        tripsService.startTrip(assignedDriverUserId, tripId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject trip start when any passenger remains in WAITING status', async () => {
      const p1 = await createTestPassengerAndBooking();
      const p2 = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p1, otp: '1111' },
        { ...p2, otp: '2222' },
      ]);

      await tripsService.reportArrival(assignedDriverUserId, tripId);
      // Only board passenger 1
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, {
        passengerId: p1.passengerId,
        otp: '1111',
      });

      let err: any;
      try {
        await tripsService.startTrip(assignedDriverUserId, tripId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'PASSENGERS_NOT_BOARDED' }),
      );
    });

    it('should reject trip start when zero passengers are boarded', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);

      // Driver arrived 11 minutes ago
      const arrivedTime = new Date(Date.now() - 11 * 60 * 1000);
      await prisma.trip.update({
        where: { id: tripId },
        data: { status: 'AT_PICKUP', driverArrivedAt: arrivedTime },
      });

      // Declare no-show
      await tripsService.declareNoShow(assignedDriverUserId, tripId, p.passengerId);

      let err: any;
      try {
        await tripsService.startTrip(assignedDriverUserId, tripId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'NO_BOARDED_PASSENGERS' }),
      );
    });

    it('should preserve started_at and return existing result on duplicate start request (idempotency)', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, {
        passengerId: p.passengerId,
        otp: '1234',
      });

      const firstStart = await tripsService.startTrip(assignedDriverUserId, tripId);
      expect(firstStart.startedAt).toBeDefined();

      await new Promise((r) => setTimeout(r, 50));
      const secondStart = await tripsService.startTrip(assignedDriverUserId, tripId);

      expect(secondStart.status).toBe('IN_PROGRESS');
      expect(secondStart.startedAt).toBe(firstStart.startedAt);

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_STARTED' },
      });
      expect(outbox.length).toBe(1);
    });

    it('should handle concurrent trip start requests safely without duplicate side effects', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p, otp: '1234' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, {
        passengerId: p.passengerId,
        otp: '1234',
      });

      const results = await Promise.all([
        tripsService.startTrip(assignedDriverUserId, tripId),
        tripsService.startTrip(assignedDriverUserId, tripId),
        tripsService.startTrip(assignedDriverUserId, tripId),
      ]);

      for (const r of results) {
        expect(r.status).toBe('IN_PROGRESS');
      }

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_STARTED' },
      });
      expect(outbox.length).toBe(1);
    });
  });

  describe('5. Sequential Passenger Drop-Off (completePassenger)', () => {
    it('should complete first passenger at stop 1, advance current_stop_order to 1, and return correct fare breakdown', async () => {
      const p1 = await createTestPassengerAndBooking();
      const p2 = await createTestPassengerAndBooking();
      const { tripId } = await createTripWithOrderedStops([
        { ...p1, otp: '1111', stopOrder: 1, farePaise: 3500 },
        { ...p2, otp: '2222', stopOrder: 2, farePaise: 4000 },
      ]);

      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p1.passengerId, otp: '1111' });
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p2.passengerId, otp: '2222' });
      await tripsService.startTrip(assignedDriverUserId, tripId);

      // Complete passenger 1 at stop 1
      const res = await tripsService.completePassenger(assignedDriverUserId, tripId, p1.passengerId);

      expect(res.passengerId).toBe(p1.passengerId);
      expect(res.rideFarePaise).toBe(3500);
      expect(res.rideFare).toBe('35.00');
      expect(res.waitingChargePaise).toBe(0);
      expect(res.totalCashToCollectPaise).toBe(3500);
      expect(res.totalCashToCollect).toBe('35.00');

      const trip = await prisma.trip.findUnique({ where: { id: tripId } });
      expect(trip?.currentStopOrder).toBe(1);

      const pax1 = await prisma.tripPassenger.findFirst({ where: { tripId, passengerId: p1.passengerId } });
      expect(pax1?.status).toBe('COMPLETED');
      expect(pax1?.droppedOffAt).toBeDefined();

      const booking1 = await prisma.booking.findUnique({ where: { id: p1.bookingId } });
      expect(booking1?.status).toBe('COMPLETED');

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: pax1!.id, eventType: 'PASSENGER_DROPPED_OFF' },
      });
      expect(outbox.length).toBe(1);
      expect(outbox[0].payload).toEqual(
        expect.objectContaining({ stopOrder: 1, rideFarePaise: 3500 }),
      );
    });

    it('should reject attempting to complete stop 2 before completing stop 1 with 400 INVALID_STOP_SEQUENCE', async () => {
      const p1 = await createTestPassengerAndBooking();
      const p2 = await createTestPassengerAndBooking();
      const { tripId } = await createTripWithOrderedStops([
        { ...p1, otp: '1111', stopOrder: 1, farePaise: 3500 },
        { ...p2, otp: '2222', stopOrder: 2, farePaise: 4000 },
      ]);

      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p1.passengerId, otp: '1111' });
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p2.passengerId, otp: '2222' });
      await tripsService.startTrip(assignedDriverUserId, tripId);

      // Attempt to drop off passenger 2 at stop 2 before stop 1 is completed
      let err: any;
      try {
        await tripsService.completePassenger(assignedDriverUserId, tripId, p2.passengerId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'INVALID_STOP_SEQUENCE' }),
      );
    });

    it('should handle multiple passengers sharing the same stop order correctly', async () => {
      const p1 = await createTestPassengerAndBooking();
      const p2 = await createTestPassengerAndBooking();
      const p3 = await createTestPassengerAndBooking();
      const { tripId } = await createTripWithOrderedStops([
        { ...p1, otp: '1111', stopOrder: 1, farePaise: 3000 },
        { ...p2, otp: '2222', stopOrder: 1, farePaise: 3000 }, // same stop 1!
        { ...p3, otp: '3333', stopOrder: 2, farePaise: 4500 },
      ]);

      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p1.passengerId, otp: '1111' });
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p2.passengerId, otp: '2222' });
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p3.passengerId, otp: '3333' });
      await tripsService.startTrip(assignedDriverUserId, tripId);

      // Drop off passenger 1 at stop 1 -> succeeds
      await tripsService.completePassenger(assignedDriverUserId, tripId, p1.passengerId);

      // Attempt to drop off passenger 3 at stop 2 -> rejected because passenger 2 is still at stop 1
      let err: any;
      try {
        await tripsService.completePassenger(assignedDriverUserId, tripId, p3.passengerId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'INVALID_STOP_SEQUENCE' }),
      );

      // Drop off passenger 2 at stop 1 -> succeeds
      await tripsService.completePassenger(assignedDriverUserId, tripId, p2.passengerId);

      // Now drop off passenger 3 at stop 2 -> succeeds, current_stop_order advances to 2
      const res3 = await tripsService.completePassenger(assignedDriverUserId, tripId, p3.passengerId);
      expect(res3.passengerId).toBe(p3.passengerId);

      const trip = await prisma.trip.findUnique({ where: { id: tripId } });
      expect(trip?.currentStopOrder).toBe(2);
    });

    it('should reject passenger not on trip with 404 PASSENGER_NOT_ON_TRIP', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });
      await tripsService.startTrip(assignedDriverUserId, tripId);

      await expect(
        tripsService.completePassenger(assignedDriverUserId, tripId, crypto.randomUUID()),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject completing passenger not in BOARDED status with 400 INVALID_PASSENGER_STATUS_FOR_COMPLETION', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      // Trip is created, passenger is WAITING
      await prisma.trip.update({ where: { id: tripId }, data: { status: 'IN_PROGRESS' } });

      await expect(
        tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject completing passenger when trip is not in IN_PROGRESS status', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });
      // Trip is AT_PICKUP, not IN_PROGRESS

      let err: any;
      try {
        await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'INVALID_TRIP_STATUS_FOR_COMPLETION' }),
      );
    });

    it('should handle duplicate passenger completion idempotently with identical fare breakdown', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });
      await tripsService.startTrip(assignedDriverUserId, tripId);

      const firstComp = await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);
      expect(firstComp.rideFarePaise).toBe(2000);
      expect(firstComp.waitingChargePaise).toBe(0);
      expect(firstComp.totalCashToCollectPaise).toBe(2000);

      const secondComp = await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);
      expect(secondComp.passengerId).toBe(p.passengerId);
      expect(secondComp.rideFarePaise).toBe(2000);
      expect(secondComp.waitingChargePaise).toBe(0);
      expect(secondComp.totalCashToCollectPaise).toBe(2000);

      const pax = await prisma.tripPassenger.findFirst({ where: { tripId, passengerId: p.passengerId } });
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: pax!.id, eventType: 'PASSENGER_DROPPED_OFF' },
      });
      expect(outbox.length).toBe(1);
    });

    it('should not update outstanding cancellation-fee records, leaving status OUTSTANDING, collected_booking_id null, and collected_at null', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);

      // Create an OUTSTANDING cancellation fee for this passenger
      const outstandingFee = await prisma.cancellationFee.create({
        data: {
          passengerId: p.passengerId,
          originalBookingId: p.bookingId,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });
      await tripsService.startTrip(assignedDriverUserId, tripId);

      // Complete passenger drop-off in Stage 7
      const compResult = await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);

      // Verify completion result only contains ride fare and waiting charges (no cancellation fee recovery)
      expect(compResult.passengerId).toBe(p.passengerId);
      expect(compResult.rideFarePaise).toBe(2000);
      expect(compResult.waitingChargePaise).toBe(0);
      expect(compResult.totalCashToCollectPaise).toBe(2000);
      expect((compResult as any).collectedFeeIds).toBeUndefined();
      expect((compResult as any).outstandingLateFeeSurchargePaise).toBeUndefined();

      // Verify cancellation fee in DB remains strictly OUTSTANDING, collectedBookingId null, and collectedAt null
      const feeInDb = await prisma.cancellationFee.findUnique({
        where: { id: outstandingFee.id },
      });
      expect(feeInDb?.status).toBe('OUTSTANDING');
      expect(feeInDb?.collectedBookingId).toBeNull();
      expect(feeInDb?.collectedAt).toBeNull();
      expect(feeInDb?.amountPaise).toBe(3000);

      // Verify duplicate completion does not touch cancellation fee either (idempotency)
      const duplicateComp = await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);
      expect(duplicateComp.rideFarePaise).toBe(2000);
      expect(duplicateComp.totalCashToCollectPaise).toBe(2000);

      const feeAfterDuplicate = await prisma.cancellationFee.findUnique({
        where: { id: outstandingFee.id },
      });
      expect(feeAfterDuplicate?.status).toBe('OUTSTANDING');
      expect(feeAfterDuplicate?.collectedBookingId).toBeNull();
      expect(feeAfterDuplicate?.collectedAt).toBeNull();
    });

    it('should correctly combine allocated ride fare and previously calculated waiting charge without touching cancellation fees', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);

      // Outstanding fee exists
      const fee = await prisma.cancellationFee.create({
        data: {
          passengerId: p.passengerId,
          originalBookingId: p.bookingId,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });

      // Simulate waiting charge computed during boarding verification (e.g. 1500 paise = ₹15)
      await prisma.tripPassenger.updateMany({
        where: { tripId, passengerId: p.passengerId },
        data: { waitingChargePaise: 1500 },
      });

      await tripsService.startTrip(assignedDriverUserId, tripId);

      const compResult = await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);

      // Ride fare (2000) + Waiting charge (1500) = 3500 paise
      expect(compResult.rideFarePaise).toBe(2000);
      expect(compResult.rideFare).toBe('20.00');
      expect(compResult.waitingChargePaise).toBe(1500);
      expect(compResult.waitingCharge).toBe('15.00');
      expect(compResult.totalCashToCollectPaise).toBe(3500);
      expect(compResult.totalCashToCollect).toBe('35.00');

      // Cancellation fee remains untouched
      const feeInDb = await prisma.cancellationFee.findUnique({
        where: { id: fee.id },
      });
      expect(feeInDb?.status).toBe('OUTSTANDING');
      expect(feeInDb?.collectedBookingId).toBeNull();
      expect(feeInDb?.collectedAt).toBeNull();

      // Outbox event payload check
      const pax = await prisma.tripPassenger.findFirst({ where: { tripId, passengerId: p.passengerId } });
      const outbox = await prisma.outboxEvent.findFirst({
        where: { aggregateId: pax!.id, eventType: 'PASSENGER_DROPPED_OFF' },
      });
      expect(outbox?.payload).toEqual(
        expect.objectContaining({
          rideFarePaise: 2000,
          waitingChargePaise: 1500,
          totalCashToCollectPaise: 3500,
        }),
      );
    });
  });

  describe('6. Vehicle Trip Completion (completeTrip)', () => {
    it('should complete trip, transition rideGroup to COMPLETED, and release driver to AVAILABLE', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId, groupId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });
      await tripsService.startTrip(assignedDriverUserId, tripId);
      await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);

      // Driver operational status is reserved/active during trip
      await prisma.driverProfile.update({
        where: { id: assignedDriverProfileId },
        data: { operationalStatus: 'RESERVED' },
      });

      const res = await tripsService.completeTrip(assignedDriverUserId, tripId);
      expect(res.tripId).toBe(tripId);
      expect(res.status).toBe('COMPLETED');
      expect(res.completedAt).toBeDefined();

      const trip = await prisma.trip.findUnique({ where: { id: tripId } });
      expect(trip?.status).toBe('COMPLETED');
      expect(trip?.completedAt).toBeDefined();

      const group = await prisma.rideGroup.findUnique({ where: { id: groupId } });
      expect(group?.status).toBe('COMPLETED');

      const driverProfile = await prisma.driverProfile.findUnique({
        where: { id: assignedDriverProfileId },
      });
      expect(driverProfile?.operationalStatus).toBe('AVAILABLE');

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_COMPLETED' },
      });
      expect(outbox.length).toBe(1);
    });

    it('should reject vehicle trip completion if any passenger remains WAITING', async () => {
      const p1 = await createTestPassengerAndBooking();
      const p2 = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p1, otp: '1111' },
        { ...p2, otp: '2222' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p1.passengerId, otp: '1111' });

      // Put trip in IN_PROGRESS directly with p2 still WAITING
      await prisma.trip.update({ where: { id: tripId }, data: { status: 'IN_PROGRESS' } });
      await tripsService.completePassenger(assignedDriverUserId, tripId, p1.passengerId);

      let err: any;
      try {
        await tripsService.completeTrip(assignedDriverUserId, tripId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'UNFINALIZED_PASSENGERS' }),
      );
    });

    it('should reject vehicle trip completion if any passenger remains BOARDED', async () => {
      const p1 = await createTestPassengerAndBooking();
      const p2 = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([
        { ...p1, otp: '1111' },
        { ...p2, otp: '2222' },
      ]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p1.passengerId, otp: '1111' });
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p2.passengerId, otp: '2222' });
      await tripsService.startTrip(assignedDriverUserId, tripId);

      // Only complete passenger 1; passenger 2 remains BOARDED
      await tripsService.completePassenger(assignedDriverUserId, tripId, p1.passengerId);

      let err: any;
      try {
        await tripsService.completeTrip(assignedDriverUserId, tripId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'UNFINALIZED_PASSENGERS' }),
      );
    });

    it('should reject vehicle trip completion when trip is not in IN_PROGRESS status', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      // Trip is in CREATED, not IN_PROGRESS
      await expect(
        tripsService.completeTrip(assignedDriverUserId, tripId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should conditionally release driver operational status (not overwrite if driver is SUSPENDED)', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });
      await tripsService.startTrip(assignedDriverUserId, tripId);
      await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);

      // Simulate administrative suspension of driver while trip was in progress
      await prisma.driverProfile.update({
        where: { id: assignedDriverProfileId },
        data: { operationalStatus: 'SUSPENDED' },
      });

      // Complete trip 1
      await tripsService.completeTrip(assignedDriverUserId, tripId);

      // Driver should still be SUSPENDED because conditional update requires operational_status IN ('BUSY', 'RESERVED')
      const driverProfile = await prisma.driverProfile.findUnique({
        where: { id: assignedDriverProfileId },
      });
      expect(driverProfile?.operationalStatus).toBe('SUSPENDED');

      // Clean up back to AVAILABLE
      await prisma.driverProfile.update({
        where: { id: assignedDriverProfileId },
        data: { operationalStatus: 'AVAILABLE' },
      });
    });

    it('should return existing completion result on duplicate completeTrip calls without duplicate side effects (idempotency)', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });
      await tripsService.startTrip(assignedDriverUserId, tripId);
      await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);

      const firstComp = await tripsService.completeTrip(assignedDriverUserId, tripId);
      expect(firstComp.completedAt).toBeDefined();

      await new Promise((r) => setTimeout(r, 50));
      const secondComp = await tripsService.completeTrip(assignedDriverUserId, tripId);

      expect(secondComp.status).toBe('COMPLETED');
      expect(secondComp.completedAt).toBe(firstComp.completedAt);

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_COMPLETED' },
      });
      expect(outbox.length).toBe(1);
    });

    it('should handle concurrent completeTrip requests safely without duplicate side effects', async () => {
      const p = await createTestPassengerAndBooking();
      const { tripId } = await createTripInCreatedStatus([{ ...p, otp: '1234' }]);
      await tripsService.reportArrival(assignedDriverUserId, tripId);
      await tripsService.verifyBoarding(assignedDriverUserId, tripId, { passengerId: p.passengerId, otp: '1234' });
      await tripsService.startTrip(assignedDriverUserId, tripId);
      await tripsService.completePassenger(assignedDriverUserId, tripId, p.passengerId);

      const results = await Promise.all([
        tripsService.completeTrip(assignedDriverUserId, tripId),
        tripsService.completeTrip(assignedDriverUserId, tripId),
        tripsService.completeTrip(assignedDriverUserId, tripId),
      ]);

      for (const r of results) {
        expect(r.status).toBe('COMPLETED');
      }

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripId, eventType: 'TRIP_COMPLETED' },
      });
      expect(outbox.length).toBe(1);
    });
  });
});
