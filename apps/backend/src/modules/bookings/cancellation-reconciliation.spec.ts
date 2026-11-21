import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { BookingsService } from './bookings.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { RoutingService } from '../routing/routing.service.js';
import { TripsService } from '../trips/trips.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

describe('Stage 8 — Phase 2: Booking Cancellation & Trip Hardening', () => {
  const prisma = new PrismaClient();
  let bookingsService: BookingsService;
  let tripsService: TripsService;
  let routingService: RoutingService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdTripIds: string[] = [];
  let testPickupPointId: string;
  let defaultDriverUser: { id: string };
  let defaultDriverProfile: { id: string };

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
    const locationsService = new LocationsService(prismaService);
    bookingsService = new BookingsService(
      prismaService,
      locationsService,
      undefined,
      routingService,
    );
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

    // Create default driver
    const suffix = Date.now();
    defaultDriverUser = await prisma.user.create({
      data: {
        email: `stage8-canc-drv-${suffix}@pdeu.ac.in`,
        fullName: 'Stage 8 Cancellation Driver',
        role: 'DRIVER',
      },
    });
    createdUserIds.push(defaultDriverUser.id);

    defaultDriverProfile = await prisma.driverProfile.create({
      data: {
        userId: defaultDriverUser.id,
        licenseNumber: `DL-S8-CANC-${suffix}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });

    await prisma.vehicle.create({
      data: {
        driverProfileId: defaultDriverProfile.id,
        registrationNumber: `GJ-18-CANC-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Mahindra Treo',
        passengerCapacity: 4,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    for (const tripId of createdTripIds) {
      await prisma.paymentAllocation
        .deleteMany({ where: { cashCollection: { tripId } } })
        .catch(() => {});
      await prisma.cashCollection.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.boardingVerification
        .deleteMany({ where: { tripPassenger: { tripId } } })
        .catch(() => {});
      await prisma.tripPassenger.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.tripStatusHistory.deleteMany({ where: { tripId } }).catch(() => {});
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
      await prisma.groupMember.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.bookingStatusHistory
        .deleteMany({ where: { bookingId } })
        .catch(() => {});
      await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
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
      await prisma.rideGroup.deleteMany({ where: { id: groupId } }).catch(() => {});
    }

    for (const userId of createdUserIds) {
      await prisma.fareQuote.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.passengerProfile.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.driverProfile.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }

    await prisma.$disconnect();
  });

  async function createTestPassengerAndBooking(
    status = 'REQUESTED',
    deadlineOffsetSec = 120,
  ) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const user = await prisma.user.create({
      data: {
        email: `pax-${suffix}@pdeu.ac.in`,
        fullName: `Test Passenger ${suffix}`,
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(user.id);

    await prisma.passengerProfile.create({
      data: {
        userId: user.id,
      },
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
        4000, 600, 6000, 2000, 6000, 6000, 1, NOW() + INTERVAL '2 minutes'
      ) RETURNING id;
    `;

    const maxWaitDeadline = new Date(Date.now() + deadlineOffsetSec * 1000);
    const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status,
        agreed_fare_ceiling_paise, max_wait_deadline, created_at
      ) VALUES (
        gen_random_uuid(), ${user.id}::uuid, ${quote.id}::uuid, ${testPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6700, 23.1600), 4326),
        'SHARED', 2, ${status}, 6000, ${maxWaitDeadline}, NOW()
      ) RETURNING id;
    `;
    createdBookingIds.push(booking.id);

    return { user, bookingId: booking.id, maxWaitDeadline };
  }

  async function createTestSharedGroup(
    bookings: Array<{ user: { id: string }; bookingId: string }>,
    groupStatus = 'MATCHED',
  ) {
    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: testPickupPointId,
        groupVersion: 1,
        totalSharedFarePaise: 6000,
        totalRouteDistanceMeters: 5000,
        totalRouteDurationSec: 800,
        status: groupStatus,
      },
    });
    createdGroupIds.push(group.id);

    for (let i = 0; i < bookings.length; i++) {
      await prisma.groupMember.create({
        data: {
          rideGroupId: group.id,
          bookingId: bookings[i].bookingId,
          dropoffSequenceOrder: i + 1,
          directDistanceMeters: 4000,
          directDurationSec: 600,
          sharedDurationSec: 700,
          calculatedDetourPercent: 16.67,
          allocatedFarePaise: 3000,
          isActiveMember: true,
        },
      });
    }

    return group;
  }

  async function materializeTripForGroup(
    group: { id: string },
    bookings: Array<{ user: { id: string }; bookingId: string }>,
  ) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const driverUser = await prisma.user.create({
      data: {
        email: `drv-mat-${suffix}@pdeu.ac.in`,
        fullName: `Trip Driver ${suffix}`,
        role: 'DRIVER',
      },
    });
    createdUserIds.push(driverUser.id);

    const driverProfile = await prisma.driverProfile.create({
      data: {
        userId: driverUser.id,
        licenseNumber: `DL-MAT-${suffix}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'RESERVED',
        isOnline: true,
      },
    });

    await prisma.vehicle.create({
      data: {
        driverProfileId: driverProfile.id,
        registrationNumber: `GJ-18-M-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Mahindra Treo',
        passengerCapacity: 4,
        isActive: true,
      },
    });

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
        driverId: driverProfile.id,
        status: 'ACTIVE',
      },
    });

    const trip = await prisma.trip.create({
      data: {
        rideGroupId: group.id,
        driverAssignmentId: assignment.id,
        activeDriverId: driverProfile.id,
        status: 'AT_PICKUP',
        driverArrivedAt: new Date(Date.now() - 11 * 60 * 1000), // 11 mins ago
      },
    });
    createdTripIds.push(trip.id);

    for (const b of bookings) {
      await prisma.tripPassenger.create({
        data: {
          tripId: trip.id,
          passengerId: b.user.id,
          bookingId: b.bookingId,
          status: 'WAITING',
          finalRideFarePaise: 3000,
          waitingChargePaise: 0,
        },
      });
    }

    return { trip, assignment, driverUser, driverProfile };
  }

  // -------------------------------------------------------------
  // Test Cases
  // -------------------------------------------------------------

  it('1. Cancellation before driver assignment incurs ₹0 fee and updates booking status', async () => {
    const { user, bookingId } = await createTestPassengerAndBooking('REQUESTED');

    const result = await bookingsService.cancelBooking(
      { id: user.id, role: 'PASSENGER' },
      bookingId,
      { reason: 'Change of plans' },
    );

    expect(result.status).toBe('CANCELLED');
    expect(result.cancellationFeeAssessedPaise).toBe(0);
    expect(result.cancellationFeeStatus).toBe('NONE');

    // Verify no fee row created in cancellation_fees
    const fee = await prisma.cancellationFee.findUnique({
      where: { originalBookingId: bookingId },
    });
    expect(fee).toBeNull();

    // Verify status history recorded
    const history = await prisma.bookingStatusHistory.findMany({
      where: { bookingId },
    });
    expect(history.some((h) => h.newStatus === 'CANCELLED')).toBe(true);
  });

  it('2. Cancellation after driver assignment assesses fixed ₹30 fee as OUTSTANDING', async () => {
    const { user, bookingId } = await createTestPassengerAndBooking('DRIVER_ASSIGNED');

    const result = await bookingsService.cancelBooking(
      { id: user.id, role: 'PASSENGER' },
      bookingId,
      { reason: 'No longer need ride' },
    );

    expect(result.status).toBe('CANCELLED');
    expect(result.cancellationFeeAssessedPaise).toBe(3000);
    expect(result.cancellationFeeStatus).toBe('OUTSTANDING');

    // Verify fee in cancellation_fees table
    const fee = await prisma.cancellationFee.findUnique({
      where: { originalBookingId: bookingId },
    });
    expect(fee).not.toBeNull();
    expect(fee!.amountPaise).toBe(3000);
    expect(fee!.status).toBe('OUTSTANDING');
    expect(fee!.collectedBookingId).toBeNull();
  });

  it('3. Cancellation after driver arrival assesses ₹30 fee and synchronizes TripPassenger to CANCELLED', async () => {
    const p1 = await createTestPassengerAndBooking('DRIVER_ARRIVED');
    const p2 = await createTestPassengerAndBooking('DRIVER_ARRIVED');

    const group = await createTestSharedGroup([p1, p2], 'DRIVER_ASSIGNED');
    await materializeTripForGroup(group, [p1, p2]);

    const result = await bookingsService.cancelBooking(
      { id: p1.user.id, role: 'PASSENGER' },
      p1.bookingId,
      { reason: 'Late passenger cancellation at pickup' },
    );

    expect(result.status).toBe('CANCELLED');
    expect(result.cancellationFeeAssessedPaise).toBe(3000);
    expect(result.cancellationFeeStatus).toBe('OUTSTANDING');

    // TripPassenger for p1 must be CANCELLED
    const tp1 = await prisma.tripPassenger.findFirst({
      where: { bookingId: p1.bookingId },
    });
    expect(tp1!.status).toBe('CANCELLED');
  });

  it('4. Cancelled passenger does not block startTrip() for surviving boarded passenger', async () => {
    const p1 = await createTestPassengerAndBooking('DRIVER_ARRIVED');
    const p2 = await createTestPassengerAndBooking('DRIVER_ARRIVED');
    const p3 = await createTestPassengerAndBooking('DRIVER_ARRIVED');

    const group = await createTestSharedGroup([p1, p2, p3], 'DRIVER_ASSIGNED');
    const { trip, driverUser } = await materializeTripForGroup(group, [
      p1,
      p2,
      p3,
    ]);

    // p2 and p3 board successfully
    await prisma.tripPassenger.updateMany({
      where: { bookingId: { in: [p2.bookingId, p3.bookingId] } },
      data: { status: 'BOARDED', boardedAt: new Date() },
    });

    // p1 cancels
    await bookingsService.cancelBooking(
      { id: p1.user.id, role: 'PASSENGER' },
      p1.bookingId,
      { reason: 'Cancelled before departure' },
    );

    // Ensure trip remains AT_PICKUP so driver can depart
    await prisma.trip.update({
      where: { id: trip.id },
      data: { status: 'AT_PICKUP' },
    });

    // Driver starts trip with p2 and p3 boarded; cancelled p1 does not block
    const startResult = await tripsService.startTrip(driverUser.id, trip.id);
    expect(startResult.status).toBe('IN_PROGRESS');

    const updatedTrip = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(updatedTrip!.status).toBe('IN_PROGRESS');
  });

  it('5. Group route recalculation when at least two survivors remain (3 pax -> 1 cancels -> 2 survive)', async () => {
    const p1 = await createTestPassengerAndBooking('MATCHED');
    const p2 = await createTestPassengerAndBooking('MATCHED');
    const p3 = await createTestPassengerAndBooking('MATCHED');

    const group = await createTestSharedGroup([p1, p2, p3], 'MATCHED');

    // p1 cancels
    await bookingsService.cancelBooking(
      { id: p1.user.id, role: 'PASSENGER' },
      p1.bookingId,
      { reason: 'Cannot make it' },
    );

    // Verify group remains active and groupVersion incremented
    const updatedGroup = await prisma.rideGroup.findUnique({
      where: { id: group.id },
    });
    expect(updatedGroup!.status).toBe('MATCHED');
    expect(updatedGroup!.groupVersion).toBe(2);

    // Verify p1 membership deactivated, p2 & p3 remain active
    const members = await prisma.groupMember.findMany({
      where: { rideGroupId: group.id },
      orderBy: { dropoffSequenceOrder: 'asc' },
    });
    const m1 = members.find((m) => m.bookingId === p1.bookingId);
    const m2 = members.find((m) => m.bookingId === p2.bookingId);
    const m3 = members.find((m) => m.bookingId === p3.bookingId);

    expect(m1!.isActiveMember).toBe(false);
    expect(m2!.isActiveMember).toBe(true);
    expect(m3!.isActiveMember).toBe(true);
  });

  it('6. Group dissolution when fewer than two survive (2 pax -> 1 cancels -> 1 survives)', async () => {
    const p1 = await createTestPassengerAndBooking('DRIVER_ASSIGNED', 120);
    const p2 = await createTestPassengerAndBooking('DRIVER_ASSIGNED', 120);

    const group = await createTestSharedGroup([p1, p2], 'DRIVER_ASSIGNED');
    const { trip, assignment, driverProfile } = await materializeTripForGroup(
      group,
      [p1, p2],
    );

    // p1 cancels
    await bookingsService.cancelBooking(
      { id: p1.user.id, role: 'PASSENGER' },
      p1.bookingId,
      { reason: 'Cancelling from pair' },
    );

    // Group must be DISSOLVED
    const updatedGroup = await prisma.rideGroup.findUnique({ where: { id: group.id } });
    expect(updatedGroup!.status).toBe('DISSOLVED');

    // Driver assignment must be RELEASED
    const updatedAssignment = await prisma.driverAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(updatedAssignment!.status).toBe('RELEASED');

    // Driver profile must be back to AVAILABLE
    const driver = await prisma.driverProfile.findUnique({
      where: { id: driverProfile.id },
    });
    expect(driver!.operationalStatus).toBe('AVAILABLE');

    // Associated trip must be CANCELLED
    const updatedTrip = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(updatedTrip!.status).toBe('CANCELLED');

    // Surviving member p2 returned to REQUESTED with original deadline preserved
    const survivingBooking = await prisma.booking.findUnique({
      where: { id: p2.bookingId },
    });
    expect(survivingBooking!.status).toBe('REQUESTED');
    expect(survivingBooking!.maxWaitDeadline.getTime()).toBe(
      p2.maxWaitDeadline.getTime(),
    );
  });

  it('7. Surviving booking transitions to EXPIRED if deadline has passed at dissolution', async () => {
    const p1 = await createTestPassengerAndBooking('DRIVER_ASSIGNED', -10); // Expired 10s ago
    const p2 = await createTestPassengerAndBooking('DRIVER_ASSIGNED', -10); // Expired 10s ago

    const group = await createTestSharedGroup([p1, p2], 'DRIVER_ASSIGNED');
    await materializeTripForGroup(group, [p1, p2]);

    await bookingsService.cancelBooking(
      { id: p1.user.id, role: 'PASSENGER' },
      p1.bookingId,
      { reason: 'Emergency' },
    );

    // Surviving booking p2 must be EXPIRED because maxWaitDeadline has passed
    const survivingBooking = await prisma.booking.findUnique({
      where: { id: p2.bookingId },
    });
    expect(survivingBooking!.status).toBe('EXPIRED');
  });

  it('8. All passengers declared NO_SHOW cancels trip and releases driver assignment', async () => {
    const p1 = await createTestPassengerAndBooking('DRIVER_ARRIVED');
    const group = await createTestSharedGroup([p1], 'DRIVER_ASSIGNED');
    const { trip, assignment, driverUser, driverProfile } =
      await materializeTripForGroup(group, [p1]);

    // Declare no-show for the only passenger
    const result = await tripsService.declareNoShow(
      driverUser.id,
      trip.id,
      p1.user.id,
    );
    expect(result.status).toBe('NO_SHOW');

    // Trip must transition to CANCELLED
    const updatedTrip = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(updatedTrip!.status).toBe('CANCELLED');

    // Ride group dissolved
    const updatedGroup = await prisma.rideGroup.findUnique({ where: { id: group.id } });
    expect(updatedGroup!.status).toBe('DISSOLVED');

    // Driver assignment released
    const updatedAssignment = await prisma.driverAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(updatedAssignment!.status).toBe('RELEASED');

    // Driver profile available
    const driver = await prisma.driverProfile.findUnique({
      where: { id: driverProfile.id },
    });
    expect(driver!.operationalStatus).toBe('AVAILABLE');
  });

  it('9. Concurrent cancellation vs no-show race condition allows only one winner', async () => {
    const p = await createTestPassengerAndBooking('DRIVER_ARRIVED');
    const group = await createTestSharedGroup([p], 'DRIVER_ASSIGNED');
    const { trip, driverUser } = await materializeTripForGroup(group, [p]);

    // Launch cancellation and no-show simultaneously
    const [cancResult, noShowResult] = await Promise.allSettled([
      bookingsService.cancelBooking(
        { id: p.user.id, role: 'PASSENGER' },
        p.bookingId,
        { reason: 'Race cancellation' },
      ),
      tripsService.declareNoShow(driverUser.id, trip.id, p.user.id),
    ]);

    // Exactly one operation must succeed and the other must be rejected
    const succeeded = [cancResult, noShowResult].filter((r) => r.status === 'fulfilled');
    const rejected = [cancResult, noShowResult].filter((r) => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one ₹30 fee recorded in cancellation_fees
    const fees = await prisma.cancellationFee.findMany({
      where: { originalBookingId: p.bookingId },
    });
    expect(fees).toHaveLength(1);
    expect(fees[0].amountPaise).toBe(3000);
  });

  it('10. Fee creation idempotency: cannot assess double fee on duplicate cancellation', async () => {
    const { user, bookingId } = await createTestPassengerAndBooking('DRIVER_ASSIGNED');

    await bookingsService.cancelBooking(
      { id: user.id, role: 'PASSENGER' },
      bookingId,
      { reason: 'First cancellation' },
    );

    // Second call must be rejected
    await expect(
      bookingsService.cancelBooking(
        { id: user.id, role: 'PASSENGER' },
        bookingId,
        { reason: 'Duplicate cancellation' },
      ),
    ).rejects.toThrow(BadRequestException);

    // Exactly one fee exists
    const fees = await prisma.cancellationFee.findMany({
      where: { originalBookingId: bookingId },
    });
    expect(fees).toHaveLength(1);
  });
});
