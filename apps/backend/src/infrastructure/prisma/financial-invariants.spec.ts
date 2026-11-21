import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';

describe('Stage 8 Financial Invariants & Migration Safety', () => {
  const prisma = new PrismaClient();

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdTripIds: string[] = [];
  let testPickupPointId: string;
  let testDriverProfileId: string;

  beforeAll(async () => {
    // 1. Fetch or create test pickup point
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

    // 2. Create test driver
    const driverUser = await prisma.user.create({
      data: {
        email: `fin-driver-${Date.now()}@pdeu.ac.in`,
        fullName: 'Financial Invariant Test Driver',
        role: 'DRIVER',
      },
    });
    createdUserIds.push(driverUser.id);

    const driverProfile = await prisma.driverProfile.create({
      data: {
        userId: driverUser.id,
        licenseNumber: `GJ-FIN-${Date.now()}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    testDriverProfileId = driverProfile.id;

    await prisma.vehicle.create({
      data: {
        driverProfileId: testDriverProfileId,
        registrationNumber: `GJ-18-FN-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Mahindra Treo',
        passengerCapacity: 4,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    // Clean up in reverse dependency order
    for (const tripId of createdTripIds) {
      await prisma.paymentAllocation.deleteMany({
        where: { cashCollection: { tripId } },
      }).catch(() => {});
      await prisma.cashCollection.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.tripPassenger.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.trip.deleteMany({ where: { id: tripId } }).catch(() => {});
    }

    for (const bookingId of createdBookingIds) {
      await prisma.cancellationFee.deleteMany({
        where: {
          OR: [
            { originalBookingId: bookingId },
            { collectedBookingId: bookingId },
          ],
        },
      }).catch(() => {});
      await prisma.groupMember.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.bookingStatusHistory.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    }

    for (const groupId of createdGroupIds) {
      await prisma.driverAssignment.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.dispatchAttempt.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
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

  async function createTestBooking(
    passengerId: string,
    status = 'REQUESTED',
  ): Promise<string> {
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

    const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id, passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status, agreed_fare_ceiling_paise, max_wait_deadline
      ) VALUES (
        gen_random_uuid(), ${passengerId}::uuid, ${quote.id}::uuid, ${testPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
        'SHARED', 2, ${status}, 6000, NOW() + INTERVAL '2 minutes'
      ) RETURNING id;
    `;
    createdBookingIds.push(booking.id);
    return booking.id;
  }

  async function createTestPassenger(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `fin-pax-${Date.now()}-${Math.floor(Math.random() * 10000)}@pdeu.ac.in`,
        fullName: 'Financial Invariant Commuter',
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(user.id);
    await prisma.passengerProfile.create({ data: { userId: user.id } });
    return user.id;
  }

  async function setupTripAndPassenger(): Promise<{
    tripId: string;
    tripPassengerId: string;
    passengerId: string;
    bookingId: string;
    driverProfileId: string;
  }> {
    const driverUser = await prisma.user.create({
      data: {
        email: `fin-drv-${Date.now()}-${Math.floor(Math.random() * 10000)}@pdeu.ac.in`,
        fullName: 'Trip Test Driver',
        role: 'DRIVER',
      },
    });
    createdUserIds.push(driverUser.id);

    const driverProfile = await prisma.driverProfile.create({
      data: {
        userId: driverUser.id,
        licenseNumber: `GJ-TRP-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });

    await prisma.vehicle.create({
      data: {
        driverProfileId: driverProfile.id,
        registrationNumber: `GJ-18-TR-${Math.floor(1000 + Math.random() * 9000)}`,
        makeModel: 'Mahindra Treo',
        passengerCapacity: 4,
        isActive: true,
      },
    });

    const passengerId = await createTestPassenger();
    const bookingId = await createTestBooking(passengerId);

    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: testPickupPointId,
        rideType: 'SHARED',
        status: 'READY_FOR_DISPATCH',
        totalSharedFarePaise: 4000,
        totalRouteDistanceMeters: 4000,
        totalRouteDurationSec: 500,
      },
    });
    createdGroupIds.push(group.id);

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
        status: 'IN_PROGRESS',
      },
    });
    createdTripIds.push(trip.id);

    const tripPassenger = await prisma.tripPassenger.create({
      data: {
        tripId: trip.id,
        bookingId,
        passengerId,
        status: 'COMPLETED',
        finalRideFarePaise: 3800,
        waitingChargePaise: 0,
      },
    });

    return {
      tripId: trip.id,
      tripPassengerId: tripPassenger.id,
      passengerId,
      bookingId,
      driverProfileId: driverProfile.id,
    };
  }

  describe('PostgreSQL System Catalog & Index Introspection', () => {
    it('should verify idx_unique_cash_collection_trip_passenger exists as a unique index', async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'cash_collections' AND indexname = 'idx_unique_cash_collection_trip_passenger';
      `;

      expect(indexes.length).toBe(1);
      expect(indexes[0].indexdef).toContain('UNIQUE INDEX idx_unique_cash_collection_trip_passenger');
      expect(indexes[0].indexdef).toContain('(trip_passenger_id)');
    });

    it('should verify idx_unique_cancellation_fee_per_booking exists as a unique index', async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'cancellation_fees' AND indexname = 'idx_unique_cancellation_fee_per_booking';
      `;

      expect(indexes.length).toBe(1);
      expect(indexes[0].indexdef).toContain('UNIQUE INDEX idx_unique_cancellation_fee_per_booking');
      expect(indexes[0].indexdef).toContain('(original_booking_id)');
    });

    it('should verify idx_cancellation_fees_collected_booking exists for multi-fee querying', async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'cancellation_fees' AND indexname = 'idx_cancellation_fees_collected_booking';
      `;

      expect(indexes.length).toBe(1);
      expect(indexes[0].indexdef).toContain('idx_cancellation_fees_collected_booking');
    });

    it('should verify redundant partial unique index idx_unique_collected_booking_fee has been safely dropped', async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'cancellation_fees' AND indexname = 'idx_unique_collected_booking_fee';
      `;

      expect(indexes.length).toBe(0);
    });
  });

  describe('Database Invariant: Exactly One Cancellation Fee per Original Booking', () => {
    it('should successfully create a single cancellation fee for an original booking', async () => {
      const passengerId = await createTestPassenger();
      const bookingId = await createTestBooking(passengerId);

      const fee = await prisma.cancellationFee.create({
        data: {
          passengerId,
          originalBookingId: bookingId,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      expect(fee.id).toBeDefined();
      expect(fee.originalBookingId).toBe(bookingId);
      expect(fee.amountPaise).toBe(3000);
      expect(fee.status).toBe('OUTSTANDING');
    });

    it('should reject a duplicate sequential cancellation fee creation on the same booking at database level', async () => {
      const passengerId = await createTestPassenger();
      const bookingId = await createTestBooking(passengerId);

      // First insertion succeeds
      await prisma.cancellationFee.create({
        data: {
          passengerId,
          originalBookingId: bookingId,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      // Second insertion with same originalBookingId must fail with unique constraint violation
      await expect(
        prisma.cancellationFee.create({
          data: {
            passengerId,
            originalBookingId: bookingId,
            amountPaise: 3000,
            status: 'OUTSTANDING',
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });

    it('should enforce database-level protection under concurrent cancellation fee creation requests', async () => {
      const passengerId = await createTestPassenger();
      const bookingId = await createTestBooking(passengerId);

      // Execute 5 concurrent insertion requests
      const concurrentAttempts = Array.from({ length: 5 }, () =>
        prisma.cancellationFee.create({
          data: {
            passengerId,
            originalBookingId: bookingId,
            amountPaise: 3000,
            status: 'OUTSTANDING',
          },
        }),
      );

      const results = await Promise.allSettled(concurrentAttempts);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly ONE must succeed; all other 4 must be rejected by PostgreSQL unique constraint
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(4);

      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(
          Prisma.PrismaClientKnownRequestError,
        );
        expect(
          ((rej as PromiseRejectedResult).reason as Prisma.PrismaClientKnownRequestError).code,
        ).toBe('P2002');
      }
    });

    it('should allow multiple cancellation fees to reference the same collected_booking_id on next ride collection', async () => {
      const passengerId = await createTestPassenger();
      const booking1Id = await createTestBooking(passengerId, 'CANCELLED');
      const booking2Id = await createTestBooking(passengerId, 'CANCELLED');
      const nextBookingId = await createTestBooking(passengerId, 'REQUESTED');

      const fee1 = await prisma.cancellationFee.create({
        data: {
          passengerId,
          originalBookingId: booking1Id,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      const fee2 = await prisma.cancellationFee.create({
        data: {
          passengerId,
          originalBookingId: booking2Id,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      // Surcharge collection: Both fees are collected during nextBookingId
      const now = new Date();
      const updatedFee1 = await prisma.cancellationFee.update({
        where: { id: fee1.id },
        data: {
          status: 'COLLECTED',
          collectedBookingId: nextBookingId,
          collectedAt: now,
        },
      });

      const updatedFee2 = await prisma.cancellationFee.update({
        where: { id: fee2.id },
        data: {
          status: 'COLLECTED',
          collectedBookingId: nextBookingId,
          collectedAt: now,
        },
      });

      expect(updatedFee1.status).toBe('COLLECTED');
      expect(updatedFee2.status).toBe('COLLECTED');
      expect(updatedFee1.collectedBookingId).toBe(nextBookingId);
      expect(updatedFee2.collectedBookingId).toBe(nextBookingId);

      // Verify query by collected_booking_id returns both fees
      const collectedFees = await prisma.cancellationFee.findMany({
        where: { collectedBookingId: nextBookingId, status: 'COLLECTED' },
      });
      expect(collectedFees.length).toBe(2);
    });
  });

  describe('Database Invariant: Exactly One Cash Collection per Passenger Journey', () => {
    it('should successfully record cash collection for a passenger journey', async () => {
      const { tripId, tripPassengerId, driverProfileId } = await setupTripAndPassenger();

      const cash = await prisma.cashCollection.create({
        data: {
          tripId,
          driverId: driverProfileId,
          tripPassengerId,
          totalCashCollectedPaise: 3800,
          paymentStatus: 'PAID',
        },
      });

      expect(cash.id).toBeDefined();
      expect(cash.tripPassengerId).toBe(tripPassengerId);
      expect(cash.totalCashCollectedPaise).toBe(3800);
      expect(cash.paymentStatus).toBe('PAID');
    });

    it('should reject a duplicate sequential cash collection on the same trip passenger at database level', async () => {
      const { tripId, tripPassengerId, driverProfileId } = await setupTripAndPassenger();

      await prisma.cashCollection.create({
        data: {
          tripId,
          driverId: driverProfileId,
          tripPassengerId,
          totalCashCollectedPaise: 3800,
          paymentStatus: 'PAID',
        },
      });

      // Second insertion must fail with unique constraint violation
      await expect(
        prisma.cashCollection.create({
          data: {
            tripId,
            driverId: driverProfileId,
            tripPassengerId,
            totalCashCollectedPaise: 3800,
            paymentStatus: 'PAID',
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });

    it('should enforce database-level protection under concurrent cash collection requests (No Double Cash Record)', async () => {
      const { tripId, tripPassengerId, driverProfileId } = await setupTripAndPassenger();

      // Execute 5 concurrent insertion requests
      const concurrentAttempts = Array.from({ length: 5 }, () =>
        prisma.cashCollection.create({
          data: {
            tripId,
            driverId: driverProfileId,
            tripPassengerId,
            totalCashCollectedPaise: 3800,
            paymentStatus: 'PAID',
          },
        }),
      );

      const results = await Promise.allSettled(concurrentAttempts);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly ONE succeeds; remaining 4 fail with P2002
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(4);

      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(
          Prisma.PrismaClientKnownRequestError,
        );
        expect(
          ((rej as PromiseRejectedResult).reason as Prisma.PrismaClientKnownRequestError).code,
        ).toBe('P2002');
      }
    });

    it('should support atomic payment allocation link to the unique cash collection record', async () => {
      const { tripId, tripPassengerId, driverProfileId } = await setupTripAndPassenger();

      const cash = await prisma.cashCollection.create({
        data: {
          tripId,
          driverId: driverProfileId,
          tripPassengerId,
          totalCashCollectedPaise: 3800,
          paymentStatus: 'PAID',
        },
      });

      const allocation = await prisma.paymentAllocation.create({
        data: {
          cashCollectionId: cash.id,
          obligationType: 'RIDE_FARE',
          obligationEntityId: tripPassengerId,
          allocatedAmountPaise: 3800,
        },
      });

      expect(allocation.id).toBeDefined();
      expect(allocation.cashCollectionId).toBe(cash.id);
      expect(allocation.obligationType).toBe('RIDE_FARE');
      expect(allocation.allocatedAmountPaise).toBe(3800);
    });
  });
});
