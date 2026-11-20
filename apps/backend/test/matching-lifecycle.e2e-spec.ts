import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';
import { MatchingService } from '../src/modules/matching/matching.service.js';
import { RoutingService } from '../src/modules/routing/routing.service.js';

describe('Matching & Pooling Engine End-to-End Suite (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let matchingService: MatchingService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdBatchIds: string[] = [];
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

    prisma = app.get<PrismaService>(PrismaService);
    matchingService = app.get<MatchingService>(MatchingService);
    const routingService = app.get<RoutingService>(RoutingService);

    // Mock authoritative OSRM responses for E2E corridor routing
    vi.spyOn(routingService, 'getTravelTimeMatrix').mockImplementation(async (coords) => {
      const durations: number[][] = Array.from({ length: coords.length }, () =>
        Array.from({ length: coords.length }, () => 0),
      );
      const distances: number[][] = Array.from({ length: coords.length }, () =>
        Array.from({ length: coords.length }, () => 0),
      );

      for (let i = 0; i < coords.length; i++) {
        for (let j = 0; j < coords.length; j++) {
          if (i === j) continue;
          if (i === 0) {
            // from P0 to Di
            durations[i][j] = 260 + j * 40;
            distances[i][j] = 3600 + j * 500;
          } else {
            const step = Math.abs(i - j);
            durations[i][j] = step * 50;
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
    });

    vi.spyOn(routingService, 'getMultiStopRoute').mockImplementation(async (waypoints) => {
      return {
        distanceMeters: 6500,
        durationSec: 480,
        geometry: {
          type: 'LineString',
          coordinates: waypoints.map((w) => [w.longitude, w.latitude]),
        },
        source: 'OSRM',
        isFallback: false,
      };
    });

    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    pdeuPickupPointId = pickup!.id;
  });

  afterAll(async () => {
    try {
      if (createdGroupIds.length > 0) {
        await prisma.groupRouteStop.deleteMany({
          where: {
            groupMember: { rideGroupId: { in: createdGroupIds } },
          },
        });
        await prisma.groupRouteVersion.deleteMany({
          where: { rideGroupId: { in: createdGroupIds } },
        });
        await prisma.groupMember.deleteMany({
          where: { rideGroupId: { in: createdGroupIds } },
        });
        await prisma.rideGroup.deleteMany({
          where: { id: { in: createdGroupIds } },
        });
      }

      if (createdBatchIds.length > 0) {
        await prisma.matchingBatchBooking.deleteMany({
          where: { batchId: { in: createdBatchIds } },
        });
        await prisma.matchingBatch.deleteMany({
          where: { id: { in: createdBatchIds } },
        });
      }

      if (createdBookingIds.length > 0) {
        await prisma.bookingStatusHistory.deleteMany({
          where: { bookingId: { in: createdBookingIds } },
        });
        await prisma.booking.deleteMany({
          where: { id: { in: createdBookingIds } },
        });
      }

      if (createdUserIds.length > 0) {
        await prisma.fareQuote.deleteMany({
          where: { passengerId: { in: createdUserIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: createdUserIds } },
        });
      }
    } catch (err) {
      console.error('Error during E2E teardown:', err);
    }

    await app.close();
  });

  async function createCommuterWithBooking(index: number, dest: { lat: number; lng: number }) {
    const googleIdToken = `mock-google-id-token:sub-match-e2e-${Date.now()}-${index}:commuter${index}.match@pdeu.ac.in:Commuter ${index}`;
    const authRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: googleIdToken })
      .expect(200);

    const token = authRes.body.data.accessToken;
    const userId = authRes.body.data.user.id;
    createdUserIds.push(userId);

    // 1. Generate Quote via REST
    const quoteRes = await request(app.getHttpServer())
      .post('/api/v1/fares/quotes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pickupPointId: pdeuPickupPointId,
        destination: {
          latitude: dest.lat,
          longitude: dest.lng,
        },
      })
      .expect(200);

    const quoteId = quoteRes.body.data.quoteId;

    // 2. Create Booking via REST with Upfront Consent
    const bookingRes = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `idem-book-${userId}-${Date.now()}`)
      .send({
        quoteId,
        passengerPickupLocation: {
          latitude: 23.1551,
          longitude: 72.6669,
        },
        requestedType: 'SHARED',
        minGroupPreference: 2,
        upfrontConsentAgreed: true,
      });

    if (bookingRes.status !== 201) {
      console.error('Booking creation failed:', bookingRes.status, bookingRes.body);
    }
    expect(bookingRes.status).toBe(201);

    const bookingId = bookingRes.body.data.bookingId;
    createdBookingIds.push(bookingId);

    return { userId, token, bookingId };
  }

  it('should aggregate 4 commuters at PDEU into an optimal shared RideGroup', async () => {
    // 4 commuters along the Kudasan corridor
    const destinations = [
      { lat: 23.164, lng: 72.628 }, // Kudasan (4km)
      { lat: 23.167, lng: 72.632 }, // Kudasan East (4.3km)
      { lat: 23.170, lng: 72.635 }, // Bhaijipura (4.8km)
      { lat: 23.174, lng: 72.638 }, // Raysan (5.2km)
    ];

    const commuters = [];
    for (let i = 0; i < 4; i++) {
      commuters.push(await createCommuterWithBooking(i + 1, destinations[i]));
    }

    // Run the matching cycle for PDEU Main Gate
    const summary = await matchingService.processMatchingCycle('PDEU Main Gate');
    expect(summary).not.toBeNull();
    expect(summary!.groupsFormedCount).toBeGreaterThanOrEqual(1);

    const groupId = summary!.formedGroupIds[0];
    createdGroupIds.push(groupId);
    createdBatchIds.push(summary!.batchId);

    // 1. Verify RideGroup in PostgreSQL
    const rideGroup = await prisma.rideGroup.findUnique({
      where: { id: groupId },
      include: {
        members: true,
        routeVersions: {
          include: { stops: true },
        },
      },
    });

    expect(rideGroup).not.toBeNull();
    expect(rideGroup!.status).toBe('READY_FOR_DISPATCH');
    expect(rideGroup!.pickupPointId).toBe(pdeuPickupPointId);
    expect(rideGroup!.groupVersion).toBe(1);
    expect(rideGroup!.totalSharedFarePaise).toBeGreaterThan(0);
    expect(rideGroup!.totalRouteDistanceMeters).toBeGreaterThan(0);
    expect(rideGroup!.totalRouteDurationSec).toBeGreaterThan(0);

    // 2. Verify Group Members
    expect(rideGroup!.members).toHaveLength(4);
    for (const member of rideGroup!.members) {
      expect(member.isActiveMember).toBe(true);
      expect(Number(member.calculatedDetourPercent)).toBeLessThanOrEqual(25.0);
      expect(member.allocatedFarePaise).toBeGreaterThan(0);
      expect(member.dropoffSequenceOrder).toBeGreaterThanOrEqual(1);
      expect(member.dropoffSequenceOrder).toBeLessThanOrEqual(4);
    }

    // 3. Verify Route Versions & Stops
    expect(rideGroup!.routeVersions).toHaveLength(1);
    const routeVer = rideGroup!.routeVersions[0];
    expect(routeVer.versionNumber).toBe(1);
    expect(routeVer.stops).toHaveLength(4);

    // 4. Verify Bookings Transitioned to MATCHED
    for (const c of commuters) {
      const b = await prisma.booking.findUnique({
        where: { id: c.bookingId },
        include: { statusHistory: true },
      });
      expect(b!.status).toBe('MATCHED');
      expect(b!.finalAllocatedFarePaise).toBeGreaterThan(0);

      const matchedHistory = b!.statusHistory.find((h) => h.newStatus === 'MATCHED');
      expect(matchedHistory).toBeDefined();
    }

    // 5. Verify Transactional Outbox Event GROUP_FORMED
    const outboxEvent = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: groupId,
        eventType: 'GROUP_FORMED',
      },
    });
    expect(outboxEvent).not.toBeNull();
    const payload = outboxEvent!.payload as any;
    expect(payload.rideGroupId).toBe(groupId);
    expect(payload.status).toBe('READY_FOR_DISPATCH');
    expect(payload.memberBookingIds).toHaveLength(4);

    // 6. Verify Matching Batch Audit Record
    const batch = await prisma.matchingBatch.findUnique({
      where: { id: summary!.batchId },
      include: { batchBookings: true },
    });
    expect(batch).not.toBeNull();
    expect(batch!.batchStatus).toBe('COMPLETED');
    expect(batch!.groupsFormedCount).toBe(1);
    expect(batch!.batchBookings).toHaveLength(4);
  });
});
