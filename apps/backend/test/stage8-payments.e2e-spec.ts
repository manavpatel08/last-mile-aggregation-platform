import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';

describe('Stage 8 Payments, Cancellations & Surcharge Ledger (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdGroupIds: string[] = [];

  let passengerToken: string;
  let passengerUserId: string;

  let driverToken: string;
  let driverUserId: string;
  let driverProfileId: string;

  let adminToken: string;
  let adminUserId: string;

  let pdeuPickupPointId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'health/ready', 'health/live'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);

    // 1. Pickup Point
    let initialPickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    if (!initialPickup) {
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
      pdeuPickupPointId = newPickup.id;
    } else {
      pdeuPickupPointId = initialPickup.id;
    }

    const suffix = Date.now();

    // 2. Authenticated Passenger
    const pGoogleToken = `mock-google-id-token:sub-s8-pax-${suffix}:s8pax.${suffix}@pdeu.ac.in:Stage8 Passenger`;
    const pRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: pGoogleToken });
    passengerToken = pRes.body.data.accessToken;
    passengerUserId = pRes.body.data.user.id;
    createdUserIds.push(passengerUserId);

    // 3. Authenticated Driver
    const dGoogleToken = `mock-google-id-token:sub-s8-drv-${suffix}:s8drv.${suffix}@pdeu.ac.in:Stage8 Driver`;
    const dRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: dGoogleToken });
    driverToken = dRes.body.data.accessToken;
    driverUserId = dRes.body.data.user.id;
    createdUserIds.push(driverUserId);

    // Onboard Driver
    const onboardRes = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        licenseNumber: `DL-S8-E2E-${suffix}`,
        vehicle: {
          registrationNumber: `GJ-18-S8-${Math.floor(1000 + Math.random() * 9000)}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo Electric',
        },
      });
    driverProfileId = onboardRes.body.data.driverProfile.id;

    // Approve driver
    await prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });

    // 4. Authenticated Admin
    const adminUser = await prisma.user.create({
      data: {
        email: `s8-admin-${suffix}@pdeu.ac.in`,
        fullName: 'Stage 8 Admin',
        role: 'ADMIN',
        roles: {
          create: { roleName: 'ADMIN' },
        },
      },
    });
    adminUserId = adminUser.id;
    createdUserIds.push(adminUserId);

    const aGoogleToken = `mock-google-id-token:sub-s8-adm-${suffix}:${adminUser.email}:Stage 8 Admin`;
    const aRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: aGoogleToken });
    adminToken = aRes.body.data.accessToken;
  });

  afterAll(async () => {
    for (const tripId of createdTripIds) {
      await prisma.outboxEvent
        .deleteMany({
          where: {
            aggregateType: { in: ['CASH_COLLECTION', 'CANCELLATION_FEE'] },
          },
        })
        .catch(() => {});
      await prisma.paymentAllocation
        .deleteMany({ where: { cashCollection: { tripId } } })
        .catch(() => {});
      await prisma.cashCollection.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.tripIncident.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.tripStatusHistory.deleteMany({ where: { tripId } }).catch(() => {});
      const tp = await prisma.tripPassenger.findMany({ where: { tripId } }).catch(() => []);
      for (const p of tp) {
        await prisma.boardingVerification.deleteMany({ where: { tripPassengerId: p.id } }).catch(() => {});
      }
      await prisma.tripPassenger.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.trip.delete({ where: { id: tripId } }).catch(() => {});
    }

    for (const bookingId of createdBookingIds) {
      await prisma.cancellationFee.deleteMany({ where: { originalBookingId: bookingId } }).catch(() => {});
      await prisma.cancellationFee.deleteMany({ where: { collectedBookingId: bookingId } }).catch(() => {});
      await prisma.bookingStatusHistory.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.groupMember.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.matchingBatchBooking.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.booking.delete({ where: { id: bookingId } }).catch(() => {});
    }

    for (const groupId of createdGroupIds) {
      await prisma.driverAssignment.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.driverDispatchOffer.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.dispatchAttempt.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.groupRouteVersion.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.rideGroup.delete({ where: { id: groupId } }).catch(() => {});
    }

    for (const userId of createdUserIds) {
      await prisma.userSession.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.authIdentity.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.passengerProfile.deleteMany({ where: { userId } }).catch(() => {});
      const driver = await prisma.driverProfile.findUnique({ where: { userId } }).catch(() => null);
      if (driver) {
        await prisma.driverDocument.deleteMany({ where: { driverProfileId: driver.id } }).catch(() => {});
        await prisma.vehicle.deleteMany({ where: { driverProfileId: driver.id } }).catch(() => {});
        await prisma.driverProfile.delete({ where: { id: driver.id } }).catch(() => {});
      }
      await prisma.fareQuote.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.cancellationFee.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.idempotencyRecord.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.userRole.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }

    await app.close();
  });

  describe('Full Stage 8 End-to-End Flow: Surcharge Disclosure -> Drop-off -> Cash Confirmation', () => {
    let priorCancelledBookingId: string;
    let outstandingFeeId: string;
    let quoteId: string;
    let bookingId: string;
    let tripId: string;
    let tripPassengerId: string;
    const finalFarePaise = 2500; // ₹25.00
    const feeSurchargePaise = 3000; // ₹30.00
    const totalExpectedPaise = 5500; // ₹55.00

    it('Step 1: Clean passenger receives ₹0.00 surcharge in quote', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: { latitude: 23.1812, longitude: 72.6345 },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.outstandingLateFeeSurcharge).toBe('0.00');
      expect(res.body.data.outstandingLateFeeSurchargePaise).toBe(0);
      expect(res.body.data.totalCashToCollect).toBeDefined();
    });

    it('Step 2: After incurring late cancellation fee, subsequent quote discloses ₹30.00 surcharge separately', async () => {
      // Create prior cancelled booking with late cancellation fee
      const [oldQuote] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO fare_quotes (
          id, passenger_id, pickup_point_id, destination_location,
          direct_distance_meters, direct_duration_sec,
          private_estimated_fare_paise, shared_min_fare_paise, shared_max_fare_paise,
          agreed_fare_ceiling_paise, tariff_version, expires_at
        ) VALUES (
          gen_random_uuid(), ${passengerUserId}::uuid, ${pdeuPickupPointId}::uuid,
          ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
          4400, 600, 6000, 2000, 6000, 6000, 1, NOW() + INTERVAL '10 minutes'
        ) RETURNING id;
      `;

      const [oldBooking] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO bookings (
          id, passenger_id, fare_quote_id, pickup_point_id,
          passenger_pickup_location, destination_location,
          requested_type, min_group_preference, status, agreed_fare_ceiling_paise,
          max_wait_deadline, created_at
        ) VALUES (
          gen_random_uuid(), ${passengerUserId}::uuid, ${oldQuote.id}::uuid, ${pdeuPickupPointId}::uuid,
          ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
          ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
          'SHARED', 2, 'CANCELLED', 6000,
          NOW() + INTERVAL '2 minutes', NOW()
        ) RETURNING id;
      `;
      priorCancelledBookingId = oldBooking.id;
      createdBookingIds.push(priorCancelledBookingId);

      const fee = await prisma.cancellationFee.create({
        data: {
          passengerId: passengerUserId,
          originalBookingId: priorCancelledBookingId,
          amountPaise: feeSurchargePaise,
          status: 'OUTSTANDING',
        },
      });
      outstandingFeeId = fee.id;

      // Request new quote with outstanding fee
      const res = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: { latitude: 23.1812, longitude: 72.6345 },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.outstandingLateFeeSurcharge).toBe('30.00');
      expect(res.body.data.outstandingLateFeeSurchargePaise).toBe(3000);
      expect(res.body.data.totalCashToCollectPaise.privatePaise).toBeGreaterThan(3000);
      expect(res.body.data.totalCashToCollectPaise.sharedRangePaise.minFarePaise).toBeGreaterThan(3000);
      expect(res.body.data.agreedFareCeilingPaise).toBe(res.body.data.sharedEstimatedRangePaise.maxFarePaise);

      quoteId = res.body.data.quoteId;
    });

    it('Step 3: Passenger creates booking with the surcharge-disclosed quote', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.667 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      bookingId = res.body.data.bookingId;
      createdBookingIds.push(bookingId);
    });

    it('Step 4: Trip is materialized and driver completes passenger journey', async () => {
      // Group
      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          status: 'DISPATCHED',
          groupVersion: 1,
          totalSharedFarePaise: finalFarePaise,
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
          allocatedFarePaise: finalFarePaise,
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

      // Trip in progress
      const trip = await prisma.trip.create({
        data: {
          rideGroupId: group.id,
          driverAssignmentId: assignment.id,
          activeDriverId: driverProfileId,
          status: 'IN_PROGRESS',
        },
      });
      tripId = trip.id;
      createdTripIds.push(trip.id);

      // Trip passenger (status BOARDED)
      const tp = await prisma.tripPassenger.create({
        data: {
          tripId: trip.id,
          passengerId: passengerUserId,
          bookingId,
          status: 'BOARDED',
          finalRideFarePaise: finalFarePaise,
          waitingChargePaise: 0,
        },
      });
      tripPassengerId = tp.id;

      // Complete passenger drop-off via official endpoint
      const compRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${tripId}/passengers/${passengerUserId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      expect(compRes.body.success).toBe(true);

      const dbPassenger = await prisma.tripPassenger.findUnique({
        where: { id: tripPassengerId },
      });
      expect(dbPassenger?.status).toBe('COMPLETED');
    });

    it('Step 5: Driver attempts invalid cash collection amount -> rejected 400', async () => {
      // Underpayment attempt: ₹25.00 instead of ₹55.00 (ignoring surcharge)
      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/confirm-cash')
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          tripId,
          tripPassengerId,
          amountCollectedPaise: 2500,
        })
        .expect(400);

      expect(res.body.errorCode).toBe('INVALID_COLLECTION_AMOUNT');
    });

    it('Step 6: Driver confirms authoritative cash collection (₹25 fare + ₹30 fee surcharge = ₹55.00) -> 200 OK', async () => {
      const confirmKey = `e2e-pay-${Date.now()}`;

      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/confirm-cash')
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', confirmKey)
        .send({
          tripId,
          tripPassengerId,
          amountCollectedPaise: totalExpectedPaise,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.tripId).toBe(tripId);
      expect(data.tripPassengerId).toBe(tripPassengerId);
      expect(data.totalCashCollectedPaise).toBe(5500);
      expect(data.totalCashCollected).toBe('55.00');
      expect(data.rideFarePaise).toBe(2500);
      expect(data.rideFare).toBe('25.00');
      expect(data.surchargeFeesPaise).toBe(3000);
      expect(data.surchargeFees).toBe('30.00');
      expect(data.collectedFeeIds).toContain(outstandingFeeId);
      expect(data.paymentAllocations).toHaveLength(2);

      // Verify cancellation fee updated to COLLECTED
      const updatedFee = await prisma.cancellationFee.findUnique({
        where: { id: outstandingFeeId },
      });
      expect(updatedFee?.status).toBe('COLLECTED');
      expect(updatedFee?.collectedBookingId).toBe(bookingId);
      expect(updatedFee?.collectedAt).not.toBeNull();

      // Verify payment allocations in DB
      const allocations = await prisma.paymentAllocation.findMany({
        where: { cashCollectionId: data.collectionId },
      });
      expect(allocations).toHaveLength(2);
      const sum = allocations.reduce((s, a) => s + a.allocatedAmountPaise, 0);
      expect(sum).toBe(5500);

      // Verify outbox event
      const outbox = await prisma.outboxEvent.findFirst({
        where: { aggregateId: data.collectionId, eventType: 'CASH_PAYMENT_CONFIRMED' },
      });
      expect(outbox).toBeDefined();

      // Step 7: Duplicate request with SAME Idempotency-Key returns cached 200
      const retryRes = await request(app.getHttpServer())
        .post('/api/v1/payments/confirm-cash')
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', confirmKey)
        .send({
          tripId,
          tripPassengerId,
          amountCollectedPaise: totalExpectedPaise,
        })
        .expect(200);

      expect(retryRes.body.success).toBe(true);
      expect(retryRes.body.data.collectionId).toBe(data.collectionId);

      // Step 8: Subsequent request with NEW Idempotency-Key returns 409 Conflict
      const secondRes = await request(app.getHttpServer())
        .post('/api/v1/payments/confirm-cash')
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          tripId,
          tripPassengerId,
          amountCollectedPaise: totalExpectedPaise,
        })
        .expect(409);

      expect(secondRes.body.errorCode).toBe('CASH_ALREADY_COLLECTED');
    });
  });

  describe('Phase 5 — Admin Cancellation Fee Waiver (e2e)', () => {
    let waiverTestBookingId: string;
    let waiverTestFeeId: string;

    beforeAll(async () => {
      // Create a cancelled booking with outstanding fee for passenger
      const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO fare_quotes (
          id, passenger_id, pickup_point_id, destination_location,
          direct_distance_meters, direct_duration_sec,
          private_estimated_fare_paise, shared_min_fare_paise, shared_max_fare_paise,
          agreed_fare_ceiling_paise, tariff_version, expires_at
        ) VALUES (
          gen_random_uuid(), ${passengerUserId}::uuid, ${pdeuPickupPointId}::uuid,
          ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
          4400, 600, 6000, 2000, 6000, 6000, 1, NOW() + INTERVAL '10 minutes'
        ) RETURNING id;
      `;

      const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO bookings (
          id, passenger_id, fare_quote_id, pickup_point_id,
          passenger_pickup_location, destination_location,
          requested_type, min_group_preference, status, agreed_fare_ceiling_paise,
          max_wait_deadline, created_at
        ) VALUES (
          gen_random_uuid(), ${passengerUserId}::uuid, ${quote.id}::uuid, ${pdeuPickupPointId}::uuid,
          ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
          ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
          'SHARED', 2, 'CANCELLED', 6000,
          NOW() + INTERVAL '2 minutes', NOW()
        ) RETURNING id;
      `;
      waiverTestBookingId = booking.id;
      createdBookingIds.push(waiverTestBookingId);

      const fee = await prisma.cancellationFee.create({
        data: {
          passengerId: passengerUserId,
          originalBookingId: waiverTestBookingId,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });
      waiverTestFeeId = fee.id;
    });

    it('Step 1: Non-admin users (passenger/driver) are rejected with 403 Forbidden', async () => {
      // Passenger caller
      await request(app.getHttpServer())
        .post(`/api/v1/admin/cancellation-fees/${waiverTestFeeId}/waive`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ waiverReason: 'Passenger trying to waive own fee' })
        .expect(403);

      // Driver caller
      await request(app.getHttpServer())
        .post(`/api/v1/admin/cancellation-fees/${waiverTestFeeId}/waive`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ waiverReason: 'Driver trying to waive fee' })
        .expect(403);
    });

    it('Step 2: Admin waiver requires a non-empty waiver reason (rejects blank with 400)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/cancellation-fees/${waiverTestFeeId}/waive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ waiverReason: '   ' })
        .expect(400);
    });

    it('Step 3: Admin successfully waives the outstanding fee -> 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/cancellation-fees/${waiverTestFeeId}/waive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ waiverReason: 'Verified medical emergency on campus' })
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.feeId).toBe(waiverTestFeeId);
      expect(data.status).toBe('WAIVED');
      expect(data.waivedByUserId).toBe(adminUserId);
      expect(data.waiverReason).toBe('Verified medical emergency on campus');
      expect(data.waivedAt).not.toBeNull();

      // Verify DB record
      const dbFee = await prisma.cancellationFee.findUnique({
        where: { id: waiverTestFeeId },
      });
      expect(dbFee?.status).toBe('WAIVED');
      expect(dbFee?.waivedByUserId).toBe(adminUserId);
      expect(dbFee?.waiverReason).toBe('Verified medical emergency on campus');
      expect(dbFee?.waivedAt).not.toBeNull();

      // Verify transactional outbox event
      const outbox = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: waiverTestFeeId,
          eventType: 'CANCELLATION_FEE_WAIVED',
        },
      });
      expect(outbox).toBeDefined();
    });

    it('Step 4: Repeated waiver attempt returns 200 OK preserving immutable original audit metadata', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/cancellation-fees/${waiverTestFeeId}/waive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ waiverReason: 'Second attempt with different reason' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('WAIVED');
      expect(res.body.data.alreadyWaived).toBe(true);
      // Original reason remains unchanged
      expect(res.body.data.waiverReason).toBe('Verified medical emergency on campus');
    });

    it('Step 5: Waived fee is excluded from passenger future quotes (surcharge = 0.00)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: { latitude: 23.1812, longitude: 72.6345 },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      // Now that the only fee is WAIVED, surcharge is ₹0.00
      expect(res.body.data.outstandingLateFeeSurcharge).toBe('0.00');
      expect(res.body.data.outstandingLateFeeSurchargePaise).toBe(0);
    });
  });
});
