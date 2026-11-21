import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { TripsService } from './trips.service.js';
import { RoutingService } from '../routing/routing.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

describe('Stage 9: Driver Breakdown & Replacement Dispatch', () => {
  const prisma = new PrismaClient();
  let tripsService: TripsService;
  let routingService: RoutingService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdTripIds: string[] = [];
  let testPickupPointId: string;

  beforeAll(async () => {
    const prismaService = new PrismaService();
    await prismaService.onModuleInit();

    const configMock = {
      get: (key: string, def?: any) => {
        if (key === 'routing.osrmBackendUrl') return 'http://127.0.0.1:5000';
        if (key === 'demoMode') return true;
        return def;
      },
    } as any;

    routingService = new RoutingService(configMock);
    tripsService = new TripsService(prismaService, undefined, routingService);

    // Fetch or create pickup point
    let pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    if (!pickup) {
      const [newPickup] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO pickup_points (id, service_zone_id, name, center_point, is_active)
        VALUES (
          gen_random_uuid(),
          (SELECT id FROM service_zones LIMIT 1),
          'PDEU Main Gate',
          ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
          true
        ) RETURNING id;
      `;
      testPickupPointId = newPickup.id;
    } else {
      testPickupPointId = pickup.id;
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(routingService, 'getRoute').mockImplementation(async () => {
      return {
        distanceMeters: 2500,
        durationSec: 180,
        source: 'OSRM',
        isFallback: false,
      };
    });
  });

  afterAll(async () => {
    for (const tripId of createdTripIds) {
      await prisma.fareAdjustment
        .deleteMany({ where: { tripPassenger: { tripId } } })
        .catch(() => {});
      await prisma.refundRecord
        .deleteMany({ where: { tripPassenger: { tripId } } })
        .catch(() => {});
      await prisma.replacementDriverAssignment
        .deleteMany({ where: { incident: { tripId } } })
        .catch(() => {});
      await prisma.replacementDispatchAttempt
        .deleteMany({ where: { incident: { tripId } } })
        .catch(() => {});
      await prisma.tripIncident
        .deleteMany({ where: { tripId } })
        .catch(() => {});
      await prisma.boardingVerification
        .deleteMany({ where: { tripPassenger: { tripId } } })
        .catch(() => {});
      await prisma.tripPassenger
        .deleteMany({ where: { tripId } })
        .catch(() => {});
      await prisma.tripStatusHistory
        .deleteMany({ where: { tripId } })
        .catch(() => {});
      await prisma.trip.deleteMany({ where: { id: tripId } }).catch(() => {});
    }

    for (const bookingId of createdBookingIds) {
      await prisma.cancellationFee
        .deleteMany({
          where: {
            OR: [
              { originalBookingId: bookingId },
              { collectedBookingId: bookingId },
            ],
          },
        })
        .catch(() => {});
      await prisma.groupRouteStop
        .deleteMany({ where: { groupMember: { bookingId } } })
        .catch(() => {});
      await prisma.groupMember
        .deleteMany({ where: { bookingId } })
        .catch(() => {});
      await prisma.bookingStatusHistory
        .deleteMany({ where: { bookingId } })
        .catch(() => {});
      await prisma.booking
        .deleteMany({ where: { id: bookingId } })
        .catch(() => {});
    }

    for (const groupId of createdGroupIds) {
      await prisma.driverDispatchOffer
        .deleteMany({ where: { rideGroupId: groupId } })
        .catch(() => {});
      await prisma.driverAssignment
        .deleteMany({ where: { rideGroupId: groupId } })
        .catch(() => {});
      await prisma.groupRouteStop
        .deleteMany({ where: { groupRouteVersion: { rideGroupId: groupId } } })
        .catch(() => {});
      await prisma.groupRouteVersion
        .deleteMany({ where: { rideGroupId: groupId } })
        .catch(() => {});
      await prisma.dispatchAttempt
        .deleteMany({ where: { rideGroupId: groupId } })
        .catch(() => {});
      await prisma.rideGroup
        .deleteMany({ where: { id: groupId } })
        .catch(() => {});
    }

    for (const userId of createdUserIds) {
      await prisma.vehicle
        .deleteMany({ where: { driverProfile: { userId } } })
        .catch(() => {});
      await prisma.driverProfile
        .deleteMany({ where: { userId } })
        .catch(() => {});
      await prisma.passengerProfile
        .deleteMany({ where: { userId } })
        .catch(() => {});
      await prisma.fareQuote
        .deleteMany({ where: { passengerId: userId } })
        .catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }

    await prisma.$disconnect();
  });

  async function createTestDriver(
    roleSuffix: string,
    operationalStatus = 'AVAILABLE',
    isOnline = true,
    capacity = 4,
  ) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const user = await prisma.user.create({
      data: {
        email: `s9-drv-${roleSuffix}-${suffix}@pdeu.ac.in`,
        fullName: `Stage 9 Driver ${roleSuffix} ${suffix}`,
        role: 'DRIVER',
      },
    });
    createdUserIds.push(user.id);

    const profile = await prisma.driverProfile.create({
      data: {
        userId: user.id,
        licenseNumber: `DL-S9-${roleSuffix}-${suffix}`,
        verificationStatus: 'APPROVED',
        operationalStatus,
        isOnline,
      },
    });

    await prisma.vehicle.create({
      data: {
        driverProfileId: profile.id,
        registrationNumber: `GJ-18-S9-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Mahindra Treo',
        passengerCapacity: capacity,
        isActive: true,
      },
    });

    return { user, profile };
  }

  async function createTestPassengerAndBooking(
    status = 'CONFIRMED',
    farePaise = 3000,
  ) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const user = await prisma.user.create({
      data: {
        email: `s9-pax-${suffix}@pdeu.ac.in`,
        fullName: `S9 Passenger ${suffix}`,
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(user.id);

    await prisma.passengerProfile.create({
      data: { userId: user.id },
    });

    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise, shared_max_fare_paise,
        agreed_fare_ceiling_paise, tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${user.id}::uuid, ${testPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6700, 23.1600), 4326),
        4000, 600, 6000, 2000, 6000, 6000, 1, NOW() + INTERVAL '10 minutes'
      ) RETURNING id;
    `;

    const maxWaitDeadline = new Date(Date.now() + 120 * 1000);
    const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status,
        agreed_fare_ceiling_paise, final_allocated_fare_paise,
        max_wait_deadline, created_at
      ) VALUES (
        gen_random_uuid(), ${user.id}::uuid, ${quote.id}::uuid, ${testPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6700, 23.1600), 4326),
        'SHARED', 2, ${status}, 6000, ${farePaise}, ${maxWaitDeadline}, NOW()
      ) RETURNING id;
    `;
    createdBookingIds.push(booking.id);

    return { user, bookingId: booking.id, farePaise };
  }

  async function createActiveTripWithPassengers(
    passengers: Array<{ user: { id: string }; bookingId: string; farePaise: number }>,
    tripStatus = 'IN_PROGRESS',
  ) {
    const { user: originalDriverUser, profile: originalDriverProfile } =
      await createTestDriver('original', 'RESERVED', true, 4);

    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: testPickupPointId,
        groupVersion: 1,
        totalSharedFarePaise: passengers.reduce((sum, p) => sum + p.farePaise, 0),
        totalRouteDistanceMeters: 5000,
        totalRouteDurationSec: 800,
        status: 'DISPATCHED',
      },
    });
    createdGroupIds.push(group.id);

    for (let i = 0; i < passengers.length; i++) {
      await prisma.groupMember.create({
        data: {
          rideGroupId: group.id,
          bookingId: passengers[i].bookingId,
          dropoffSequenceOrder: i + 1,
          directDistanceMeters: 4000,
          directDurationSec: 600,
          sharedDurationSec: 700,
          calculatedDetourPercent: 15.0,
          allocatedFarePaise: passengers[i].farePaise,
          isActiveMember: true,
        },
      });
    }

    const attempt = await prisma.dispatchAttempt.create({
      data: {
        rideGroupId: group.id,
        attemptNumber: 1,
        groupVersion: 1,
        status: 'ACCEPTED',
      },
    });

    const assignment = await prisma.driverAssignment.create({
      data: {
        dispatchAttemptId: attempt.id,
        rideGroupId: group.id,
        driverId: originalDriverProfile.id,
        status: 'ACTIVE',
      },
    });

    const trip = await prisma.trip.create({
      data: {
        rideGroupId: group.id,
        driverAssignmentId: assignment.id,
        activeDriverId: originalDriverProfile.id,
        status: tripStatus,
        startedAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    });
    createdTripIds.push(trip.id);

    for (const p of passengers) {
      await prisma.tripPassenger.create({
        data: {
          tripId: trip.id,
          passengerId: p.user.id,
          bookingId: p.bookingId,
          status: 'BOARDED',
          finalRideFarePaise: p.farePaise,
          waitingChargePaise: 0,
          boardedAt: new Date(Date.now() - 5 * 60 * 1000),
        },
      });
    }

    return {
      trip,
      group,
      assignment,
      originalDriverUser,
      originalDriverProfile,
    };
  }

  // -------------------------------------------------------------
  // Test Cases
  // -------------------------------------------------------------

  it('1. Report vehicle breakdown transitions trip to INTERRUPTED and captures immutable manifest snapshot', async () => {
    await createTestDriver('rep-available', 'AVAILABLE', true, 4);

    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const p2 = await createTestPassengerAndBooking('CONFIRMED', 2500);

    const { trip, originalDriverUser, originalDriverProfile } =
      await createActiveTripWithPassengers([p1, p2], 'IN_PROGRESS');

    const result = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      {
        incidentLocation: { latitude: 23.1600, longitude: 72.6700 },
        reason: 'Flat tire near PDPU gate 2',
      },
    );

    expect(result.status).toBe('INTERRUPTED');
    expect(result.incidentId).toBeDefined();

    // Verify trip status in database
    const updatedTrip = await prisma.trip.findUnique({
      where: { id: trip.id },
    });
    expect(updatedTrip!.status).toBe('INTERRUPTED');

    // Verify trip_status_history
    const history = await prisma.tripStatusHistory.findMany({
      where: { tripId: trip.id },
    });
    const interruptedEntry = history.find((h) => h.newStatus === 'INTERRUPTED');
    expect(interruptedEntry).toBeDefined();
    expect(interruptedEntry!.previousStatus).toBe('IN_PROGRESS');

    // Verify trip_incidents row and immutable snapshot
    const incident = await prisma.tripIncident.findUnique({
      where: { id: result.incidentId },
    });
    expect(incident).not.toBeNull();
    expect(incident!.tripId).toBe(trip.id);
    expect(incident!.originalDriverId).toBe(originalDriverProfile.id);
    expect(incident!.status).toBe('REPORTED');

    const snapshot = incident!.onboardManifestSnapshot as any;
    expect(snapshot.boardedPassengerCount).toBe(2);
    expect(snapshot.passengers).toHaveLength(2);

    const snapP1 = snapshot.passengers.find((p: any) => p.passengerId === p1.user.id);
    const snapP2 = snapshot.passengers.find((p: any) => p.passengerId === p2.user.id);
    expect(snapP1.allocatedFarePaise).toBe(3000);
    expect(snapP2.allocatedFarePaise).toBe(2500);
    expect(snapP1.destinationLocation).toBeDefined();
  });

  it('2. Replacement driver ranking sorts candidates by OSRM ETA and excludes original driver', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const { trip, originalDriverProfile } =
      await createActiveTripWithPassengers([p1], 'IN_PROGRESS');

    // Create 2 available replacement drivers
    const { profile: _repD1 } = await createTestDriver('rep1', 'AVAILABLE', true, 4);
    const { profile: _repD2 } = await createTestDriver('rep2', 'AVAILABLE', true, 4);

    const candidates = await tripsService.findEligibleReplacementDrivers(
      trip.id,
      { latitude: 23.1600, longitude: 72.6700 },
      1,
      originalDriverProfile.id,
    );

    expect(candidates.length).toBeGreaterThanOrEqual(2);

    // Ensure original broken-down driver is excluded
    const hasOriginal = candidates.some((c) => c.driverId === originalDriverProfile.id);
    expect(hasOriginal).toBe(false);

    // Ensure candidates are sorted by etaSeconds ascending
    for (let i = 0; i < candidates.length - 1; i++) {
      expect(candidates[i].etaSeconds).toBeLessThanOrEqual(candidates[i + 1].etaSeconds);
    }
  });

  it('3. Replacement driver accepts: resumes trip, updates activeDriverId, releases original driver, and applies 10% discount', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const p2 = await createTestPassengerAndBooking('CONFIRMED', 2000);

    const { trip, originalDriverUser, originalDriverProfile } =
      await createActiveTripWithPassengers([p1, p2], 'IN_PROGRESS');

    // Report breakdown
    const breakdown = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      {
        incidentLocation: { latitude: 23.1600, longitude: 72.6700 },
        reason: 'Battery depleted',
      },
    );

    // Create replacement driver
    const { user: repDriverUser, profile: repDriverProfile } =
      await createTestDriver('acceptor', 'AVAILABLE', true, 4);

    // Replacement driver accepts
    const acceptResult = await tripsService.acceptReplacementTrip(
      repDriverUser.id,
      trip.id,
    );

    expect(acceptResult.status).toBe('IN_PROGRESS');
    expect(acceptResult.activeDriverId).toBe(repDriverProfile.id);
    expect(acceptResult.discountPercentage).toBe(10);

    // 1. Verify trip in database
    const updatedTrip = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(updatedTrip!.status).toBe('IN_PROGRESS');
    expect(updatedTrip!.activeDriverId).toBe(repDriverProfile.id);

    // 2. Verify replacement driver is RESERVED
    const repProfileInDb = await prisma.driverProfile.findUnique({
      where: { id: repDriverProfile.id },
    });
    expect(repProfileInDb!.operationalStatus).toBe('RESERVED');

    // 3. Verify original driver is released back to AVAILABLE
    const origProfileInDb = await prisma.driverProfile.findUnique({
      where: { id: originalDriverProfile.id },
    });
    expect(origProfileInDb!.operationalStatus).toBe('AVAILABLE');

    // 4. Verify incident status is RESOLVED
    const updatedIncident = await prisma.tripIncident.findUnique({
      where: { id: breakdown.incidentId },
    });
    expect(updatedIncident!.status).toBe('RESOLVED');

    // 5. Verify 10% discount applied to onboard passengers:
    // p1: 3000 paise - 10% (300) = 2700 paise
    // p2: 2000 paise - 10% (200) = 1800 paise
    const tp1 = await prisma.tripPassenger.findFirst({
      where: { bookingId: p1.bookingId },
    });
    const tp2 = await prisma.tripPassenger.findFirst({
      where: { bookingId: p2.bookingId },
    });
    expect(tp1!.finalRideFarePaise).toBe(2700);
    expect(tp2!.finalRideFarePaise).toBe(1800);

    const b1 = await prisma.booking.findUnique({ where: { id: p1.bookingId } });
    const b2 = await prisma.booking.findUnique({ where: { id: p2.bookingId } });
    expect(b1!.finalAllocatedFarePaise).toBe(2700);
    expect(b2!.finalAllocatedFarePaise).toBe(1800);

    // Verify fare_adjustments audit records
    const adjustments = await prisma.fareAdjustment.findMany({
      where: { tripPassenger: { tripId: trip.id } },
    });
    expect(adjustments).toHaveLength(2);
    expect(adjustments.every((a) => a.discountPercentage === 10)).toBe(true);
    expect(adjustments.find((a) => a.tripPassengerId === tp1!.id)!.adjustmentAmountPaise).toBe(300);
    expect(adjustments.find((a) => a.tripPassengerId === tp2!.id)!.adjustmentAmountPaise).toBe(200);

    // Verify TRIP_RESUMED outbox event
    const outbox = await prisma.outboxEvent.findFirst({
      where: { aggregateId: trip.id, eventType: 'TRIP_RESUMED' },
    });
    expect(outbox).not.toBeNull();
  });

  it('4. Passenger already completed prior to breakdown receives NO discount', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000); // Disembarked early
    const p2 = await createTestPassengerAndBooking('CONFIRMED', 2000); // Still onboard

    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1, p2],
      'IN_PROGRESS',
    );

    // Mark p1 as COMPLETED before breakdown
    await prisma.tripPassenger.updateMany({
      where: { bookingId: p1.bookingId },
      data: { status: 'COMPLETED', droppedOffAt: new Date() },
    });

    // Report breakdown
    await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      {
        incidentLocation: { latitude: 23.1600, longitude: 72.6700 },
        reason: 'Engine overheat',
      },
    );

    // Replacement driver accepts
    const { user: repDriverUser } = await createTestDriver('rep-no-drop', 'AVAILABLE', true, 4);
    await tripsService.acceptReplacementTrip(repDriverUser.id, trip.id);

    // p1 was already COMPLETED: fare must remain 3000 (0% discount)
    const tp1 = await prisma.tripPassenger.findFirst({
      where: { bookingId: p1.bookingId },
    });
    expect(tp1!.finalRideFarePaise).toBe(3000);

    // p2 was BOARDED: fare discounted by 10% (1800)
    const tp2 = await prisma.tripPassenger.findFirst({
      where: { bookingId: p2.bookingId },
    });
    expect(tp2!.finalRideFarePaise).toBe(1800);

    // Only 1 fare adjustment row exists (for p2)
    const adjustments = await prisma.fareAdjustment.findMany({
      where: { tripPassenger: { tripId: trip.id } },
    });
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].tripPassengerId).toBe(tp2!.id);
  });

  it('5. Unresolved failure / abort: trip marked ABORTED, onboard fares set to ₹0.00, and refund audit recorded', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 4000);
    const p2 = await createTestPassengerAndBooking('CONFIRMED', 3000);

    const { trip, originalDriverUser, originalDriverProfile } =
      await createActiveTripWithPassengers([p1, p2], 'IN_PROGRESS');

    // Report breakdown
    await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      {
        incidentLocation: { latitude: 23.1600, longitude: 72.6700 },
        reason: 'Total mechanical transmission failure',
      },
    );

    // Abort the trip (simulating exhausted replacement dispatch)
    const abortResult = await tripsService.abortInterruptedTrip(
      trip.id,
      'All replacement driver offers timed out or rejected',
    );

    expect(abortResult.status).toBe('ABORTED');
    expect(abortResult.affectedPassengersCount).toBe(2);

    // Verify trip status is ABORTED
    const updatedTrip = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(updatedTrip!.status).toBe('ABORTED');

    // Verify all onboard passenger fares set to ₹0
    const tp1 = await prisma.tripPassenger.findFirst({
      where: { bookingId: p1.bookingId },
    });
    const tp2 = await prisma.tripPassenger.findFirst({
      where: { bookingId: p2.bookingId },
    });
    expect(tp1!.finalRideFarePaise).toBe(0);
    expect(tp2!.finalRideFarePaise).toBe(0);

    const b1 = await prisma.booking.findUnique({ where: { id: p1.bookingId } });
    const b2 = await prisma.booking.findUnique({ where: { id: p2.bookingId } });
    expect(b1!.finalAllocatedFarePaise).toBe(0);
    expect(b2!.finalAllocatedFarePaise).toBe(0);

    // Verify refund_records audited
    const refunds = await prisma.refundRecord.findMany({
      where: { tripPassenger: { tripId: trip.id } },
    });
    expect(refunds).toHaveLength(2);
    expect(refunds.find((r) => r.tripPassengerId === tp1!.id)!.refundAmountPaise).toBe(4000);
    expect(refunds.find((r) => r.tripPassengerId === tp2!.id)!.refundAmountPaise).toBe(3000);

    // Original driver released back to AVAILABLE
    const driverInDb = await prisma.driverProfile.findUnique({
      where: { id: originalDriverProfile.id },
    });
    expect(driverInDb!.operationalStatus).toBe('AVAILABLE');

    // TRIP_ABORTED outbox event
    const outbox = await prisma.outboxEvent.findFirst({
      where: { aggregateId: trip.id, eventType: 'TRIP_ABORTED' },
    });
    expect(outbox).not.toBeNull();
  });

  it('6. Original driver cannot accept their own replacement handover', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1],
      'IN_PROGRESS',
    );

    await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Tire puncture' },
    );

    // Original driver attempts to accept replacement
    await expect(
      tripsService.acceptReplacementTrip(originalDriverUser.id, trip.id),
    ).rejects.toThrow(BadRequestException);
  });

  it('7. Cannot report breakdown on a trip that is not IN_PROGRESS', async () => {
    const p1 = await createTestPassengerAndBooking('DRIVER_ARRIVED', 3000);
    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1],
      'AT_PICKUP', // Not yet started
    );

    await expect(
      tripsService.reportBreakdown(originalDriverUser.id, trip.id, {
        reason: 'Broke down before departing pickup',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('8. Idempotent breakdown reporting returns existing incident without creating duplicates', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1],
      'IN_PROGRESS',
    );

    const first = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Breakdown call 1' },
    );

    const second = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Breakdown call 2' },
    );

    expect(first.incidentId).toBe(second.incidentId);

    // Exactly 1 incident in database
    const incidents = await prisma.tripIncident.findMany({
      where: { tripId: trip.id },
    });
    expect(incidents).toHaveLength(1);
  });

  it('9. Concurrent replacement driver acceptances allow exactly one winner', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1],
      'IN_PROGRESS',
    );

    await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Mid-trip engine stop' },
    );

    const { user: repD1 } = await createTestDriver('race1', 'AVAILABLE', true, 4);
    const { user: repD2 } = await createTestDriver('race2', 'AVAILABLE', true, 4);

    // Simultaneously attempt acceptances
    const results = await Promise.allSettled([
      tripsService.acceptReplacementTrip(repD1.id, trip.id),
      tripsService.acceptReplacementTrip(repD2.id, trip.id),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one assignment row
    const assignments = await prisma.replacementDriverAssignment.findMany({
      where: { incident: { tripId: trip.id } },
    });
    expect(assignments).toHaveLength(1);
  });

  it('10. OSRM unavailable after 3 retries aborts interrupted trip immediately with ₹0 fare and refund audit (no geodesic fallback)', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3500);
    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1],
      'IN_PROGRESS',
    );

    // Mock OSRM to always return fallback or fail
    let attemptCount = 0;
    vi.spyOn(routingService, 'getRoute').mockImplementation(async () => {
      attemptCount++;
      return {
        distanceMeters: 1000,
        durationSec: 100,
        source: 'FALLBACK',
        isFallback: true,
      };
    });

    const result = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Overheating engine on highway' },
    );

    // Trip immediately aborted per documented behavior
    expect(result.status).toBe('ABORTED');
    expect(result.replacementCandidates).toHaveLength(0);
    // Verified 1 initial attempt + 3 retries = 4 attempts total
    expect(attemptCount).toBeGreaterThanOrEqual(4);

    const updatedTrip = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(updatedTrip!.status).toBe('ABORTED');

    const tp = await prisma.tripPassenger.findFirst({ where: { bookingId: p1.bookingId } });
    expect(tp!.finalRideFarePaise).toBe(0);

    const refund = await prisma.refundRecord.findFirst({ where: { tripPassengerId: tp!.id } });
    expect(refund).not.toBeNull();
    expect(refund!.refundAmountPaise).toBe(3500);
  });

  it('11. Sequential dispatch offers to Candidate #1 first with 20-second timeout and creates active attempt', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const { trip, originalDriverUser } =
      await createActiveTripWithPassengers([p1], 'IN_PROGRESS');

    const { profile: _rep1 } = await createTestDriver('seq1', 'AVAILABLE', true, 4);
    const { profile: _rep2 } = await createTestDriver('seq2', 'AVAILABLE', true, 4);

    const result = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Tire blown out' },
    );

    expect(result.status).toBe('INTERRUPTED');
    expect(result.activeOffer).toBeDefined();
    expect(result.activeOffer.attemptNumber).toBe(1);

    // Exactly 1 ACTIVE attempt created in DB
    const attempts = await prisma.replacementDispatchAttempt.findMany({
      where: { tripIncidentId: result.incidentId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('ACTIVE');
    expect(attempts[0].attemptNumber).toBe(1);

    // Outbox event REPLACEMENT_OFFER_DISPATCHED
    const outbox = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: result.incidentId,
        eventType: 'REPLACEMENT_OFFER_DISPATCHED',
      },
    });
    expect(outbox).not.toBeNull();
    const payload = outbox!.payload as any;
    expect(payload.attemptNumber).toBe(1);
    expect(payload.driverId).toBeDefined();
  });

  it('12. Rejection by Candidate #1 marks attempt REJECTED and cascades immediately to Candidate #2', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1],
      'IN_PROGRESS',
    );

    const { user: repUser1 } =
      await createTestDriver('rej1', 'AVAILABLE', true, 4);
    const { user: _repUser2 } =
      await createTestDriver('rej2', 'AVAILABLE', true, 4);

    let count = 0;
    vi.spyOn(routingService, 'getRoute').mockImplementation(async () => {
      count++;
      return {
        distanceMeters: 2000,
        durationSec: count === 1 ? 100 : 200,
        source: 'OSRM',
        isFallback: false,
      };
    });

    const breakdown = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Engine stall' },
    );

    const firstAttempt = await prisma.replacementDispatchAttempt.findFirst({
      where: { tripIncidentId: breakdown.incidentId, status: 'ACTIVE' },
    });
    expect(firstAttempt).not.toBeNull();

    // repUser1 rejects the offer
    const rejectRes = await tripsService.rejectReplacementOffer(
      repUser1.id,
      trip.id,
      firstAttempt!.id,
    );

    expect(rejectRes.status).toBe('REJECTED');
    expect(rejectRes.cascade.cascaded).toBe(true);

    // First attempt is now REJECTED
    const updatedFirstAttempt = await prisma.replacementDispatchAttempt.findUnique({
      where: { id: firstAttempt!.id },
    });
    expect(updatedFirstAttempt!.status).toBe('REJECTED');

    // Second attempt is now ACTIVE for next candidate
    const attempts = await prisma.replacementDispatchAttempt.findMany({
      where: { tripIncidentId: breakdown.incidentId },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1].status).toBe('ACTIVE');
    expect(attempts[1].attemptNumber).toBe(2);

    // Verify REPLACEMENT_OFFER_REJECTED outbox event
    const rejOutbox = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: breakdown.incidentId,
        eventType: 'REPLACEMENT_OFFER_REJECTED',
      },
    });
    expect(rejOutbox).not.toBeNull();
  });

  it('13. 20-second timeout marks attempt EXPIRED and cascades to next driver', async () => {
    const p1 = await createTestPassengerAndBooking('CONFIRMED', 3000);
    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1],
      'IN_PROGRESS',
    );

    const { profile: repProf1 } = await createTestDriver('to1', 'AVAILABLE', true, 4);
    const { profile: _repProf2 } = await createTestDriver('to2', 'AVAILABLE', true, 4);

    const breakdown = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Alternator failure' },
    );

    const activeAttempt = await prisma.replacementDispatchAttempt.findFirst({
      where: { tripIncidentId: breakdown.incidentId, status: 'ACTIVE' },
    });

    // Simulate 20s BullMQ timeout execution
    const timeoutRes = await tripsService.handleReplacementTimeout({
      tripId: trip.id,
      incidentId: breakdown.incidentId,
      attemptId: activeAttempt!.id,
      attemptNumber: activeAttempt!.attemptNumber,
      driverId: repProf1.id,
    });

    expect(timeoutRes.cascaded).toBe(true);

    // Original attempt is EXPIRED
    const expiredAttempt = await prisma.replacementDispatchAttempt.findUnique({
      where: { id: activeAttempt!.id },
    });
    expect(expiredAttempt!.status).toBe('EXPIRED');

    // Attempt #2 created
    const attempt2 = await prisma.replacementDispatchAttempt.findFirst({
      where: { tripIncidentId: breakdown.incidentId, attemptNumber: 2 },
    });
    expect(attempt2).not.toBeNull();
    expect(attempt2!.status).toBe('ACTIVE');

    // Outbox event REPLACEMENT_OFFER_EXPIRED
    const expOutbox = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: breakdown.incidentId,
        eventType: 'REPLACEMENT_OFFER_EXPIRED',
      },
    });
    expect(expOutbox).not.toBeNull();
  });

  it('14. All candidate drivers exhausted (rejections/timeouts) automatically aborts trip with ₹0 fare and refund audit', async () => {
    // Take other available test drivers offline for this exhaustion test
    await prisma.driverProfile.updateMany({
      where: { operationalStatus: 'AVAILABLE' },
      data: { isOnline: false },
    });

    const p1 = await createTestPassengerAndBooking('CONFIRMED', 4500);
    const { trip, originalDriverUser } = await createActiveTripWithPassengers(
      [p1],
      'IN_PROGRESS',
    );

    // Only 1 replacement driver exists online
    const { user: repUser1 } =
      await createTestDriver('only1', 'AVAILABLE', true, 4);

    const breakdown = await tripsService.reportBreakdown(
      originalDriverUser.id,
      trip.id,
      { reason: 'Blown head gasket' },
    );

    const attempt = await prisma.replacementDispatchAttempt.findFirst({
      where: { tripIncidentId: breakdown.incidentId, status: 'ACTIVE' },
    });

    // That only candidate rejects
    const rejectRes = await tripsService.rejectReplacementOffer(
      repUser1.id,
      trip.id,
      attempt!.id,
    );

    // Candidates exhausted -> auto-abort!
    expect(rejectRes.cascade.aborted).toBe(true);
    expect(rejectRes.cascade.reason).toBe('ALL_REPLACEMENT_OFFERS_EXHAUSTED');

    // Trip is ABORTED
    const abortedTrip = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(abortedTrip!.status).toBe('ABORTED');

    // Onboard passenger fare set to 0
    const tp = await prisma.tripPassenger.findFirst({ where: { bookingId: p1.bookingId } });
    expect(tp!.finalRideFarePaise).toBe(0);

    // Full refund audited
    const refund = await prisma.refundRecord.findFirst({ where: { tripPassengerId: tp!.id } });
    expect(refund).not.toBeNull();
    expect(refund!.refundAmountPaise).toBe(4500);
  });
});
