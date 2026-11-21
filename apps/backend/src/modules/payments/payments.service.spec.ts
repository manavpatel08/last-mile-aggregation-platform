import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PaymentsService } from './payments.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { IdempotencyClaimContext } from '../../common/interceptors/idempotency.interceptor.js';

describe('Stage 8 — Phase 4: Cash Confirmation & Payment Allocation Ledger', () => {
  const prisma = new PrismaClient();
  let paymentsService: PaymentsService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdRecordIds: string[] = [];

  let testPickupPointId: string;
  let adminUser: { id: string };

  beforeAll(async () => {
    const prismaService = new PrismaService();
    await prismaService.onModuleInit();
    paymentsService = new PaymentsService(prismaService);

    // Admin user
    adminUser = await prisma.user.create({
      data: {
        email: `pay-admin-${Date.now()}@pdeu.ac.in`,
        fullName: 'Test Admin User',
        role: 'ADMIN',
      },
    });
    createdUserIds.push(adminUser.id);

    // 1. Pickup point
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

  afterAll(async () => {
    // Delete idempotency records
    if (createdRecordIds.length > 0) {
      await prisma.idempotencyRecord
        .deleteMany({ where: { id: { in: createdRecordIds } } })
        .catch(() => {});
    }

    await prisma.outboxEvent
      .deleteMany({
        where: {
          aggregateType: { in: ['CASH_COLLECTION', 'CANCELLATION_FEE'] },
        },
      })
      .catch(() => {});

    // Delete trip cascades
    for (const tripId of createdTripIds) {
      await prisma.paymentAllocation
        .deleteMany({
          where: { cashCollection: { tripId } },
        })
        .catch(() => {});
      await prisma.cashCollection
        .deleteMany({ where: { tripId } })
        .catch(() => {});
      await prisma.tripPassenger
        .deleteMany({ where: { tripId } })
        .catch(() => {});
      await prisma.tripStatusHistory
        .deleteMany({ where: { tripId } })
        .catch(() => {});
      await prisma.trip.deleteMany({ where: { id: tripId } }).catch(() => {});
    }

    // Delete booking cascades
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

    // Delete groups and assignments
    for (const groupId of createdGroupIds) {
      await prisma.driverAssignment
        .deleteMany({ where: { rideGroupId: groupId } })
        .catch(() => {});
      await prisma.dispatchAttempt
        .deleteMany({ where: { rideGroupId: groupId } })
        .catch(() => {});
      await prisma.rideGroup
        .deleteMany({ where: { id: groupId } })
        .catch(() => {});
    }

    // Delete users & profiles
    for (const userId of createdUserIds) {
      await prisma.fareQuote
        .deleteMany({ where: { passengerId: userId } })
        .catch(() => {});
      await prisma.cancellationFee
        .deleteMany({ where: { passengerId: userId } })
        .catch(() => {});
      await prisma.idempotencyRecord
        .deleteMany({ where: { userId } })
        .catch(() => {});
      const driver = await prisma.driverProfile.findUnique({
        where: { userId },
      });
      if (driver) {
        await prisma.vehicle
          .deleteMany({ where: { driverProfileId: driver.id } })
          .catch(() => {});
        await prisma.driverProfile
          .delete({ where: { id: driver.id } })
          .catch(() => {});
      }
      await prisma.passengerProfile
        .deleteMany({ where: { userId } })
        .catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }

    await prisma.$disconnect();
  });

  // Helper to create a test driver
  async function createTestDriver(
    label: string,
    verificationStatus: 'APPROVED' | 'PENDING' = 'APPROVED',
  ) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const user = await prisma.user.create({
      data: {
        email: `pay-drv-${label}-${suffix}@pdeu.ac.in`,
        fullName: `Test Driver ${label}`,
        role: 'DRIVER',
      },
    });
    createdUserIds.push(user.id);

    const profile = await prisma.driverProfile.create({
      data: {
        userId: user.id,
        licenseNumber: `DL-PAY-${label.slice(0, 4)}-${suffix}`,
        verificationStatus,
        operationalStatus: verificationStatus === 'APPROVED' ? 'ACTIVE' : 'OFFLINE',
        isOnline: verificationStatus === 'APPROVED',
      },
    });

    if (verificationStatus === 'APPROVED') {
      await prisma.vehicle.create({
        data: {
          driverProfileId: profile.id,
          registrationNumber: `GJ-18-${label.slice(0, 2).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`,
          makeModel: 'Mahindra Treo',
          passengerCapacity: 4,
          isActive: true,
        },
      });
    }

    return { user, profile };
  }

  // Helper to create a passenger user
  async function createTestPassenger(label: string) {
    const user = await prisma.user.create({
      data: {
        email: `pax-${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}@pdeu.ac.in`,
        fullName: `Test Passenger ${label}`,
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(user.id);
    await prisma.passengerProfile.create({ data: { userId: user.id } });
    return user;
  }

  // Helper to create a test booking
  async function createTestBooking(passengerId: string, status = 'CONFIRMED') {
    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise, shared_max_fare_paise,
        agreed_fare_ceiling_paise, tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${passengerId}::uuid, ${testPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
        4400, 600, 6000, 2000, 6000, 6000, 1, NOW() + INTERVAL '10 minutes'
      ) RETURNING id;
    `;

    const [inserted] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status, agreed_fare_ceiling_paise,
        max_wait_deadline, created_at
      ) VALUES (
        gen_random_uuid(),
        ${passengerId}::uuid,
        ${quote.id}::uuid,
        ${testPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
        'SHARED', 2, ${status}, 6000,
        NOW() + INTERVAL '2 minutes', NOW()
      ) RETURNING id;
    `;
    createdBookingIds.push(inserted.id);
    return inserted.id;
  }

  // Helper to create full ride group, assignment, and trip
  async function createTripWithPassenger(options: {
    driverProfileId?: string;
    driverUserId?: string;
    passengerId: string;
    passengerStatus?: string;
    finalRideFarePaise?: number;
    waitingChargePaise?: number;
    tripStatus?: string;
  }) {
    const {
      passengerId,
      passengerStatus = 'COMPLETED',
      finalRideFarePaise = 2500,
      waitingChargePaise = 0,
      tripStatus = 'IN_PROGRESS',
    } = options;

    let driverProfileId = options.driverProfileId;
    let driverUserId = options.driverUserId;

    if (!driverProfileId) {
      const driver = await createTestDriver('asg');
      driverProfileId = driver.profile.id;
      driverUserId = driver.user.id;
    }

    const bookingId = await createTestBooking(passengerId);

    // Ride Group
    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: testPickupPointId,
        status: 'DISPATCHED',
        groupVersion: 1,
        totalSharedFarePaise: finalRideFarePaise,
        totalRouteDistanceMeters: 4500,
        totalRouteDurationSec: 650,
      },
    });
    createdGroupIds.push(group.id);

    await prisma.groupMember.create({
      data: {
        rideGroupId: group.id,
        bookingId,
        dropoffSequenceOrder: 1,
        directDistanceMeters: 4000,
        directDurationSec: 600,
        sharedDurationSec: 700,
        calculatedDetourPercent: 16.67,
        allocatedFarePaise: finalRideFarePaise,
        isActiveMember: true,
      },
    });

    const dispatchAttempt = await prisma.dispatchAttempt.create({
      data: {
        rideGroupId: group.id,
        attemptNumber: 1,
        groupVersion: 1,
        status: 'ACCEPTED',
      },
    });

    const assignment = await prisma.driverAssignment.create({
      data: {
        rideGroupId: group.id,
        driverId: driverProfileId,
        dispatchAttemptId: dispatchAttempt.id,
        status: 'ACTIVE',
      },
    });

    // Trip
    const trip = await prisma.trip.create({
      data: {
        rideGroupId: group.id,
        driverAssignmentId: assignment.id,
        activeDriverId: driverProfileId,
        status: tripStatus,
      },
    });
    createdTripIds.push(trip.id);

    // Trip Passenger
    const tripPassenger = await prisma.tripPassenger.create({
      data: {
        tripId: trip.id,
        passengerId,
        bookingId,
        status: passengerStatus,
        finalRideFarePaise,
        waitingChargePaise,
      },
    });

    return {
      trip,
      tripPassenger,
      bookingId,
      driverProfileId,
      driverUserId: driverUserId!,
    };
  }

  // 1. Successful driver cash confirmation
  it('1. Successfully confirms cash, allocates ride fare and waiting charges, and records outbox event', async () => {
    const passenger = await createTestPassenger('p1');
    const { trip, tripPassenger, driverUserId, driverProfileId } =
      await createTripWithPassenger({
        passengerId: passenger.id,
        passengerStatus: 'COMPLETED',
        finalRideFarePaise: 2500,
        waitingChargePaise: 500,
      });

    // Expected total: 2500 + 500 = 3000 paise (₹30.00)
    const result = await paymentsService.confirmCash(driverUserId, {
      tripId: trip.id,
      tripPassengerId: tripPassenger.id,
      amountCollectedPaise: 3000,
    });

    expect(result.tripId).toBe(trip.id);
    expect(result.tripPassengerId).toBe(tripPassenger.id);
    expect(result.driverId).toBe(driverProfileId);
    expect(result.totalCashCollectedPaise).toBe(3000);
    expect(result.totalCashCollected).toBe('30.00');
    expect(result.rideFarePaise).toBe(2500);
    expect(result.rideFare).toBe('25.00');
    expect(result.waitingChargePaise).toBe(500);
    expect(result.waitingCharge).toBe('5.00');
    expect(result.surchargeFeesPaise).toBe(0);
    expect(result.surchargeFees).toBe('0.00');
    expect(result.paymentStatus).toBe('PAID');

    // Allocations check
    expect(result.paymentAllocations).toHaveLength(2);
    const rideFareAlloc = result.paymentAllocations.find(
      (a) => a.obligationType === 'RIDE_FARE',
    );
    const waitingAlloc = result.paymentAllocations.find(
      (a) => a.obligationType === 'WAITING_CHARGE',
    );
    expect(rideFareAlloc?.allocatedAmountPaise).toBe(2500);
    expect(waitingAlloc?.allocatedAmountPaise).toBe(500);

    // Verify DB CashCollection row
    const dbCollection = await prisma.cashCollection.findUnique({
      where: { tripPassengerId: tripPassenger.id },
      include: { paymentAllocations: true },
    });
    expect(dbCollection).toBeDefined();
    expect(dbCollection?.totalCashCollectedPaise).toBe(3000);
    expect(dbCollection?.paymentAllocations).toHaveLength(2);

    // Verify OutboxEvent
    const outbox = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: dbCollection?.id,
        eventType: 'CASH_PAYMENT_CONFIRMED',
      },
    });
    expect(outbox).toBeDefined();
    expect((outbox?.payload as any)?.totalCashCollectedPaise).toBe(3000);
  });

  // 2. Unauthorized / non-approved driver rejection (403)
  it('2. Rejects confirmation when caller has no driver profile or is not APPROVED (403)', async () => {
    const passenger = await createTestPassenger('p2');
    const { trip, tripPassenger } = await createTripWithPassenger({
      passengerId: passenger.id,
      passengerStatus: 'COMPLETED',
      finalRideFarePaise: 2500,
    });

    const unapproved = await createTestDriver('unapp', 'PENDING');

    // Caller is a passenger (no driver profile)
    await expect(
      paymentsService.confirmCash(passenger.id, {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 2500,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Caller is an unapproved driver (PENDING)
    await expect(
      paymentsService.confirmCash(unapproved.user.id, {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 2500,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  // 3. Wrong driver for trip rejection (403)
  it('3. Rejects confirmation when approved driver is not assigned to the trip (403)', async () => {
    const passenger = await createTestPassenger('p3');
    const { trip, tripPassenger } = await createTripWithPassenger({
      passengerId: passenger.id,
      passengerStatus: 'COMPLETED',
      finalRideFarePaise: 2000,
    });

    const otherDriver = await createTestDriver('other');

    // otherDriver is approved, but not assigned to this trip
    await expect(
      paymentsService.confirmCash(otherDriver.user.id, {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 2000,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  // 4. Wrong passenger / trip mismatch (400)
  it('4. Rejects confirmation when tripPassengerId does not belong to specified trip (400)', async () => {
    const passenger1 = await createTestPassenger('p4-a');
    const passenger2 = await createTestPassenger('p4-b');

    const trip1Data = await createTripWithPassenger({
      passengerId: passenger1.id,
      passengerStatus: 'COMPLETED',
      finalRideFarePaise: 2000,
    });

    const trip2Data = await createTripWithPassenger({
      passengerId: passenger2.id,
      passengerStatus: 'COMPLETED',
      finalRideFarePaise: 2000,
    });

    // Cross-match: trip 1 with passenger from trip 2
    await expect(
      paymentsService.confirmCash(trip1Data.driverUserId, {
        tripId: trip1Data.trip.id,
        tripPassengerId: trip2Data.tripPassenger.id,
        amountCollectedPaise: 2000,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // 5. Permitted lifecycle check: rejection when trip_passengers.status !== 'COMPLETED' (400)
  it('5. Rejects confirmation when passenger status is not COMPLETED (e.g. BOARDED, SCHEDULED) (400)', async () => {
    const passenger = await createTestPassenger('p5');
    const { trip, tripPassenger, driverUserId } =
      await createTripWithPassenger({
        passengerId: passenger.id,
        passengerStatus: 'BOARDED', // Not yet dropped off
        finalRideFarePaise: 2200,
      });

    await expect(
      paymentsService.confirmCash(driverUserId, {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 2200,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // 6. Amount mismatch rejection (INVALID_COLLECTION_AMOUNT 400)
  it('6. Rejects confirmation when amount collected does not match authoritative calculation (400)', async () => {
    const passenger = await createTestPassenger('p6');
    const { trip, tripPassenger, driverUserId } =
      await createTripWithPassenger({
        passengerId: passenger.id,
        passengerStatus: 'COMPLETED',
        finalRideFarePaise: 2500,
        waitingChargePaise: 500,
      });

    // Authoritative total: 3000 paise. Underpayment attempt: 2500
    await expect(
      paymentsService.confirmCash(driverUserId, {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 2500,
      }),
    ).rejects.toThrow(BadRequestException);

    // Overpayment attempt: 3500
    await expect(
      paymentsService.confirmCash(driverUserId, {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 3500,
      }),
    ).rejects.toThrow(BadRequestException);

    // Verify no collection was written
    const dbCollection = await prisma.cashCollection.findUnique({
      where: { tripPassengerId: tripPassenger.id },
    });
    expect(dbCollection).toBeNull();
  });

  // 7. Multiple outstanding fees collected in single transaction
  it('7. Atomically recovers multiple outstanding fees, links collectedBookingId, and allocates exactly (surcharge recovery)', async () => {
    const passenger = await createTestPassenger('p7');

    // Create 2 earlier cancelled bookings with OUTSTANDING late cancellation fees
    const origBooking1 = await createTestBooking(passenger.id, 'CANCELLED');
    const fee1 = await prisma.cancellationFee.create({
      data: {
        passengerId: passenger.id,
        originalBookingId: origBooking1,
        amountPaise: 3000,
        status: 'OUTSTANDING',
      },
    });

    const origBooking2 = await createTestBooking(passenger.id, 'CANCELLED');
    const fee2 = await prisma.cancellationFee.create({
      data: {
        passengerId: passenger.id,
        originalBookingId: origBooking2,
        amountPaise: 3000,
        status: 'OUTSTANDING',
      },
    });

    // Active trip: fare = 2000, waiting = 0.
    // Total payable: 2000 + 3000 + 3000 = 8000 paise (₹80.00)
    const { trip, tripPassenger, bookingId, driverUserId } =
      await createTripWithPassenger({
        passengerId: passenger.id,
        passengerStatus: 'COMPLETED',
        finalRideFarePaise: 2000,
        waitingChargePaise: 0,
      });

    const result = await paymentsService.confirmCash(driverUserId, {
      tripId: trip.id,
      tripPassengerId: tripPassenger.id,
      amountCollectedPaise: 8000,
    });

    expect(result.totalCashCollectedPaise).toBe(8000);
    expect(result.rideFarePaise).toBe(2000);
    expect(result.surchargeFeesPaise).toBe(6000);
    expect(result.collectedFeeIds).toHaveLength(2);
    expect(result.collectedFeeIds).toContain(fee1.id);
    expect(result.collectedFeeIds).toContain(fee2.id);

    // Verify cancellation fees in database are now COLLECTED and linked to current bookingId
    const updatedFee1 = await prisma.cancellationFee.findUnique({
      where: { id: fee1.id },
    });
    const updatedFee2 = await prisma.cancellationFee.findUnique({
      where: { id: fee2.id },
    });
    expect(updatedFee1?.status).toBe('COLLECTED');
    expect(updatedFee1?.collectedBookingId).toBe(bookingId);
    expect(updatedFee1?.collectedAt).not.toBeNull();

    expect(updatedFee2?.status).toBe('COLLECTED');
    expect(updatedFee2?.collectedBookingId).toBe(bookingId);
    expect(updatedFee2?.collectedAt).not.toBeNull();

    // Verify payment allocations: 1 RIDE_FARE, 2 CANCELLATION_FEE_SURCHARGE
    expect(result.paymentAllocations).toHaveLength(3);
    const surchargeAllocs = result.paymentAllocations.filter(
      (a) => a.obligationType === 'CANCELLATION_FEE_SURCHARGE',
    );
    expect(surchargeAllocs).toHaveLength(2);
    expect(surchargeAllocs.map((a) => a.obligationEntityId)).toContain(fee1.id);
    expect(surchargeAllocs.map((a) => a.obligationEntityId)).toContain(fee2.id);
  });

  // 8. Re-execution protection (enforces single collection per journey, rejecting subsequent attempts with 409 Conflict)
  it('8. Completes with claim context and strictly rejects subsequent collection attempts with 409 Conflict', async () => {
    const passenger = await createTestPassenger('p8');
    const { trip, tripPassenger, driverUserId } =
      await createTripWithPassenger({
        passengerId: passenger.id,
        passengerStatus: 'COMPLETED',
        finalRideFarePaise: 2200,
      });

    const idempotencyKey1 = `pay-idemp-1-${Date.now()}`;
    const ownerToken1 = crypto.randomUUID();
    const idempRecord1 = await prisma.idempotencyRecord.create({
      data: {
        userId: driverUserId,
        idempotencyKey: idempotencyKey1,
        requestPath: 'POST /api/v1/payments/confirm-cash',
        requestHash: 'testhash1',
        status: 'IN_PROGRESS',
        ownerToken: ownerToken1,
        lockedUntil: new Date(Date.now() + 60000),
        version: 1,
      },
    });
    createdRecordIds.push(idempRecord1.id);

    const claim1: IdempotencyClaimContext = {
      id: idempRecord1.id,
      ownerToken: ownerToken1,
      idempotencyKey: idempotencyKey1,
      userId: driverUserId,
    };

    // First call: executes and completes
    const result1 = await paymentsService.confirmCash(
      driverUserId,
      {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 2200,
      },
      claim1,
    );
    expect(result1.collectionId).toBeDefined();

    // Verify claim1 was completed in database
    const completedClaim = await prisma.idempotencyRecord.findUnique({
      where: { id: idempRecord1.id },
    });
    expect(completedClaim?.status).toBe('COMPLETED');

    // Subsequent call with new claim or without claim throws 409 ConflictException
    await expect(
      paymentsService.confirmCash(driverUserId, {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 2200,
      }),
    ).rejects.toThrow(ConflictException);

    // Verify only ONE collection exists in database
    const totalCollections = await prisma.cashCollection.count({
      where: { tripPassengerId: tripPassenger.id },
    });
    expect(totalCollections).toBe(1);
  });

  // 9. Concurrent collection race condition (enforces single collection per journey via unique index and locking)
  it('9. Enforces single collection per journey under concurrent collection attempts', async () => {
    const passenger = await createTestPassenger('p9');
    const { trip, tripPassenger, driverUserId } =
      await createTripWithPassenger({
        passengerId: passenger.id,
        passengerStatus: 'COMPLETED',
        finalRideFarePaise: 2400,
      });

    // Launch two concurrent collection calls simultaneously
    const call1 = paymentsService.confirmCash(driverUserId, {
      tripId: trip.id,
      tripPassengerId: tripPassenger.id,
      amountCollectedPaise: 2400,
    });

    const call2 = paymentsService.confirmCash(driverUserId, {
      tripId: trip.id,
      tripPassengerId: tripPassenger.id,
      amountCollectedPaise: 2400,
    });

    const results = await Promise.allSettled([call1, call2]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);

    // The failing call must be ConflictException or Unique violation
    const err = (failed[0] as PromiseRejectedResult).reason;
    expect(
      err instanceof ConflictException ||
        (err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'),
    ).toBe(true);

    // Exactly 1 cash collection in database
    const dbCount = await prisma.cashCollection.count({
      where: { tripPassengerId: tripPassenger.id },
    });
    expect(dbCount).toBe(1);
  });

  // 10. Sum of allocations strictly equals total cash collected
  it('10. Financial ledger invariant: sum of payment allocations strictly equals total cash collected', async () => {
    const passenger = await createTestPassenger('p10');

    // Create 1 fee = 3000
    const origBooking = await createTestBooking(passenger.id, 'CANCELLED');
    await prisma.cancellationFee.create({
      data: {
        passengerId: passenger.id,
        originalBookingId: origBooking,
        amountPaise: 3000,
        status: 'OUTSTANDING',
      },
    });

    // Fare = 2500, Waiting = 1000, Fee = 3000 => Total = 6500
    const { trip, tripPassenger, driverUserId } =
      await createTripWithPassenger({
        passengerId: passenger.id,
        passengerStatus: 'COMPLETED',
        finalRideFarePaise: 2500,
        waitingChargePaise: 1000,
      });

    const result = await paymentsService.confirmCash(driverUserId, {
      tripId: trip.id,
      tripPassengerId: tripPassenger.id,
      amountCollectedPaise: 6500,
    });

    const allocations = await prisma.paymentAllocation.findMany({
      where: { cashCollectionId: result.collectionId },
    });

    const allocatedSum = allocations.reduce(
      (sum, a) => sum + a.allocatedAmountPaise,
      0,
    );
    expect(allocatedSum).toBe(result.totalCashCollectedPaise);
    expect(allocatedSum).toBe(6500);
  });

  // 11. No-show journey cash collection rejection
  it('11. Rejects cash collection for a NO_SHOW passenger journey (400)', async () => {
    const passenger = await createTestPassenger('p11');
    const { trip, tripPassenger, driverUserId } =
      await createTripWithPassenger({
        passengerId: passenger.id,
        passengerStatus: 'NO_SHOW',
        finalRideFarePaise: 0,
        waitingChargePaise: 0,
      });

    await expect(
      paymentsService.confirmCash(driverUserId, {
        tripId: trip.id,
        tripPassengerId: tripPassenger.id,
        amountCollectedPaise: 0,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // 12. Admin successfully waives an outstanding cancellation fee
  it('12. Successfully waives outstanding fee, records admin audit metadata, and emits outbox event', async () => {
    const passenger = await createTestPassenger('p12');
    const bookingId = await createTestBooking(passenger.id, 'CANCELLED');
    const fee = await prisma.cancellationFee.create({
      data: {
        passengerId: passenger.id,
        originalBookingId: bookingId,
        amountPaise: 3000,
        status: 'OUTSTANDING',
      },
    });

    const result = await paymentsService.waiveCancellationFee(
      adminUser.id,
      fee.id,
      { waiverReason: 'Verified campus medical emergency' },
    );

    expect(result.feeId).toBe(fee.id);
    expect(result.passengerId).toBe(passenger.id);
    expect(result.originalBookingId).toBe(bookingId);
    expect(result.amountPaise).toBe(3000);
    expect(result.amount).toBe('30.00');
    expect(result.status).toBe('WAIVED');
    expect(result.waivedByUserId).toBe(adminUser.id);
    expect(result.waiverReason).toBe('Verified campus medical emergency');
    expect(result.waivedAt).not.toBeNull();

    // Verify DB row
    const dbFee = await prisma.cancellationFee.findUnique({
      where: { id: fee.id },
    });
    expect(dbFee?.status).toBe('WAIVED');
    expect(dbFee?.waivedByUserId).toBe(adminUser.id);
    expect(dbFee?.waiverReason).toBe('Verified campus medical emergency');
    expect(dbFee?.waivedAt).not.toBeNull();

    // Verify OutboxEvent
    const outbox = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: fee.id,
        eventType: 'CANCELLATION_FEE_WAIVED',
      },
    });
    expect(outbox).toBeDefined();
    expect((outbox?.payload as any)?.waiverReason).toBe('Verified campus medical emergency');
  });

  // 13. Unauthorized access (non-admin user)
  it('13. Rejects waiver attempt by non-admin user with 403 Forbidden', async () => {
    const passenger = await createTestPassenger('p13');
    const bookingId = await createTestBooking(passenger.id, 'CANCELLED');
    const fee = await prisma.cancellationFee.create({
      data: {
        passengerId: passenger.id,
        originalBookingId: bookingId,
        amountPaise: 3000,
        status: 'OUTSTANDING',
      },
    });

    // Calling with passenger ID
    await expect(
      paymentsService.waiveCancellationFee(passenger.id, fee.id, {
        waiverReason: 'Valid reason',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  // 14. Invalid / empty waiver reason
  it('14. Rejects waiver with empty or whitespace-only reason with 400 Bad Request', async () => {
    const passenger = await createTestPassenger('p14');
    const bookingId = await createTestBooking(passenger.id, 'CANCELLED');
    const fee = await prisma.cancellationFee.create({
      data: {
        passengerId: passenger.id,
        originalBookingId: bookingId,
        amountPaise: 3000,
        status: 'OUTSTANDING',
      },
    });

    await expect(
      paymentsService.waiveCancellationFee(adminUser.id, fee.id, {
        waiverReason: '   ',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // 15. Fee not found
  it('15. Rejects waiver of non-existent fee with 404 Not Found', async () => {
    await expect(
      paymentsService.waiveCancellationFee(
        adminUser.id,
        crypto.randomUUID(),
        { waiverReason: 'Valid reason' },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // 16. Already-settled / COLLECTED fee rejection
  it('16. Rejects waiver of an already-collected fee with 400 Bad Request', async () => {
    const passenger = await createTestPassenger('p16');
    const origBooking = await createTestBooking(passenger.id, 'CANCELLED');
    const collectedBooking = await createTestBooking(passenger.id, 'COMPLETED');
    const fee = await prisma.cancellationFee.create({
      data: {
        passengerId: passenger.id,
        originalBookingId: origBooking,
        amountPaise: 3000,
        status: 'COLLECTED',
        collectedBookingId: collectedBooking,
        collectedAt: new Date(),
      },
    });

    await expect(
      paymentsService.waiveCancellationFee(adminUser.id, fee.id, {
        waiverReason: 'Trying to waive after collected',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // 17. Safe handling of repeated waiver attempts (keeps original metadata immutable)
  it('17. Handles repeated waiver attempts safely, preserving original waiver metadata without overwrite', async () => {
    const passenger = await createTestPassenger('p17');
    const bookingId = await createTestBooking(passenger.id, 'CANCELLED');
    const fee = await prisma.cancellationFee.create({
      data: {
        passengerId: passenger.id,
        originalBookingId: bookingId,
        amountPaise: 3000,
        status: 'OUTSTANDING',
      },
    });

    // First waiver
    const firstWaiver = await paymentsService.waiveCancellationFee(
      adminUser.id,
      fee.id,
      { waiverReason: 'Original reason A' },
    );
    expect(firstWaiver.status).toBe('WAIVED');
    expect(firstWaiver.waiverReason).toBe('Original reason A');

    // Second waiver attempt (e.g. concurrent or retry with different reason)
    const secondWaiver = await paymentsService.waiveCancellationFee(
      adminUser.id,
      fee.id,
      { waiverReason: 'Different reason B' },
    );
    expect(secondWaiver.status).toBe('WAIVED');
    expect(secondWaiver.alreadyWaived).toBe(true);
    // Preserved original reason
    expect(secondWaiver.waiverReason).toBe('Original reason A');
    expect(secondWaiver.waivedAt).toBe(firstWaiver.waivedAt);

    // Verify DB still holds original reason
    const dbFee = await prisma.cancellationFee.findUnique({
      where: { id: fee.id },
    });
    expect(dbFee?.waiverReason).toBe('Original reason A');
  });
});
