import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { RoutingService } from '../src/modules/routing/routing.service.js';
import { MatchingService } from '../src/modules/matching/matching.service.js';
import { OutboxService } from '../src/infrastructure/outbox/outbox.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';
import { CACHE_KEYS } from '../src/common/constants/index.js';

describe('Stage 5 → Stage 6 Integrated End-to-End Pipeline (E2E)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redisService: RedisService;
  let routingService: RoutingService;
  let matchingService: MatchingService;
  let outboxService: OutboxService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdBatchIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdQuoteIds: string[] = [];

  let pdeuPickupPointId: string;

  let adminToken: string;
  let adminUserId: string;

  let driver1Token: string;
  let driver1UserId: string;
  let driver1ProfileId: string;

  let driver2Token: string;
  let driver2UserId: string;
  let driver2ProfileId: string;

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
    redisService = moduleFixture.get<RedisService>(RedisService);
    routingService = moduleFixture.get<RoutingService>(RoutingService);
    matchingService = moduleFixture.get<MatchingService>(MatchingService);
    outboxService = moduleFixture.get<OutboxService>(OutboxService);

    // 1. Pickup Point
    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    expect(pickup).toBeDefined();
    pdeuPickupPointId = pickup!.id;

    // 2. Mock RoutingService for corridor matching and driver ETA ranking
    vi.spyOn(routingService, 'getTravelTimeMatrix').mockImplementation(
      async (coords) => {
        const pickupIndex = coords.length - 1;
        const durations: number[][] = Array.from({ length: coords.length }, () =>
          Array.from({ length: coords.length }, () => 0),
        );
        const distances: number[][] = Array.from({ length: coords.length }, () =>
          Array.from({ length: coords.length }, () => 0),
        );

        for (let i = 0; i < coords.length; i++) {
          for (let j = 0; j < coords.length; j++) {
            if (i === j) continue;

            // Driver to pickup ranking
            if (j === pickupIndex) {
              const lat = coords[i].latitude;
              // Driver 1 (23.155) -> 60s ETA (Rank 1)
              // Driver 2 (23.158) -> 180s ETA (Rank 2)
              if (Math.abs(lat - 23.155) < 0.002) {
                durations[i][j] = 60;
                distances[i][j] = 500;
              } else {
                durations[i][j] = 180;
                distances[i][j] = 1500;
              }
            } else if (i === 0) {
              // Matching corridor durations from pickup to dropoffs
              durations[i][j] = 300 + j * 50;
              distances[i][j] = 4000 + j * 500;
            } else {
              const step = Math.abs(i - j);
              durations[i][j] = step * 60;
              distances[i][j] = step * 600;
            }
          }
        }

        return {
          durations,
          distances,
          source: 'OSRM',
          isFallback: false,
        };
      },
    );

    vi.spyOn(routingService, 'getMultiStopRoute').mockImplementation(
      async (waypoints) => {
        return {
          distanceMeters: 6200,
          durationSec: 540,
          geometry: {
            type: 'LineString',
            coordinates: waypoints.map((w) => [w.longitude, w.latitude]),
          },
          source: 'OSRM',
          isFallback: false,
        };
      },
    );

    // 3. Create Admin for driver approvals
    const adminUser = await prisma.user.create({
      data: {
        email: `stage56-adm-${Date.now()}@pdeu.ac.in`,
        fullName: 'Pipeline Admin',
        role: 'ADMIN',
        roles: { create: { roleName: 'ADMIN' } },
      },
    });
    adminUserId = adminUser.id;
    createdUserIds.push(adminUserId);

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({
        idToken: `mock-google-id-token:sub-adm-56:${adminUser.email}:Pipeline Admin`,
      });
    adminToken = adminLogin.body.data.accessToken;

    // 4. Onboard and Approve Driver 1
    const d1TokenRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({
        idToken: `mock-google-id-token:sub-drv-56-1:drv1-${Date.now()}@pdeu.ac.in:Driver Pipeline 1`,
      });
    driver1UserId = d1TokenRes.body.data.user.id;
    createdUserIds.push(driver1UserId);

    const onboard1 = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${d1TokenRes.body.data.accessToken}`)
      .send({
        licenseNumber: `GJ-01-P1-${Date.now()}`,
        vehicle: {
          registrationNumber: `GJ-01-V1-${Date.now()}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo',
        },
      });
    driver1ProfileId = onboard1.body.data.driverProfile.id;
    createdDriverIds.push(driver1ProfileId);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/drivers/${driver1ProfileId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    const d1Refresh = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({
        idToken: `mock-google-id-token:sub-drv-56-1:drv1-${Date.now()}@pdeu.ac.in:Driver Pipeline 1`,
      });
    driver1Token = d1Refresh.body.data.accessToken;

    await request(app.getHttpServer())
      .patch('/api/v1/drivers/status')
      .set('Authorization', `Bearer ${driver1Token}`)
      .send({ isOnline: true });

    await redisService.getClient().set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driver1ProfileId}`,
      JSON.stringify({
        latitude: 23.155,
        longitude: 72.666,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      300,
    );

    // 5. Onboard and Approve Driver 2
    const d2TokenRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({
        idToken: `mock-google-id-token:sub-drv-56-2:drv2-${Date.now()}@pdeu.ac.in:Driver Pipeline 2`,
      });
    driver2UserId = d2TokenRes.body.data.user.id;
    createdUserIds.push(driver2UserId);

    const onboard2 = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${d2TokenRes.body.data.accessToken}`)
      .send({
        licenseNumber: `GJ-01-P2-${Date.now()}`,
        vehicle: {
          registrationNumber: `GJ-01-V2-${Date.now()}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo',
        },
      });
    driver2ProfileId = onboard2.body.data.driverProfile.id;
    createdDriverIds.push(driver2ProfileId);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/drivers/${driver2ProfileId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    const d2Refresh = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({
        idToken: `mock-google-id-token:sub-drv-56-2:drv2-${Date.now()}@pdeu.ac.in:Driver Pipeline 2`,
      });
    driver2Token = d2Refresh.body.data.accessToken;

    await request(app.getHttpServer())
      .patch('/api/v1/drivers/status')
      .set('Authorization', `Bearer ${driver2Token}`)
      .send({ isOnline: true });

    await redisService.getClient().set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driver2ProfileId}`,
      JSON.stringify({
        latitude: 23.158,
        longitude: 72.669,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      300,
    );
  });

  afterAll(async () => {
    try {
      const redisClient = redisService.getClient();
      for (const dId of createdDriverIds) {
        await redisClient.del(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${dId}`).catch(() => {});
      }

      for (const tripId of createdTripIds) {
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

      for (const bId of createdBookingIds) {
        await prisma.cancellationFee.deleteMany({ where: { originalBookingId: bId } }).catch(() => {});
        await prisma.cancellationFee.deleteMany({ where: { collectedBookingId: bId } }).catch(() => {});
        await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: bId } }).catch(() => {});
        await prisma.groupMember.deleteMany({ where: { bookingId: bId } }).catch(() => {});
        await prisma.matchingBatchBooking.deleteMany({ where: { bookingId: bId } }).catch(() => {});
        await prisma.booking.delete({ where: { id: bId } }).catch(() => {});
      }

      for (const gId of createdGroupIds) {
        await prisma.driverAssignment.deleteMany({ where: { rideGroupId: gId } }).catch(() => {});
        await prisma.driverDispatchOffer.deleteMany({ where: { rideGroupId: gId } }).catch(() => {});
        await prisma.dispatchAttempt.deleteMany({ where: { rideGroupId: gId } }).catch(() => {});
        const rvs = await prisma.groupRouteVersion.findMany({ where: { rideGroupId: gId } }).catch(() => []);
        for (const rv of rvs) {
          await prisma.groupRouteStop.deleteMany({ where: { groupRouteVersionId: rv.id } }).catch(() => {});
        }
        await prisma.groupRouteVersion.deleteMany({ where: { rideGroupId: gId } }).catch(() => {});
        await prisma.groupMember.deleteMany({ where: { rideGroupId: gId } }).catch(() => {});
        await prisma.rideGroup.delete({ where: { id: gId } }).catch(() => {});
      }

      for (const bId of createdBatchIds) {
        await prisma.matchingBatchBooking.deleteMany({ where: { batchId: bId } }).catch(() => {});
        await prisma.matchingBatch.delete({ where: { id: bId } }).catch(() => {});
      }

      for (const qId of createdQuoteIds) {
        await prisma.fareQuote.delete({ where: { id: qId } }).catch(() => {});
      }

      for (const dId of createdDriverIds) {
        await prisma.driverAssignment.deleteMany({ where: { driverId: dId } }).catch(() => {});
        await prisma.driverDispatchOffer.deleteMany({ where: { driverId: dId } }).catch(() => {});
        await prisma.driverDocument.deleteMany({ where: { driverProfileId: dId } }).catch(() => {});
        await prisma.vehicle.deleteMany({ where: { driverProfileId: dId } }).catch(() => {});
        await prisma.driverProfile.delete({ where: { id: dId } }).catch(() => {});
      }

      for (const uId of createdUserIds) {
        await prisma.userSession.deleteMany({ where: { userId: uId } }).catch(() => {});
        await prisma.authIdentity.deleteMany({ where: { userId: uId } }).catch(() => {});
        await prisma.fareQuote.deleteMany({ where: { passengerId: uId } }).catch(() => {});
        await prisma.idempotencyRecord.deleteMany({ where: { userId: uId } }).catch(() => {});
        await prisma.userRole.deleteMany({ where: { userId: uId } }).catch(() => {});
        await prisma.user.delete({ where: { id: uId } }).catch(() => {});
      }
    } catch {
      // ignore cleanup errors
    }

    await app.close();
  });

  // Helper to create a commuter and booking via Stage 4 endpoints
  async function createPassengerAndBooking(idx: number, lat: number, lng: number) {
    const idToken = `mock-google-id-token:sub-stage56-pass-${Date.now()}-${idx}:pass56.${idx}@pdeu.ac.in:Commuter ${idx}`;
    const authRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken })
      .expect(200);

    const token = authRes.body.data.accessToken;
    const userId = authRes.body.data.user.id;
    createdUserIds.push(userId);

    // 1. Generate Quote
    const quoteRes = await request(app.getHttpServer())
      .post('/api/v1/fares/quotes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pickupPointId: pdeuPickupPointId,
        destination: { latitude: lat, longitude: lng },
      })
      .expect(200);

    const quoteId = quoteRes.body.data.quoteId;
    createdQuoteIds.push(quoteId);

    // 2. Create Booking with Upfront Consent
    const bookingRes = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `idem-bkg-56-${userId}-${Date.now()}`)
      .send({
        quoteId,
        passengerPickupLocation: { latitude: 23.1551, longitude: 72.6669 },
        requestedType: 'SHARED',
        minGroupPreference: 2,
        upfrontConsentAgreed: true,
      })
      .expect(201);

    const bookingId = bookingRes.body.data.bookingId;
    createdBookingIds.push(bookingId);

    return { userId, token, bookingId };
  }

  it('should execute full Stage 4 → Stage 5 → Stage 6 pipeline: bookings → matching → outbox handoff → dispatch → rejection cascade → driver acceptance', async () => {
    // 1. Create two commuters with bookings for matching corridor
    const p1 = await createPassengerAndBooking(1, 23.18, 72.68);
    const p2 = await createPassengerAndBooking(2, 23.185, 72.685);

    // Verify bookings created in REQUESTED state
    const b1Init = await prisma.booking.findUnique({ where: { id: p1.bookingId } });
    const b2Init = await prisma.booking.findUnique({ where: { id: p2.bookingId } });
    expect(b1Init!.status).toBe('REQUESTED');
    expect(b2Init!.status).toBe('REQUESTED');

    // 2. Stage 5: Execute matching cycle
    const matchingSummary = await matchingService.processMatchingCycle('PDEU Main Gate');
    expect(matchingSummary).not.toBeNull();
    expect(matchingSummary!.groupsFormedCount).toBe(1);
    createdBatchIds.push(matchingSummary!.batchId);

    // 3. Verify RideGroup formed and GROUP_FORMED outbox event persisted
    const formedGroup = await prisma.rideGroup.findFirst({
      where: {
        pickupPointId: pdeuPickupPointId,
        status: { in: ['READY_FOR_DISPATCH', 'DISPATCHING'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(formedGroup).toBeDefined();
    createdGroupIds.push(formedGroup!.id);

    // Verify bookings transitioned to MATCHED
    const b1Matched = await prisma.booking.findUnique({ where: { id: p1.bookingId } });
    const b2Matched = await prisma.booking.findUnique({ where: { id: p2.bookingId } });
    expect(b1Matched!.status).toBe('MATCHED');
    expect(b2Matched!.status).toBe('MATCHED');

    // 4. Verify Outbox Hand-off: process outbox events (or verify immediate handoff)
    // Handle both synchronous manual poll and async post-commit trigger idempotently
    let outboxEvent: any;
    await vi.waitFor(
      async () => {
        await outboxService.processPendingEvents(50, { aggregateId: formedGroup!.id });
        outboxEvent = await prisma.outboxEvent.findFirst({
          where: {
            aggregateType: 'RIDE_GROUP',
            aggregateId: formedGroup!.id,
            eventType: 'GROUP_FORMED',
          },
        });
        expect(outboxEvent).toBeDefined();
        expect(outboxEvent!.status).toBe('PUBLISHED');
        expect(outboxEvent!.publishedAt).toBeDefined();
      },
      { timeout: 4000, interval: 50 },
    );

    // 5. Stage 6: Verify dispatch was automatically initiated
    // Best-ranked driver (Driver 1, ETA 60s) received the offer
    const pendingOffer1 = await prisma.driverDispatchOffer.findFirst({
      where: {
        rideGroupId: formedGroup!.id,
        status: 'PENDING',
      },
    });
    expect(pendingOffer1).toBeDefined();
    expect(pendingOffer1!.driverId).toBe(driver1ProfileId);

    // 6. Driver 1 queries pending offers over HTTP
    const offersRes1 = await request(app.getHttpServer())
      .get('/api/v1/drivers/offers/pending')
      .set('Authorization', `Bearer ${driver1Token}`)
      .expect(200);
    expect(offersRes1.body.data).toHaveLength(1);
    expect(offersRes1.body.data[0].offerId).toBe(pendingOffer1!.id);
    expect(offersRes1.body.data[0].remainingSeconds).toBeGreaterThan(0);

    // 7. Driver 1 rejects offer over HTTP
    const rejectKey = `reject-e2e-${randomUUID()}`;
    const rejectRes = await request(app.getHttpServer())
      .post(`/api/v1/drivers/offers/${pendingOffer1!.id}/reject`)
      .set('Authorization', `Bearer ${driver1Token}`)
      .set('Idempotency-Key', rejectKey)
      .send({ reason: 'Vehicle battery low' })
      .expect(200);
    expect(rejectRes.body.success).toBe(true);

    // 8. Verify Cascade to Driver 2:
    // RideGroup stays INTACT (DISPATCHING status), bookings stay MATCHED
    const groupAfterReject = await prisma.rideGroup.findUnique({ where: { id: formedGroup!.id } });
    expect(groupAfterReject!.status).toBe('DISPATCHING');

    const b1AfterReject = await prisma.booking.findUnique({ where: { id: p1.bookingId } });
    expect(b1AfterReject!.status).toBe('MATCHED');

    // New offer created for Driver 2 (Rank 2, ETA 180s)
    const pendingOffer2 = await prisma.driverDispatchOffer.findFirst({
      where: {
        rideGroupId: formedGroup!.id,
        status: 'PENDING',
      },
    });
    expect(pendingOffer2).toBeDefined();
    expect(pendingOffer2!.driverId).toBe(driver2ProfileId);
    expect(pendingOffer2!.id).not.toBe(pendingOffer1!.id);

    // 9. Driver 2 queries and accepts offer over HTTP
    const offersRes2 = await request(app.getHttpServer())
      .get('/api/v1/drivers/offers/pending')
      .set('Authorization', `Bearer ${driver2Token}`)
      .expect(200);
    expect(offersRes2.body.data).toHaveLength(1);
    expect(offersRes2.body.data[0].offerId).toBe(pendingOffer2!.id);

    const acceptKey = `accept-e2e-${randomUUID()}`;
    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/drivers/offers/${pendingOffer2!.id}/accept`)
      .set('Authorization', `Bearer ${driver2Token}`)
      .set('Idempotency-Key', acceptKey)
      .expect(200);

    expect(acceptRes.body.success).toBe(true);
    const acceptData = acceptRes.body.data;
    createdTripIds.push(acceptData.tripId);

    // 10. Verify Full Materialization and Final State:
    // a. DriverAssignment -> RESERVED
    const assignment = await prisma.driverAssignment.findUnique({
      where: { id: acceptData.assignmentId },
    });
    expect(assignment!.status).toBe('RESERVED');
    expect(assignment!.driverId).toBe(driver2ProfileId);

    // b. Driver 2 Profile -> RESERVED
    const d2Profile = await prisma.driverProfile.findUnique({
      where: { id: driver2ProfileId },
    });
    expect(d2Profile!.operationalStatus).toBe('RESERVED');

    // c. RideGroup -> DRIVER_ASSIGNED
    const finalGroup = await prisma.rideGroup.findUnique({ where: { id: formedGroup!.id } });
    expect(finalGroup!.status).toBe('DRIVER_ASSIGNED');

    // d. Bookings -> DRIVER_ASSIGNED
    const finalB1 = await prisma.booking.findUnique({ where: { id: p1.bookingId } });
    const finalB2 = await prisma.booking.findUnique({ where: { id: p2.bookingId } });
    expect(finalB1!.status).toBe('DRIVER_ASSIGNED');
    expect(finalB2!.status).toBe('DRIVER_ASSIGNED');

    // e. Trip -> CREATED
    const trip = await prisma.trip.findUnique({ where: { id: acceptData.tripId } });
    expect(trip!.status).toBe('CREATED');
    expect(trip!.driverAssignmentId).toBe(acceptData.assignmentId);

    // f. TripPassengers -> WAITING
    const passengers = await prisma.tripPassenger.findMany({
      where: { tripId: acceptData.tripId },
    });
    expect(passengers).toHaveLength(2);
    for (const passenger of passengers) {
      expect(passenger.status).toBe('WAITING');

      // g. BoardingVerification -> OTP hash
      const bv = await prisma.boardingVerification.findUnique({
        where: { tripPassengerId: passenger.id },
      });
      expect(bv).toBeDefined();
      expect(bv!.otpHash).toHaveLength(64);
      expect(bv!.maxAttempts).toBe(3);
    }

    // h. Outbox events persisted
    const offerAcceptedEv = await prisma.outboxEvent.findFirst({
      where: { aggregateId: pendingOffer2!.id, eventType: 'DISPATCH_OFFER_ACCEPTED' },
    });
    expect(offerAcceptedEv).toBeDefined();

    const tripCreatedEv = await prisma.outboxEvent.findFirst({
      where: { aggregateId: acceptData.tripId, eventType: 'TRIP_CREATED' },
    });
    expect(tripCreatedEv).toBeDefined();
  });

  it('should handle duplicate GROUP_FORMED outbox event delivery without creating duplicate offers or trips', async () => {
    // Pick an existing group from previous test
    const group = await prisma.rideGroup.findFirst({
      where: { id: { in: createdGroupIds } },
    });
    expect(group).toBeDefined();

    // Insert duplicate GROUP_FORMED outbox event
    const dupEvent = await prisma.outboxEvent.create({
      data: {
        eventType: 'GROUP_FORMED',
        aggregateType: 'RIDE_GROUP',
        aggregateId: group!.id,
        payload: {
          rideGroupId: group!.id,
          pickupPointId: group!.pickupPointId,
          groupVersion: group!.groupVersion,
          status: 'READY_FOR_DISPATCH',
        },
        status: 'PENDING',
      },
    });

    // Count trips and assignments before processing duplicate
    const tripCountBefore = await prisma.trip.count({ where: { rideGroupId: group!.id } });
    const assignmentCountBefore = await prisma.driverAssignment.count({ where: { rideGroupId: group!.id } });

    // Process outbox events
    const summary = await outboxService.processPendingEvents(50, { aggregateId: group!.id });
    expect(summary.processedCount).toBeGreaterThanOrEqual(1);

    // Verify duplicate outbox event is marked PUBLISHED
    const updatedDupEvent = await prisma.outboxEvent.findUnique({
      where: { id: dupEvent.id },
    });
    expect(updatedDupEvent!.status).toBe('PUBLISHED');

    // Counts must remain strictly identical (zero duplicate trips or assignments created)
    const tripCountAfter = await prisma.trip.count({ where: { rideGroupId: group!.id } });
    const assignmentCountAfter = await prisma.driverAssignment.count({ where: { rideGroupId: group!.id } });
    expect(tripCountAfter).toBe(tripCountBefore);
    expect(assignmentCountAfter).toBe(assignmentCountBefore);
  });

  it('should recover and process stale PROCESSING outbox events after worker crash', async () => {
    const group = await prisma.rideGroup.findFirst({
      where: { id: { in: createdGroupIds } },
    });
    expect(group).toBeDefined();

    // Insert simulated crashed outbox event: status = 'PROCESSING', published_at = 45s ago
    const staleDate = new Date(Date.now() - 45000);
    const [crashedEvent] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outbox_events (
        id, event_type, aggregate_type, aggregate_id, payload,
        status, retry_count, created_at, published_at
      ) VALUES (
        gen_random_uuid(), 'GROUP_FORMED', 'RIDE_GROUP', ${group!.id}::uuid,
        jsonb_build_object(
          'rideGroupId', ${group!.id}::text,
          'pickupPointId', ${group!.pickupPointId}::text,
          'groupVersion', 1
        ),
        'PROCESSING', 1, ${staleDate}, ${staleDate}
      ) RETURNING id;
    `;

    // Process pending/stale outbox events
    const summary = await outboxService.processPendingEvents(50, { aggregateId: group!.id });
    expect(summary.processedCount).toBeGreaterThanOrEqual(1);

    // Verify stale crashed event was reclaimed, processed, and marked PUBLISHED
    const recoveredEvent = await prisma.outboxEvent.findUnique({
      where: { id: crashedEvent.id },
    });
    expect(recoveredEvent!.status).toBe('PUBLISHED');
  });
});
