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
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';
import { CACHE_KEYS } from '../src/common/constants/index.js';

describe('Driver Dispatch Engine & Acceptance (E2E)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redisService: RedisService;
  let routingService: RoutingService;
  let dispatchService: DispatchService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdQuoteIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdDriverProfileIds: string[] = [];

  let pdeuPickupPointId: string;

  // Tokens & User IDs
  let adminToken: string;
  let adminUserId: string;

  let driver1Token: string;
  let driver1UserId: string;
  let driver1ProfileId: string;

  let driver2Token: string;
  let driver2UserId: string;
  let driver2ProfileId: string;

  let pendingDriverToken: string;
  let pendingDriverUserId: string;

  let passengerToken: string;
  let passengerUserId: string;

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
    dispatchService = moduleFixture.get<DispatchService>(DispatchService);

    // 1. Pickup Point
    const existingPickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    if (existingPickup) {
      pdeuPickupPointId = existingPickup.id;
    } else {
      const [newPickup] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO pickup_points (id, name, landmark, location, geofence_radius_meters, is_active)
        VALUES (
          gen_random_uuid(), 'PDEU Main Gate', 'Main Campus Gate',
          ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326), 150, true
        ) RETURNING id;
      `;
      pdeuPickupPointId = newPickup.id;
    }

    // 2. Mock RoutingService travel times to return deterministic OSRM matrix
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
            if (j === pickupIndex) {
              const lat = coords[i].latitude;
              // Driver 1 (23.155) -> 60s ETA, Driver 2 (23.158) -> 180s ETA
              if (Math.abs(lat - 23.155) < 0.002) {
                durations[i][j] = 60;
                distances[i][j] = 500;
              } else {
                durations[i][j] = 180;
                distances[i][j] = 1500;
              }
            } else {
              durations[i][j] = 60;
              distances[i][j] = 500;
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

    // 3. Admin User
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${Date.now()}@pdeu.ac.in`,
        fullName: 'Dispatch Admin',
        role: 'ADMIN',
        roles: { create: { roleName: 'ADMIN' } },
      },
    });
    adminUserId = adminUser.id;
    createdUserIds.push(adminUserId);

    const adminLoginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({
        idToken: `mock-google-id-token:sub-adm-${Date.now()}:${adminUser.email}:Dispatch Admin`,
      });
    adminToken = adminLoginRes.body.data.accessToken;

    // 4. Driver 1: Approved, Online, AVAILABLE
    const d1GoogleToken = `mock-google-id-token:sub-drv1-${Date.now()}:driver1-${Date.now()}@pdeu.ac.in:Driver One`;
    const d1Res = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: d1GoogleToken });
    driver1UserId = d1Res.body.data.user.id;
    createdUserIds.push(driver1UserId);

    const onboard1 = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${d1Res.body.data.accessToken}`)
      .send({
        licenseNumber: `GJ-01-D1-${Date.now()}`,
        vehicle: {
          registrationNumber: `GJ-01-V1-${Date.now()}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo 2026',
        },
      });
    driver1ProfileId = onboard1.body.data.driverProfile.id;
    createdDriverProfileIds.push(driver1ProfileId);

    // Approve Driver 1 via Admin
    await request(app.getHttpServer())
      .post(`/api/v1/admin/drivers/${driver1ProfileId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Refresh token after approval to pick up DRIVER role
    const d1Refresh = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: d1GoogleToken });
    driver1Token = d1Refresh.body.data.accessToken;

    // Put Driver 1 Online
    await request(app.getHttpServer())
      .patch('/api/v1/drivers/status')
      .set('Authorization', `Bearer ${driver1Token}`)
      .send({ isOnline: true });

    // Set Driver 1 GPS fix in Redis
    await redisService.getClient().set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driver1ProfileId}`,
      JSON.stringify({
        latitude: 23.155,
        longitude: 72.666,
        heading: 90,
        speed: 15,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      300,
    );

    // 5. Driver 2: Approved, Online, AVAILABLE
    const d2GoogleToken = `mock-google-id-token:sub-drv2-${Date.now()}:driver2-${Date.now()}@pdeu.ac.in:Driver Two`;
    const d2Res = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: d2GoogleToken });
    driver2UserId = d2Res.body.data.user.id;
    createdUserIds.push(driver2UserId);

    const onboard2 = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${d2Res.body.data.accessToken}`)
      .send({
        licenseNumber: `GJ-01-D2-${Date.now()}`,
        vehicle: {
          registrationNumber: `GJ-01-V2-${Date.now()}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo 2026',
        },
      });
    driver2ProfileId = onboard2.body.data.driverProfile.id;
    createdDriverProfileIds.push(driver2ProfileId);

    // Approve Driver 2 via Admin
    await request(app.getHttpServer())
      .post(`/api/v1/admin/drivers/${driver2ProfileId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    const d2Refresh = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: d2GoogleToken });
    driver2Token = d2Refresh.body.data.accessToken;

    // Put Driver 2 Online
    await request(app.getHttpServer())
      .patch('/api/v1/drivers/status')
      .set('Authorization', `Bearer ${driver2Token}`)
      .send({ isOnline: true });

    // Set Driver 2 GPS fix in Redis
    await redisService.getClient().set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driver2ProfileId}`,
      JSON.stringify({
        latitude: 23.158,
        longitude: 72.669,
        heading: 90,
        speed: 10,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      300,
    );

    // 6. Pending (Unapproved) Driver
    const pendGoogleToken = `mock-google-id-token:sub-drv-pnd-${Date.now()}:driver.pnd-${Date.now()}@pdeu.ac.in:Pending Driver`;
    const pendRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: pendGoogleToken });
    pendingDriverUserId = pendRes.body.data.user.id;
    createdUserIds.push(pendingDriverUserId);
    pendingDriverToken = pendRes.body.data.accessToken;

    const onboardPend = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${pendingDriverToken}`)
      .send({
        licenseNumber: `GJ-01-PND-${Date.now()}`,
        vehicle: {
          registrationNumber: `GJ-01-VP-${Date.now()}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo 2026',
        },
      });
    const pendProfileId = onboardPend.body.data.driverProfile.id;
    createdDriverProfileIds.push(pendProfileId);

    // 7. Passenger User
    const passGoogleToken = `mock-google-id-token:sub-pass-${Date.now()}:passenger-${Date.now()}@pdeu.ac.in:Passenger User`;
    const passRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: passGoogleToken });
    passengerUserId = passRes.body.data.user.id;
    createdUserIds.push(passengerUserId);
    passengerToken = passRes.body.data.accessToken;
  });

  afterAll(async () => {
    try {
      // 1. Clean up trips
      for (const tripId of createdTripIds) {
        await prisma.cashCollection.deleteMany({ where: { tripId } }).catch(() => {});
        await prisma.tripIncident.deleteMany({ where: { tripId } }).catch(() => {});
        await prisma.tripStatusHistory.deleteMany({ where: { tripId } }).catch(() => {});
        const passengers = await prisma.tripPassenger.findMany({ where: { tripId } }).catch(() => []);
        for (const tp of passengers) {
          await prisma.boardingVerification.deleteMany({ where: { tripPassengerId: tp.id } }).catch(() => {});
        }
        await prisma.tripPassenger.deleteMany({ where: { tripId } }).catch(() => {});
        await prisma.trip.delete({ where: { id: tripId } }).catch(() => {});
      }

      // 2. Clean up bookings
      for (const bookingId of createdBookingIds) {
        await prisma.cancellationFee.deleteMany({ where: { originalBookingId: bookingId } }).catch(() => {});
        await prisma.cancellationFee.deleteMany({ where: { collectedBookingId: bookingId } }).catch(() => {});
        await prisma.bookingStatusHistory.deleteMany({ where: { bookingId } }).catch(() => {});
        await prisma.groupMember.deleteMany({ where: { bookingId } }).catch(() => {});
        await prisma.matchingBatchBooking.deleteMany({ where: { bookingId } }).catch(() => {});
        await prisma.booking.delete({ where: { id: bookingId } }).catch(() => {});
      }

      // 3. Clean up groups
      for (const groupId of createdGroupIds) {
        await prisma.driverAssignment.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
        await prisma.driverDispatchOffer.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
        await prisma.dispatchAttempt.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
        const routeVersions = await prisma.groupRouteVersion.findMany({ where: { rideGroupId: groupId } }).catch(() => []);
        for (const rv of routeVersions) {
          await prisma.groupRouteStop.deleteMany({ where: { groupRouteVersionId: rv.id } }).catch(() => {});
        }
        await prisma.groupRouteVersion.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
        await prisma.rideGroup.delete({ where: { id: groupId } }).catch(() => {});
      }

      // 4. Clean up fare quotes
      for (const qId of createdQuoteIds) {
        await prisma.fareQuote.delete({ where: { id: qId } }).catch(() => {});
      }

      // 5. Clean up users & profiles
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
        await prisma.idempotencyRecord.deleteMany({ where: { userId } }).catch(() => {});
        await prisma.userRole.deleteMany({ where: { userId } }).catch(() => {});
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
      }

      // 6. Clean up Redis GPS keys
      const redisClient = redisService.getClient();
      for (const dId of createdDriverProfileIds) {
        await redisClient.del(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${dId}`).catch(() => {});
      }
    } catch {
      // ignore teardown errors
    }

    await app.close();
  });

  async function resetDriversAvailability() {
    // 1. Delete trip children & trips
    const trips = await prisma.trip.findMany({
      where: {
        driverAssignment: {
          driverId: { in: [driver1ProfileId, driver2ProfileId] },
        },
      },
      select: { id: true },
    });
    for (const t of trips) {
      const tp = await prisma.tripPassenger.findMany({ where: { tripId: t.id } }).catch(() => []);
      for (const p of tp) {
        await prisma.boardingVerification.deleteMany({ where: { tripPassengerId: p.id } }).catch(() => {});
      }
      await prisma.tripPassenger.deleteMany({ where: { tripId: t.id } }).catch(() => {});
      await prisma.tripStatusHistory.deleteMany({ where: { tripId: t.id } }).catch(() => {});
      await prisma.trip.delete({ where: { id: t.id } }).catch(() => {});
    }

    // 2. Delete driver assignments
    await prisma.driverAssignment.deleteMany({
      where: { driverId: { in: [driver1ProfileId, driver2ProfileId] } },
    }).catch(() => {});

    // 3. Reset driver profiles to AVAILABLE and isOnline: true
    await prisma.driverProfile.updateMany({
      where: { id: { in: [driver1ProfileId, driver2ProfileId] } },
      data: { operationalStatus: 'AVAILABLE', isOnline: true },
    }).catch(() => {});
  }

  // Helper to create a test ride group with 2 bookings and 1 active route version
  async function createTestRideGroupFixture(suffix: string) {
    await resetDriversAvailability();

    // Passenger 1
    const p1 = await prisma.user.create({
      data: {
        email: `p1-${suffix}@pdeu.ac.in`,
        fullName: `Passenger 1 ${suffix}`,
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(p1.id);

    // Passenger 2
    const p2 = await prisma.user.create({
      data: {
        email: `p2-${suffix}@pdeu.ac.in`,
        fullName: `Passenger 2 ${suffix}`,
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(p2.id);

    // Quote 1
    const [q1] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise,
        shared_max_fare_paise, agreed_fare_ceiling_paise,
        tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${p1.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        4000, 600, 6000, 2000, 3500, 3500, 1,
        NOW() + INTERVAL '10 minutes'
      ) RETURNING id;
    `;
    createdQuoteIds.push(q1.id);

    // Quote 2
    const [q2] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise,
        shared_max_fare_paise, agreed_fare_ceiling_paise,
        tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${p2.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6850, 23.1850), 4326),
        4500, 650, 6500, 2200, 3800, 3800, 1,
        NOW() + INTERVAL '10 minutes'
      ) RETURNING id;
    `;
    createdQuoteIds.push(q2.id);

    // Booking 1
    const [b1] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status,
        agreed_fare_ceiling_paise, final_allocated_fare_paise,
        max_wait_deadline
      ) VALUES (
        gen_random_uuid(), ${p1.id}::uuid, ${q1.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        'SHARED', 2, 'MATCHED',
        3500, 3000, NOW() + INTERVAL '10 minutes'
      ) RETURNING id;
    `;
    createdBookingIds.push(b1.id);

    // Booking 2
    const [b2] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status,
        agreed_fare_ceiling_paise, final_allocated_fare_paise,
        max_wait_deadline
      ) VALUES (
        gen_random_uuid(), ${p2.id}::uuid, ${q2.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6850, 23.1850), 4326),
        'SHARED', 2, 'MATCHED',
        3800, 3200, NOW() + INTERVAL '10 minutes'
      ) RETURNING id;
    `;
    createdBookingIds.push(b2.id);

    // Ride Group
    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: pdeuPickupPointId,
        rideType: 'SHARED',
        groupVersion: 1,
        status: 'READY_FOR_DISPATCH',
        totalSharedFarePaise: 6200,
        totalRouteDistanceMeters: 5000,
        totalRouteDurationSec: 720,
      },
    });
    createdGroupIds.push(group.id);

    // Group Members
    const m1 = await prisma.groupMember.create({
      data: {
        rideGroupId: group.id,
        bookingId: b1.id,
        dropoffSequenceOrder: 1,
        directDistanceMeters: 4000,
        directDurationSec: 600,
        sharedDurationSec: 600,
        calculatedDetourPercent: 0,
        allocatedFarePaise: 3000,
        isActiveMember: true,
      },
    });

    const m2 = await prisma.groupMember.create({
      data: {
        rideGroupId: group.id,
        bookingId: b2.id,
        dropoffSequenceOrder: 2,
        directDistanceMeters: 4500,
        directDurationSec: 650,
        sharedDurationSec: 720,
        calculatedDetourPercent: 10.7,
        allocatedFarePaise: 3200,
        isActiveMember: true,
      },
    });

    // Group Route Version & Stops
    const routeVersion = await prisma.groupRouteVersion.create({
      data: {
        rideGroupId: group.id,
        versionNumber: 1,
        totalDistanceMeters: 5000,
        totalDurationSec: 720,
        routeGeometry: {
          type: 'LineString',
          coordinates: [
            [72.6668, 23.155],
            [72.68, 23.18],
            [72.685, 23.185],
          ],
        },
      },
    });

    await prisma.$executeRaw`
      INSERT INTO group_route_stops (
        id, group_route_version_id, stop_order, stop_type, group_member_id, stop_location
      ) VALUES
      (
        gen_random_uuid(), ${routeVersion.id}::uuid, 0, 'DROPOFF', ${m1.id}::uuid,
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326)
      ),
      (
        gen_random_uuid(), ${routeVersion.id}::uuid, 1, 'DROPOFF', ${m2.id}::uuid,
        ST_SetSRID(ST_MakePoint(72.6850, 23.1850), 4326)
      );
    `;

    return { group, b1, b2, routeVersion };
  }

  describe('GET /api/v1/drivers/offers/pending', () => {
    it('should reject unauthenticated requests with 401', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/drivers/offers/pending')
        .expect(401);
    });

    it('should reject requests from PASSENGER role with 403', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/drivers/offers/pending')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(403);
    });

    it('should reject requests from unapproved driver with 403', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/drivers/offers/pending')
        .set('Authorization', `Bearer ${pendingDriverToken}`)
        .expect(403);
    });

    it('should return empty list when driver has no pending offers', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/drivers/offers/pending')
        .set('Authorization', `Bearer ${driver1Token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return pending offers with countdown, fare, stops, and NO passenger PII', async () => {
      const { group } = await createTestRideGroupFixture(`pend-${randomUUID().substring(0, 6)}`);

      // Dispatch to Driver 1
      const dispatchRes = await dispatchService.initiateDispatchForGroup(group.id);
      expect(dispatchRes.success).toBe(true);
      expect(dispatchRes.driverId).toBe(driver1ProfileId);

      const res = await request(app.getHttpServer())
        .get('/api/v1/drivers/offers/pending')
        .set('Authorization', `Bearer ${driver1Token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);

      const offer = res.body.data[0];
      expect(offer.offerId).toBe(dispatchRes.offerId);
      expect(offer.rideGroupId).toBe(group.id);
      expect(offer.passengerCount).toBe(2);
      expect(offer.totalEstimatedFare).toBe('62.00');
      expect(offer.remainingSeconds).toBeGreaterThan(0);
      expect(offer.remainingSeconds).toBeLessThanOrEqual(20);
      expect(offer.pickupPoint.name).toBe('PDEU Main Gate');

      // Verify NO passenger PII is exposed
      expect(JSON.stringify(offer)).not.toContain('p1-');
      expect(JSON.stringify(offer)).not.toContain('Passenger 1');
      expect(JSON.stringify(offer)).not.toContain('@pdeu.ac.in');
    });
  });

  describe('POST /api/v1/drivers/offers/:id/accept', () => {
    it('should return 400 Bad Request when Idempotency-Key header is missing', async () => {
      const { group } = await createTestRideGroupFixture(`no-idemp-${randomUUID().substring(0, 6)}`);
      const dispatchRes = await dispatchService.initiateDispatchForGroup(group.id);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/accept`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .expect(400);

      expect(res.body.errorCode).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('should return 403 Forbidden when called by a passenger', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${randomUUID()}/accept`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', randomUUID())
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('should return 403 Forbidden when called by an unapproved driver', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${randomUUID()}/accept`)
        .set('Authorization', `Bearer ${pendingDriverToken}`)
        .set('Idempotency-Key', randomUUID())
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('should atomically accept offer, reserve driver, create trip, and return navigation details', async () => {
      const { group, b1, b2 } = await createTestRideGroupFixture(`accept-success-${randomUUID().substring(0, 6)}`);

      // 1. Dispatch to Driver 1
      const dispatchRes = await dispatchService.initiateDispatchForGroup(group.id);
      expect(dispatchRes.success).toBe(true);
      expect(dispatchRes.driverId).toBe(driver1ProfileId);

      const idempotencyKey = `accept-key-${randomUUID()}`;

      // 2. Accept offer over HTTP
      const res = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/accept`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .set('Idempotency-Key', idempotencyKey)
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.rideGroupId).toBe(group.id);
      expect(data.passengerCount).toBe(2);
      expect(data.totalEstimatedFare).toBe('62.00');
      expect(data.assignmentId).toBeDefined();
      expect(data.tripId).toBeDefined();
      expect(data.navigationRoute).toBeDefined();
      expect(data.navigationRoute.stops).toHaveLength(2);

      createdTripIds.push(data.tripId);

      // 3. Verify Database Invariants & State
      // Offer -> ACCEPTED
      const offerInDb = await prisma.driverDispatchOffer.findUnique({
        where: { id: dispatchRes.offerId },
      });
      expect(offerInDb!.status).toBe('ACCEPTED');
      expect(offerInDb!.respondedAt).toBeDefined();

      // Driver Assignment -> RESERVED
      const assignmentInDb = await prisma.driverAssignment.findUnique({
        where: { id: data.assignmentId },
      });
      expect(assignmentInDb!.status).toBe('RESERVED');
      expect(assignmentInDb!.driverId).toBe(driver1ProfileId);
      expect(assignmentInDb!.rideGroupId).toBe(group.id);

      // Driver Profile -> RESERVED
      const driverInDb = await prisma.driverProfile.findUnique({
        where: { id: driver1ProfileId },
      });
      expect(driverInDb!.operationalStatus).toBe('RESERVED');

      // Ride Group -> DRIVER_ASSIGNED
      const groupInDb = await prisma.rideGroup.findUnique({
        where: { id: group.id },
      });
      expect(groupInDb!.status).toBe('DRIVER_ASSIGNED');

      // Trip -> CREATED
      const tripInDb = await prisma.trip.findUnique({
        where: { id: data.tripId },
      });
      expect(tripInDb!.status).toBe('CREATED');
      expect(tripInDb!.driverAssignmentId).toBe(data.assignmentId);

      // Trip Passengers -> WAITING
      const tripPassengers = await prisma.tripPassenger.findMany({
        where: { tripId: data.tripId },
      });
      expect(tripPassengers).toHaveLength(2);
      for (const tp of tripPassengers) {
        expect(tp.status).toBe('WAITING');

        // Boarding verification OTP
        const bv = await prisma.boardingVerification.findUnique({
          where: { tripPassengerId: tp.id },
        });
        expect(bv).toBeDefined();
        expect(bv!.otpHash).toHaveLength(64); // SHA-256
        expect(bv!.maxAttempts).toBe(3);
        expect(bv!.attemptsCount).toBe(0);
      }

      // Bookings -> DRIVER_ASSIGNED
      const b1InDb = await prisma.booking.findUnique({ where: { id: b1.id } });
      const b2InDb = await prisma.booking.findUnique({ where: { id: b2.id } });
      expect(b1InDb!.status).toBe('DRIVER_ASSIGNED');
      expect(b2InDb!.status).toBe('DRIVER_ASSIGNED');

      // Outbox Events -> DISPATCH_OFFER_ACCEPTED & TRIP_CREATED
      const offerAcceptedEvent = await prisma.outboxEvent.findFirst({
        where: {
          aggregateType: 'DRIVER_DISPATCH_OFFER',
          aggregateId: dispatchRes.offerId,
          eventType: 'DISPATCH_OFFER_ACCEPTED',
        },
      });
      expect(offerAcceptedEvent).toBeDefined();

      const tripCreatedEvent = await prisma.outboxEvent.findFirst({
        where: {
          aggregateType: 'TRIP',
          aggregateId: data.tripId,
          eventType: 'TRIP_CREATED',
        },
      });
      expect(tripCreatedEvent).toBeDefined();

      // 4. Test Idempotency Replay
      const repeatRes = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/accept`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .set('Idempotency-Key', idempotencyKey)
        .expect(200);

      expect(repeatRes.body.success).toBe(true);
      expect(repeatRes.body.data.tripId).toBe(data.tripId);
      expect(repeatRes.body.data.assignmentId).toBe(data.assignmentId);

      // Reset driver 1 back to AVAILABLE for subsequent tests
      await prisma.driverProfile.update({
        where: { id: driver1ProfileId },
        data: { operationalStatus: 'AVAILABLE' },
      });
    });

    it('should return 409 OFFER_ALREADY_TAKEN when offer is already accepted (new idempotency key)', async () => {
      const { group } = await createTestRideGroupFixture(`already-taken-${randomUUID().substring(0, 6)}`);

      const dispatchRes = await dispatchService.initiateDispatchForGroup(group.id);
      expect(dispatchRes.success).toBe(true);

      // Accept first time
      const acceptRes = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/accept`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .set('Idempotency-Key', `first-accept-${randomUUID()}`)
        .expect(200);
      createdTripIds.push(acceptRes.body.data.tripId);

      // Reset driver to AVAILABLE and mark assignment COMPLETED to test offer conflict specifically
      await prisma.driverAssignment.updateMany({
        where: { driverId: driver1ProfileId },
        data: { status: 'COMPLETED' },
      });
      await prisma.driverProfile.update({
        where: { id: driver1ProfileId },
        data: { operationalStatus: 'AVAILABLE' },
      });

      // Attempt second accept with different idempotency key
      const conflictRes = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/accept`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .set('Idempotency-Key', `different-key-${randomUUID()}`)
        .expect(409);

      expect(conflictRes.body.errorCode).toBe('OFFER_ALREADY_TAKEN');
    });

    it('should return 403 Forbidden when Driver 2 tries to accept Driver 1 offer', async () => {
      const { group } = await createTestRideGroupFixture(`unauth-drv-${randomUUID().substring(0, 6)}`);

      const dispatchRes = await dispatchService.initiateDispatchForGroup(group.id);
      expect(dispatchRes.success).toBe(true);
      expect(dispatchRes.driverId).toBe(driver1ProfileId);

      // Driver 2 attempts to accept Driver 1's offer
      const res = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/accept`)
        .set('Authorization', `Bearer ${driver2Token}`)
        .set('Idempotency-Key', `drv2-key-${randomUUID()}`)
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/drivers/offers/:id/reject and Cascade', () => {
    it('should return 400 Bad Request when Idempotency-Key is missing', async () => {
      const { group } = await createTestRideGroupFixture(`no-idemp-rej-${randomUUID().substring(0, 6)}`);
      const dispatchRes = await dispatchService.initiateDispatchForGroup(group.id);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/reject`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .expect(400);

      expect(res.body.errorCode).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('should reject offer, keep passenger group intact, and cascade immediately to Driver 2', async () => {
      // Ensure both drivers are AVAILABLE
      await prisma.driverProfile.update({
        where: { id: driver1ProfileId },
        data: { operationalStatus: 'AVAILABLE', isOnline: true },
      });
      await prisma.driverProfile.update({
        where: { id: driver2ProfileId },
        data: { operationalStatus: 'AVAILABLE', isOnline: true },
      });

      const { group, b1, b2 } = await createTestRideGroupFixture(`casc-test-${randomUUID().substring(0, 6)}`);

      // 1. Initial dispatch routes to Driver 1 (Rank 1)
      const dispatchRes = await dispatchService.initiateDispatchForGroup(group.id);
      expect(dispatchRes.success).toBe(true);
      expect(dispatchRes.driverId).toBe(driver1ProfileId);

      const rejectKey = `reject-key-${randomUUID()}`;

      // 2. Driver 1 rejects offer via HTTP
      const rejectRes = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/reject`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .set('Idempotency-Key', rejectKey)
        .send({ reason: 'Going off duty' })
        .expect(200);

      expect(rejectRes.body.success).toBe(true);
      expect(rejectRes.body.message).toBe('Offer rejected successfully');

      // 3. Verify Offer 1 is REJECTED
      const offer1 = await prisma.driverDispatchOffer.findUnique({
        where: { id: dispatchRes.offerId },
      });
      expect(offer1!.status).toBe('REJECTED');
      expect(offer1!.respondedAt).toBeDefined();

      // 4. Verify Ride Group remains INTACT (not dissolved, passengers not returned to matching)
      const groupInDb = await prisma.rideGroup.findUnique({
        where: { id: group.id },
      });
      expect(groupInDb!.status).toBe('DISPATCHING');

      const b1InDb = await prisma.booking.findUnique({ where: { id: b1.id } });
      const b2InDb = await prisma.booking.findUnique({ where: { id: b2.id } });
      expect(b1InDb!.status).toBe('MATCHED');
      expect(b2InDb!.status).toBe('MATCHED');

      // 5. Verify Automatic Cascade to Driver 2
      const pendingOffersForGroup = await prisma.driverDispatchOffer.findMany({
        where: {
          rideGroupId: group.id,
          status: 'PENDING',
        },
      });
      expect(pendingOffersForGroup).toHaveLength(1);
      expect(pendingOffersForGroup[0].driverId).toBe(driver2ProfileId);
      expect(pendingOffersForGroup[0].groupVersion).toBe(group.groupVersion);

      // 6. Verify Outbox Event DISPATCH_OFFER_REJECTED
      const rejectedEvent = await prisma.outboxEvent.findFirst({
        where: {
          aggregateType: 'DRIVER_DISPATCH_OFFER',
          aggregateId: dispatchRes.offerId,
          eventType: 'DISPATCH_OFFER_REJECTED',
        },
      });
      expect(rejectedEvent).toBeDefined();
      expect((rejectedEvent!.payload as any)?.reason).toBe('Going off duty');

      // 7. Idempotent repeat reject
      const repeatReject = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${dispatchRes.offerId}/reject`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .set('Idempotency-Key', rejectKey)
        .send({ reason: 'Going off duty' })
        .expect(200);
      expect(repeatReject.body.success).toBe(true);
    });
  });

  describe('Multi-Offer Receipt & Withdrawal (ADR-018)', () => {
    it('should withdraw Driver 1 other pending offers when Driver 1 accepts one group', async () => {
      // Ensure Driver 1 is AVAILABLE
      await prisma.driverProfile.update({
        where: { id: driver1ProfileId },
        data: { operationalStatus: 'AVAILABLE', isOnline: true },
      });

      // Create Group A and Group B
      const fixtureA = await createTestRideGroupFixture(`multi-a-${randomUUID().substring(0, 6)}`);
      const fixtureB = await createTestRideGroupFixture(`multi-b-${randomUUID().substring(0, 6)}`);

      // Dispatch Group A -> Offer A for Driver 1
      const resA = await dispatchService.initiateDispatchForGroup(fixtureA.group.id);
      expect(resA.success).toBe(true);
      expect(resA.driverId).toBe(driver1ProfileId);

      // Dispatch Group B -> Offer B for Driver 1 (Driver 1 can receive multiple offers per ADR-018)
      const resB = await dispatchService.initiateDispatchForGroup(fixtureB.group.id);
      expect(resB.success).toBe(true);
      expect(resB.driverId).toBe(driver1ProfileId);

      // Verify Driver 1 has 2 pending offers
      const pendingRes = await request(app.getHttpServer())
        .get('/api/v1/drivers/offers/pending')
        .set('Authorization', `Bearer ${driver1Token}`)
        .expect(200);
      expect(pendingRes.body.data.length).toBeGreaterThanOrEqual(2);

      // Driver 1 accepts Group A
      const acceptA = await request(app.getHttpServer())
        .post(`/api/v1/drivers/offers/${resA.offerId}/accept`)
        .set('Authorization', `Bearer ${driver1Token}`)
        .set('Idempotency-Key', `multi-accept-${randomUUID()}`)
        .expect(200);

      createdTripIds.push(acceptA.body.data.tripId);

      // Verify Offer A is ACCEPTED
      const offerA = await prisma.driverDispatchOffer.findUnique({
        where: { id: resA.offerId },
      });
      expect(offerA!.status).toBe('ACCEPTED');

      // Verify Offer B was WITHDRAWN atomically
      const offerB = await prisma.driverDispatchOffer.findUnique({
        where: { id: resB.offerId },
      });
      expect(offerB!.status).toBe('WITHDRAWN');

      // Verify Group B immediately cascaded to Driver 2!
      let groupBPendingOffers: any[] = [];
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        groupBPendingOffers = await prisma.driverDispatchOffer.findMany({
          where: {
            rideGroupId: fixtureB.group.id,
            status: 'PENDING',
          },
        });
        if (groupBPendingOffers.length > 0) break;
      }
      expect(groupBPendingOffers).toHaveLength(1);
      expect(groupBPendingOffers[0].driverId).toBe(driver2ProfileId);
    });
  });
});
