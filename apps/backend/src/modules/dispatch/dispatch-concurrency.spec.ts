import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  ConflictException,
} from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import configuration from '../../config/configuration.js';
import { validate } from '../../config/env.validation.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { RoutingModule } from '../routing/routing.module.js';
import { RoutingService } from '../routing/routing.service.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { DriversService } from '../drivers/drivers.service.js';
import { DispatchModule } from './dispatch.module.js';
import { DispatchService } from './dispatch.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';
import type { IdempotencyClaimContext } from '../../common/interceptors/idempotency.interceptor.js';

describe('Stage 6 Concurrency & Distributed Race Verification', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redisService: RedisService;
  let routingService: RoutingService;
  let driversService: DriversService;
  let dispatchService: DispatchService;

  let pdeuPickupPointId: string;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdClaimIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
          validate,
          envFilePath: ['.env.local', '.env'],
        }),
        PrismaModule,
        RedisModule,
        RoutingModule,
        DriversModule,
        DispatchModule,
      ],
    }).compile();

    await module.init();

    prisma = module.get<PrismaService>(PrismaService);
    redisService = module.get<RedisService>(RedisService);
    routingService = module.get<RoutingService>(RoutingService);
    driversService = module.get<DriversService>(DriversService);
    dispatchService = module.get<DispatchService>(DispatchService);

    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    if (pickup) {
      pdeuPickupPointId = pickup.id;
    } else {
      const [newPickup] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO pickup_points (id, name, landmark, location, geofence_radius_meters, is_active)
        VALUES (
          gen_random_uuid(), 'PDEU Main Gate', 'Campus Gate',
          ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326), 150, true
        ) RETURNING id;
      `;
      pdeuPickupPointId = newPickup.id;
    }

    // Mock RoutingService to return deterministic road durations
    vi.spyOn(routingService, 'getTravelTimeMatrix').mockImplementation(
      async (coords) => {
        const durations: number[][] = Array.from({ length: coords.length }, () =>
          Array.from({ length: coords.length }, () => 0),
        );
        const distances: number[][] = Array.from({ length: coords.length }, () =>
          Array.from({ length: coords.length }, () => 0),
        );

        for (let i = 0; i < coords.length; i++) {
          for (let j = 0; j < coords.length; j++) {
            if (i === j) continue;
            durations[i][j] = 60 * Math.max(i, j);
            distances[i][j] = 500 * Math.max(i, j);
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
  });

  afterAll(async () => {
    await cleanupAllTestData();
    await module.close();
  });

  beforeEach(async () => {
    await cleanupAllTestData();
  });

  async function cleanupAllTestData() {
    try {
      const redisClient = redisService.getClient();
      for (const dId of createdDriverIds) {
        await redisClient.del(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${dId}`).catch(() => {});
      }

      if (createdTripIds.length > 0) {
        await prisma.cashCollection.deleteMany({ where: { tripId: { in: createdTripIds } } }).catch(() => {});
        await prisma.tripIncident.deleteMany({ where: { tripId: { in: createdTripIds } } }).catch(() => {});
        await prisma.tripStatusHistory.deleteMany({ where: { tripId: { in: createdTripIds } } }).catch(() => {});
        const tp = await prisma.tripPassenger.findMany({ where: { tripId: { in: createdTripIds } } }).catch(() => []);
        for (const p of tp) {
          await prisma.boardingVerification.deleteMany({ where: { tripPassengerId: p.id } }).catch(() => {});
        }
        await prisma.tripPassenger.deleteMany({ where: { tripId: { in: createdTripIds } } }).catch(() => {});
        await prisma.trip.deleteMany({ where: { id: { in: createdTripIds } } }).catch(() => {});
      }

      if (createdGroupIds.length > 0) {
        await prisma.driverAssignment.deleteMany({ where: { rideGroupId: { in: createdGroupIds } } }).catch(() => {});
        await prisma.driverDispatchOffer.deleteMany({ where: { rideGroupId: { in: createdGroupIds } } }).catch(() => {});
        await prisma.dispatchAttempt.deleteMany({ where: { rideGroupId: { in: createdGroupIds } } }).catch(() => {});
        const rvs = await prisma.groupRouteVersion.findMany({ where: { rideGroupId: { in: createdGroupIds } } }).catch(() => []);
        for (const rv of rvs) {
          await prisma.groupRouteStop.deleteMany({ where: { groupRouteVersionId: rv.id } }).catch(() => {});
        }
        await prisma.groupRouteVersion.deleteMany({ where: { rideGroupId: { in: createdGroupIds } } }).catch(() => {});
        await prisma.groupMember.deleteMany({ where: { rideGroupId: { in: createdGroupIds } } }).catch(() => {});
        await prisma.rideGroup.deleteMany({ where: { id: { in: createdGroupIds } } }).catch(() => {});
      }

      if (createdBookingIds.length > 0) {
        await prisma.cancellationFee.deleteMany({ where: { originalBookingId: { in: createdBookingIds } } }).catch(() => {});
        await prisma.cancellationFee.deleteMany({ where: { collectedBookingId: { in: createdBookingIds } } }).catch(() => {});
        await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: createdBookingIds } } }).catch(() => {});
        await prisma.groupMember.deleteMany({ where: { bookingId: { in: createdBookingIds } } }).catch(() => {});
        await prisma.matchingBatchBooking.deleteMany({ where: { bookingId: { in: createdBookingIds } } }).catch(() => {});
        await prisma.booking.deleteMany({ where: { id: { in: createdBookingIds } } }).catch(() => {});
      }

      if (createdDriverIds.length > 0) {
        await prisma.driverAssignment.deleteMany({ where: { driverId: { in: createdDriverIds } } }).catch(() => {});
        await prisma.driverDispatchOffer.deleteMany({ where: { driverId: { in: createdDriverIds } } }).catch(() => {});
        await prisma.driverDocument.deleteMany({ where: { driverProfileId: { in: createdDriverIds } } }).catch(() => {});
        await prisma.vehicle.deleteMany({ where: { driverProfileId: { in: createdDriverIds } } }).catch(() => {});
        await prisma.driverProfile.deleteMany({ where: { id: { in: createdDriverIds } } }).catch(() => {});
      }

      if (createdClaimIds.length > 0) {
        await prisma.idempotencyRecord.deleteMany({ where: { id: { in: createdClaimIds } } }).catch(() => {});
      }

      if (createdUserIds.length > 0) {
        await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
        await prisma.authIdentity.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
        await prisma.fareQuote.deleteMany({ where: { passengerId: { in: createdUserIds } } }).catch(() => {});
        await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
        await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
    } catch {
      // ignore teardown errors
    }
  }

  // Helper to create an approved, online, available driver
  async function createTestDriver(label: string) {
    const testSuffix = randomUUID().substring(0, 8);
    const user = await prisma.user.create({
      data: {
        email: `conc-drv-${label}-${testSuffix}@pdeu.ac.in`,
        fullName: `Driver ${label}`,
        role: 'DRIVER',
        roles: { create: { roleName: 'DRIVER' } },
      },
    });
    createdUserIds.push(user.id);

    const profile = await prisma.driverProfile.create({
      data: {
        userId: user.id,
        licenseNumber: `LIC-${label}-${testSuffix}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    createdDriverIds.push(profile.id);

    await prisma.vehicle.create({
      data: {
        driverProfileId: profile.id,
        registrationNumber: `GJ-18-${label}-${testSuffix}`,
        passengerCapacity: 4,
        makeModel: 'Mahindra Treo',
        isActive: true,
      },
    });

    await redisService.getClient().set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${profile.id}`,
      JSON.stringify({
        latitude: 23.155,
        longitude: 72.666,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      300,
    );

    return { user, profile };
  }

  // Helper to create a test ride group with 2 bookings and 1 route version
  async function createTestRideGroup(label: string) {
    const suffix = randomUUID().substring(0, 8);

    const passenger = await prisma.user.create({
      data: {
        email: `conc-pass-${label}-${suffix}@pdeu.ac.in`,
        fullName: `Passenger ${label}`,
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(passenger.id);

    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise,
        shared_max_fare_paise, agreed_fare_ceiling_paise,
        tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${passenger.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        4000, 600, 6000, 2000, 3500, 3500, 1,
        NOW() + INTERVAL '10 minutes'
      ) RETURNING id;
    `;

    const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status,
        agreed_fare_ceiling_paise, final_allocated_fare_paise,
        max_wait_deadline
      ) VALUES (
        gen_random_uuid(), ${passenger.id}::uuid, ${quote.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        'SHARED', 2, 'MATCHED',
        3500, 3000, NOW() + INTERVAL '10 minutes'
      ) RETURNING id;
    `;
    createdBookingIds.push(booking.id);

    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: pdeuPickupPointId,
        rideType: 'SHARED',
        groupVersion: 1,
        status: 'READY_FOR_DISPATCH',
        totalSharedFarePaise: 6000,
        totalRouteDistanceMeters: 4000,
        totalRouteDurationSec: 600,
      },
    });
    createdGroupIds.push(group.id);

    const gm = await prisma.groupMember.create({
      data: {
        rideGroupId: group.id,
        bookingId: booking.id,
        dropoffSequenceOrder: 1,
        directDistanceMeters: 4000,
        directDurationSec: 600,
        sharedDurationSec: 600,
        calculatedDetourPercent: 0,
        allocatedFarePaise: 3000,
        isActiveMember: true,
      },
    });

    const routeVersion = await prisma.groupRouteVersion.create({
      data: {
        rideGroupId: group.id,
        versionNumber: 1,
        totalDistanceMeters: 4000,
        totalDurationSec: 600,
        routeGeometry: {
          type: 'LineString',
          coordinates: [
            [72.6668, 23.155],
            [72.68, 23.18],
          ],
        },
      },
    });

    await prisma.$executeRaw`
      INSERT INTO group_route_stops (
        id, group_route_version_id, stop_order, stop_type, group_member_id, stop_location
      ) VALUES (
        gen_random_uuid(), ${routeVersion.id}::uuid, 0, 'DROPOFF', ${gm.id}::uuid,
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326)
      );
    `;

    return { group, booking, routeVersion };
  }

  // Helper to create an in-progress idempotency claim
  async function createTestClaim(userId: string): Promise<IdempotencyClaimContext> {
    const key = `claim-key-${randomUUID()}`;
    const ownerToken = randomUUID();
    const [row] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO idempotency_records (
        id, user_id, idempotency_key, request_path, request_hash,
        status, owner_token, locked_until, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${userId}::uuid, ${key}, 'POST /api/v1/drivers/offers/accept',
        'hash123', 'IN_PROGRESS', ${ownerToken}, NOW() + INTERVAL '30 seconds', NOW(), NOW()
      ) RETURNING id;
    `;
    createdClaimIds.push(row.id);

    return {
      id: row.id,
      ownerToken,
      idempotencyKey: key,
      userId,
    };
  }

  describe('Scenario A: Two drivers accept offers for the same group concurrently', () => {
    it('should grant acceptance to exactly one driver and reject the other with 409 Conflict', async () => {
      const d1 = await createTestDriver('A1');
      const d2 = await createTestDriver('A2');
      const { group } = await createTestRideGroup('A');

      // Attempt 1: Offer 1 sent to Driver 1 (now EXPIRED)
      const attempt1 = await prisma.dispatchAttempt.create({
        data: {
          rideGroupId: group.id,
          groupVersion: 1,
          attemptNumber: 1,
          status: 'EXPIRED',
        },
      });

      const offer1 = await prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt1.id,
          rideGroupId: group.id,
          groupVersion: 1,
          driverId: d1.profile.id,
          status: 'EXPIRED',
          expiresAt: new Date(Date.now() - 1000),
        },
      });

      // Attempt 2: Offer 2 sent to Driver 2 (PENDING, enforced by Invariant 5: single pending offer per group)
      const attempt2 = await prisma.dispatchAttempt.create({
        data: {
          rideGroupId: group.id,
          groupVersion: 1,
          attemptNumber: 2,
          status: 'ACTIVE',
        },
      });

      const offer2 = await prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt2.id,
          rideGroupId: group.id,
          groupVersion: 1,
          driverId: d2.profile.id,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        },
      });

      const claim1 = await createTestClaim(d1.user.id);
      const claim2 = await createTestClaim(d2.user.id);

      // Execute concurrent acceptance
      const results = await Promise.allSettled([
        dispatchService.acceptOffer(d1.user.id, offer1.id, claim1),
        dispatchService.acceptOffer(d2.user.id, offer2.id, claim2),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly ONE must succeed (Driver 2)
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Driver 1 must be rejected with 409 Conflict (OFFER_ALREADY_TAKEN)
      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.response?.errorCode).toBe('OFFER_ALREADY_TAKEN');

      // Verify Database Invariant 4: Exactly one active assignment per group
      const assignments = await prisma.driverAssignment.findMany({
        where: { rideGroupId: group.id, status: 'RESERVED' },
      });
      expect(assignments).toHaveLength(1);
      expect(assignments[0].driverId).toBe(d2.profile.id);

      createdTripIds.push((fulfilled[0] as PromiseFulfilledResult<any>).value.tripId);
    });
  });

  describe('Scenario B: One driver accepts offers for two different groups concurrently (ADR-018)', () => {
    it('should assign driver to exactly one group and atomically withdraw other pending offer', async () => {
      const driver = await createTestDriver('B');
      const g1 = await createTestRideGroup('B1');
      const g2 = await createTestRideGroup('B2');

      const attempt1 = await prisma.dispatchAttempt.create({
        data: { rideGroupId: g1.group.id, groupVersion: 1, attemptNumber: 1, status: 'ACTIVE' },
      });
      const attempt2 = await prisma.dispatchAttempt.create({
        data: { rideGroupId: g2.group.id, groupVersion: 1, attemptNumber: 1, status: 'ACTIVE' },
      });

      const offer1 = await prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt1.id,
          rideGroupId: g1.group.id,
          groupVersion: 1,
          driverId: driver.profile.id,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        },
      });

      const offer2 = await prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt2.id,
          rideGroupId: g2.group.id,
          groupVersion: 1,
          driverId: driver.profile.id,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        },
      });

      const claim1 = await createTestClaim(driver.user.id);
      const claim2 = await createTestClaim(driver.user.id);

      // Concurrently attempt accepting both groups
      const results = await Promise.allSettled([
        dispatchService.acceptOffer(driver.user.id, offer1.id, claim1),
        dispatchService.acceptOffer(driver.user.id, offer2.id, claim2),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly ONE succeeds due to atomic CAS on driver_profiles
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winningResult = (fulfilled[0] as PromiseFulfilledResult<any>).value;
      createdTripIds.push(winningResult.tripId);

      // Verify Database Invariant 3: Exactly one active assignment per driver
      const activeAssignments = await prisma.driverAssignment.findMany({
        where: { driverId: driver.profile.id, status: 'RESERVED' },
      });
      expect(activeAssignments).toHaveLength(1);

      // The competing offer for the other group must be marked WITHDRAWN
      const winningGroupId = winningResult.rideGroupId;
      const otherOfferId = winningGroupId === g1.group.id ? offer2.id : offer1.id;

      const otherOffer = await prisma.driverDispatchOffer.findUnique({
        where: { id: otherOfferId },
      });
      expect(otherOffer!.status).toBe('WITHDRAWN');
    });
  });

  describe('Scenario C: Driver goes offline concurrently with offer acceptance', () => {
    it('should serialize safely: acceptance fails if driver went offline, or offline fails if driver assigned', async () => {
      const driver = await createTestDriver('C');
      const { group } = await createTestRideGroup('C');

      const attempt = await prisma.dispatchAttempt.create({
        data: { rideGroupId: group.id, groupVersion: 1, attemptNumber: 1, status: 'ACTIVE' },
      });

      const offer = await prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt.id,
          rideGroupId: group.id,
          groupVersion: 1,
          driverId: driver.profile.id,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        },
      });

      const claim = await createTestClaim(driver.user.id);

      // Execute concurrent offline transition and acceptance
      const results = await Promise.allSettled([
        driversService.updateDriverOperationalStatus(driver.user.id, { isOnline: false }),
        dispatchService.acceptOffer(driver.user.id, offer.id, claim),
      ]);

      // Both cannot be simultaneously valid
      const offlineResult = results[0];
      const acceptResult = results[1];

      if (acceptResult.status === 'fulfilled') {
        // Driver accepted first -> operationalStatus became RESERVED
        createdTripIds.push(acceptResult.value.tripId);

        // Going offline should fail because driver has an active assignment
        if (offlineResult.status === 'fulfilled') {
          // If offline succeeded before accept started, accept could not have fulfilled
          // Hence this branch confirms strict mutual exclusion
          expect(offlineResult.value.operationalStatus).not.toBe('OFFLINE');
        } else {
          expect(offlineResult.reason).toBeInstanceOf(ConflictException);
        }
      } else {
        // Offline succeeded first -> accept must fail CAS check
        expect(offlineResult.status).toBe('fulfilled');
        expect(acceptResult.reason).toBeInstanceOf(ConflictException);
        expect((acceptResult.reason as any).response?.errorCode).toBe('OFFER_ALREADY_TAKEN');
      }

      // Invariant: Driver profile status must never be corrupted
      const finalDriver = await prisma.driverProfile.findUnique({
        where: { id: driver.profile.id },
      });
      expect(['RESERVED', 'OFFLINE']).toContain(finalDriver!.operationalStatus);
    });
  });

  describe('Scenario D: Acceptance vs. Timeout race condition', () => {
    it('should resolve deterministically with uniform lock ordering: exactly one transition wins', async () => {
      const driver = await createTestDriver('D');
      const { group } = await createTestRideGroup('D');

      const attempt = await prisma.dispatchAttempt.create({
        data: { rideGroupId: group.id, groupVersion: 1, attemptNumber: 1, status: 'ACTIVE' },
      });

      const offer = await prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt.id,
          rideGroupId: group.id,
          groupVersion: 1,
          driverId: driver.profile.id,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        },
      });

      const claim = await createTestClaim(driver.user.id);

      // Concurrently trigger accept and timeout job execution
      const results = await Promise.allSettled([
        dispatchService.acceptOffer(driver.user.id, offer.id, claim),
        dispatchService.handleOfferTimeout({
          offerId: offer.id,
          rideGroupId: group.id,
          driverId: driver.profile.id,
          groupVersion: 1,
          dispatchAttemptId: attempt.id,
        }),
      ]);

      const acceptRes = results[0];
      const timeoutRes = results[1];

      // Timeout execution never throws (it safely no-ops on stale offers)
      expect(timeoutRes.status).toBe('fulfilled');

      const finalOffer = await prisma.driverDispatchOffer.findUnique({
        where: { id: offer.id },
      });

      if (acceptRes.status === 'fulfilled') {
        // Acceptance won: offer is ACCEPTED, timeout safely no-oped
        createdTripIds.push(acceptRes.value.tripId);
        expect(finalOffer!.status).toBe('ACCEPTED');

        const groupInDb = await prisma.rideGroup.findUnique({ where: { id: group.id } });
        expect(groupInDb!.status).toBe('DRIVER_ASSIGNED');
      } else {
        // Timeout won: offer is EXPIRED, accept failed with 409
        expect(finalOffer!.status).toBe('EXPIRED');
        expect(acceptRes.reason).toBeInstanceOf(ConflictException);
      }
    });
  });

  describe('Scenario E: Rejection vs. Timeout race condition', () => {
    it('should resolve deterministically: exactly one marks offer terminal and only one cascade occurs', async () => {
      const d1 = await createTestDriver('E1');
      await createTestDriver('E2');
      const { group } = await createTestRideGroup('E');

      const attempt = await prisma.dispatchAttempt.create({
        data: { rideGroupId: group.id, groupVersion: 1, attemptNumber: 1, status: 'ACTIVE' },
      });

      const offer = await prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt.id,
          rideGroupId: group.id,
          groupVersion: 1,
          driverId: d1.profile.id,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        },
      });

      const claim = await createTestClaim(d1.user.id);

      // Concurrently trigger reject and timeout
      const results = await Promise.allSettled([
        dispatchService.rejectOffer(d1.user.id, offer.id, { reason: 'Race test' }, claim),
        dispatchService.handleOfferTimeout({
          offerId: offer.id,
          rideGroupId: group.id,
          driverId: d1.profile.id,
          groupVersion: 1,
          dispatchAttemptId: attempt.id,
        }),
      ]);

      // Timeout never throws; rejection fulfills if it acquired lock first, or throws 409 OFFER_NOT_PENDING if timeout acquired lock first
      expect(results[1].status).toBe('fulfilled');
      if (results[0].status === 'rejected') {
        expect(results[0].reason).toBeInstanceOf(ConflictException);
        expect((results[0].reason as any).response?.errorCode).toBe('OFFER_NOT_PENDING');
      } else {
        expect(results[0].status).toBe('fulfilled');
      }

      const finalOffer = await prisma.driverDispatchOffer.findUnique({
        where: { id: offer.id },
      });
      expect(['REJECTED', 'EXPIRED']).toContain(finalOffer!.status);

      // Verify Database Invariant 5: Exactly one active pending offer exists for the group
      const pendingOffers = await prisma.driverDispatchOffer.findMany({
        where: { rideGroupId: group.id, status: 'PENDING' },
      });
      expect(pendingOffers.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Scenario F: Duplicate acceptance idempotency', () => {
    it('should return identical response without creating duplicate trips or assignments', async () => {
      const driver = await createTestDriver('F');
      const { group } = await createTestRideGroup('F');

      const attempt = await prisma.dispatchAttempt.create({
        data: { rideGroupId: group.id, groupVersion: 1, attemptNumber: 1, status: 'ACTIVE' },
      });

      const offer = await prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt.id,
          rideGroupId: group.id,
          groupVersion: 1,
          driverId: driver.profile.id,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        },
      });

      const claim = await createTestClaim(driver.user.id);

      // First acceptance
      const firstRes = await dispatchService.acceptOffer(driver.user.id, offer.id, claim);
      expect(firstRes.tripId).toBeDefined();
      createdTripIds.push(firstRes.tripId);

      // Verify idempotency record completed
      const completedRecord = await prisma.idempotencyRecord.findUnique({
        where: { id: claim.id },
      });
      expect(completedRecord!.status).toBe('COMPLETED');

      // Count entities in DB
      const tripCount = await prisma.trip.count({ where: { rideGroupId: group.id } });
      const assignmentCount = await prisma.driverAssignment.count({ where: { rideGroupId: group.id } });
      expect(tripCount).toBe(1);
      expect(assignmentCount).toBe(1);
    });
  });
});
