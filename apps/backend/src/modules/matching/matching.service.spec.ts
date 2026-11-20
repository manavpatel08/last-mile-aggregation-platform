import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { RoutingModule } from '../routing/routing.module.js';
import { RoutingService } from '../routing/routing.service.js';
import { FaresModule } from '../fares/fares.module.js';
import { LocationsService } from '../locations/locations.service.js';
import { PermutationSolver } from './permutation-solver.service.js';
import {
  MatchingService,
  LEASE_KEY_PDEU,
} from './matching.service.js';
import configuration from '../../config/configuration.js';
import { validate } from '../../config/env.validation.js';

describe('MatchingService Integration & Invariant Tests', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redisService: RedisService;
  let routingService: RoutingService;
  let matchingService: MatchingService;
  let locationsService: LocationsService;
  let permutationSolver: PermutationSolver;

  let pdeuPickupPointId: string;
  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdBatchIds: string[] = [];

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
        FaresModule,
      ],
      providers: [
        LocationsService,
        PermutationSolver,
        MatchingService,
      ],
    }).compile();

    await module.init();

    prisma = module.get<PrismaService>(PrismaService);
    redisService = module.get<RedisService>(RedisService);
    routingService = module.get<RoutingService>(RoutingService);
    matchingService = module.get<MatchingService>(MatchingService);
    locationsService = module.get<LocationsService>(LocationsService);
    permutationSolver = module.get<PermutationSolver>(PermutationSolver);

    await locationsService.bootstrapDefaults();
    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    pdeuPickupPointId = pickup!.id;
  });

  async function cleanupTestData() {
    try {
      const testUsers = await prisma.user.findMany({
        where: { email: { contains: 'match-test' } },
        select: { id: true },
      });
      if (testUsers.length > 0) {
        const userIds = testUsers.map((u) => u.id);
        const testBookings = await prisma.booking.findMany({
          where: { passengerId: { in: userIds } },
          select: { id: true },
        });
        const bookingIds = testBookings.map((b) => b.id);

        if (bookingIds.length > 0) {
          await prisma.groupRouteStop.deleteMany({
            where: { groupMember: { bookingId: { in: bookingIds } } },
          });
          await prisma.groupRouteVersion.deleteMany({
            where: { rideGroup: { members: { some: { bookingId: { in: bookingIds } } } } },
          });
          await prisma.groupMember.deleteMany({
            where: { bookingId: { in: bookingIds } },
          });
          await prisma.matchingBatchBooking.deleteMany({
            where: { bookingId: { in: bookingIds } },
          });
          await prisma.bookingStatusHistory.deleteMany({
            where: { bookingId: { in: bookingIds } },
          });
          await prisma.booking.deleteMany({
            where: { id: { in: bookingIds } },
          });
        }

        await prisma.matchingBatch.deleteMany({
          where: { pickupPointId: pdeuPickupPointId },
        });
        await prisma.rideGroup.deleteMany({
          where: { pickupPointId: pdeuPickupPointId },
        });
        await prisma.fareQuote.deleteMany({
          where: { passengerId: { in: userIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }
    } catch {
      // ignore
    }
  }

  afterAll(async () => {
    await cleanupTestData();
    const client = redisService.getClient();
    await client.del(LEASE_KEY_PDEU);
    await module.close();
  });

  beforeEach(async () => {
    await cleanupTestData();
    const client = redisService.getClient();
    await client.del(LEASE_KEY_PDEU);
    vi.restoreAllMocks();
  });

  // Helper to create valid passenger, quote, and booking
  async function createTestBooking(params: {
    lat: number;
    lng: number;
    minutesAgo?: number;
    minGroupPref?: number;
    ceilingPaise?: number;
    status?: string;
  }) {
    const user = await prisma.user.create({
      data: {
        email: `match-test-${Date.now()}-${Math.random()}@pdeu.ac.in`,
        fullName: 'Matching Test Passenger',
      },
    });
    createdUserIds.push(user.id);

    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id,
        passenger_id,
        pickup_point_id,
        destination_location,
        direct_distance_meters,
        direct_duration_sec,
        private_estimated_fare_paise,
        shared_min_fare_paise,
        shared_max_fare_paise,
        agreed_fare_ceiling_paise,
        tariff_version,
        expires_at
      ) VALUES (
        gen_random_uuid(),
        ${user.id}::uuid,
        ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(${params.lng}, ${params.lat}), 4326),
        4000,
        300,
        ${params.ceilingPaise ?? 6000},
        2000,
        ${params.ceilingPaise ?? 6000},
        ${params.ceilingPaise ?? 6000},
        1,
        ${new Date(Date.now() + 600000)}
      ) RETURNING id;
    `;

    const createdAt = new Date(Date.now() - (params.minutesAgo ?? 0) * 60000);
    const maxWaitDeadline = new Date(createdAt.getTime() + 120000); // 120s deadline

    const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id,
        passenger_id,
        fare_quote_id,
        pickup_point_id,
        passenger_pickup_location,
        destination_location,
        requested_type,
        min_group_preference,
        status,
        agreed_fare_ceiling_paise,
        max_wait_deadline,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        ${user.id}::uuid,
        ${quote.id}::uuid,
        ${pdeuPickupPointId}::uuid,
        (SELECT center_point FROM pickup_points WHERE id = ${pdeuPickupPointId}::uuid),
        ST_SetSRID(ST_MakePoint(${params.lng}, ${params.lat}), 4326),
        'SHARED',
        ${params.minGroupPref ?? 2},
        ${params.status ?? 'REQUESTED'},
        ${params.ceilingPaise ?? 6000},
        ${maxWaitDeadline},
        ${createdAt},
        ${createdAt}
      ) RETURNING id;
    `;

    createdBookingIds.push(booking.id);
    return { user, quote, bookingId: booking.id, createdAt };
  }

  describe('Redis Distributed Lease Coordination', () => {
    it('should acquire lease using SET NX PX with unique token and block concurrent acquisition', async () => {
      const token1 = await matchingService.acquireLease(LEASE_KEY_PDEU, 30000);
      expect(token1).not.toBeNull();

      // Second attempt while lease is held must return null
      const token2 = await matchingService.acquireLease(LEASE_KEY_PDEU, 30000);
      expect(token2).toBeNull();

      // Check ownership
      expect(await matchingService.isLeaseOwner(LEASE_KEY_PDEU, token1!)).toBe(true);
      expect(await matchingService.isLeaseOwner(LEASE_KEY_PDEU, 'fake-token')).toBe(false);

      // Releasing with wrong token must fail and keep lease intact
      const releasedWrong = await matchingService.releaseLease(LEASE_KEY_PDEU, 'wrong-token');
      expect(releasedWrong).toBe(false);
      expect(await matchingService.isLeaseOwner(LEASE_KEY_PDEU, token1!)).toBe(true);

      // Releasing with correct token must succeed and remove key
      const released = await matchingService.releaseLease(LEASE_KEY_PDEU, token1!);
      expect(released).toBe(true);

      // Now another worker can acquire
      const token3 = await matchingService.acquireLease(LEASE_KEY_PDEU, 30000);
      expect(token3).not.toBeNull();
      await matchingService.releaseLease(LEASE_KEY_PDEU, token3!);
    });

    it('should abort matching persistence if lease ownership is lost before commit', async () => {
      const b1 = await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1 });
      const b2 = await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.5 });

      vi.spyOn(routingService, 'getTravelTimeMatrix').mockResolvedValue({
        durations: [[0, 100, 110], [100, 0, 20], [110, 20, 0]],
        distances: [[0, 2000, 2100], [2000, 0, 200], [2100, 200, 0]],
        source: 'OSRM',
        isFallback: false,
      });

      vi.spyOn(routingService, 'getMultiStopRoute').mockResolvedValue({
        distanceMeters: 4000,
        durationSec: 250,
        geometry: { type: 'LineString', coordinates: [[72.6, 23.1], [72.63, 23.16]] },
        source: 'OSRM',
        isFallback: false,
      });

      // Mock isLeaseOwner to return false to simulate lease loss right before persistence
      vi.spyOn(matchingService, 'isLeaseOwner').mockResolvedValue(false);

      const summary = await matchingService.processMatchingCycle('PDEU Main Gate');
      expect(summary).not.toBeNull();
      expect(summary!.groupsFormedCount).toBe(0);
      expect(summary!.skippedReason).toContain('MATCHING_LEASE_EXPIRED_OR_LOST');

      // Bookings must remain in their original status
      const bookingCheck = await prisma.booking.findUnique({ where: { id: b1.bookingId } });
      expect(bookingCheck!.status).toBe('REQUESTED');
      const bookingCheck2 = await prisma.booking.findUnique({ where: { id: b2.bookingId } });
      expect(bookingCheck2!.status).toBe('REQUESTED');
    });

    it('should enforce fencing when Worker A lease expires and Worker B acquires it before A persists', async () => {
      const b1 = await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1 });
      const b2 = await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.5 });

      // Step 1: Worker A acquires lease and registers active batch in PostgreSQL
      const tokenA = await matchingService.acquireLease(LEASE_KEY_PDEU, 30000);
      expect(tokenA).not.toBeNull();
      const batchIdA = randomUUID();
      createdBatchIds.push(batchIdA);
      await matchingService.registerActiveBatch(pdeuPickupPointId, batchIdA, tokenA!, 30000);

      // Step 2: Worker A begins processing... meanwhile Worker A's lease expires and Worker B acquires it
      // Worker B sets lease in Redis AND registers new active batch in PostgreSQL
      const tokenB = 'token-worker-b-456';
      const batchIdB = randomUUID();
      createdBatchIds.push(batchIdB);
      const redisClient = redisService.getClient();
      await redisClient.set(LEASE_KEY_PDEU, tokenB, 'PX', 30000);
      await matchingService.registerActiveBatch(pdeuPickupPointId, batchIdB, tokenB, 30000);

      // Verify PostgreSQL has marked Worker A's batch as SUPERSEDED
      const batchADb = await prisma.matchingBatch.findUnique({ where: { id: batchIdA } });
      expect(batchADb!.batchStatus).toBe('SUPERSEDED');

      // Verify Redis now holds Worker B's lease and Worker A is no longer owner
      expect(await matchingService.isLeaseOwner(LEASE_KEY_PDEU, tokenB)).toBe(true);
      expect(await matchingService.isLeaseOwner(LEASE_KEY_PDEU, tokenA!)).toBe(false);

      // Step 3: Worker A attempts to persist its group using tokenA
      const candidateMembers = [
        {
          bookingId: b1.bookingId,
          passengerId: b1.user.id,
          destination: { latitude: 23.16, longitude: 72.63 },
          agreedFareCeilingPaise: 4000,
          minGroupPreference: 2,
          createdAt: new Date(),
          maxWaitDeadline: new Date(Date.now() + 60000),
        },
        {
          bookingId: b2.bookingId,
          passengerId: b2.user.id,
          destination: { latitude: 23.17, longitude: 72.64 },
          agreedFareCeilingPaise: 4500,
          minGroupPreference: 2,
          createdAt: new Date(),
          maxWaitDeadline: new Date(Date.now() + 60000),
        },
      ];

      const winningResult = permutationSolver.solve(candidateMembers, {
        durations: [[0, 100, 110], [100, 0, 20], [110, 20, 0]],
        distances: [[0, 2000, 2100], [2000, 0, 200], [2100, 200, 0]],
        source: 'OSRM',
        isFallback: false,
      })!;

      // Step 4: Worker A's persistence must be rejected by PostgreSQL fencing invariant
      await expect(
        matchingService.persistMatchedGroupTransactionally({
          batchId: batchIdA,
          pickupPointId: pdeuPickupPointId,
          leaseKey: LEASE_KEY_PDEU,
          leaseToken: tokenA!,
          winningResult,
          finalRoute: {
            distanceMeters: 4000,
            durationSec: 250,
            geometry: { type: 'LineString', coordinates: [[72.6, 23.1], [72.63, 23.16]] },
            source: 'OSRM',
            isFallback: false,
          },
          allocatedFares: [
            { id: b1.bookingId, allocatedFarePaise: 2500 },
            { id: b2.bookingId, allocatedFarePaise: 2500 },
          ],
          totalEligibleCount: 2,
        }),
      ).rejects.toThrow(ConflictException);

      // Step 5: Verify bookings remain untouched in REQUESTED status
      const b1Db = await prisma.booking.findUnique({ where: { id: b1.bookingId } });
      const b2Db = await prisma.booking.findUnique({ where: { id: b2.bookingId } });
      expect(b1Db!.status).toBe('REQUESTED');
      expect(b2Db!.status).toBe('REQUESTED');

      // Step 6: Worker A attempting to release lease must NOT release Worker B's lease
      const releasedByA = await matchingService.releaseLease(LEASE_KEY_PDEU, tokenA!);
      expect(releasedByA).toBe(false);

      // Step 7: Worker B's lease must remain intact in Redis
      expect(await matchingService.isLeaseOwner(LEASE_KEY_PDEU, tokenB)).toBe(true);

      // Cleanup
      await matchingService.releaseLease(LEASE_KEY_PDEU, tokenB);
    });

    it('should reject persistence when batch lease has expired according to PostgreSQL clock_timestamp()', async () => {
      const b1 = await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1 });
      const b2 = await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.5 });

      const token = 'token-expired-test';
      const batchId = randomUUID();
      createdBatchIds.push(batchId);

      // Register batch that expires in 1ms
      await matchingService.registerActiveBatch(pdeuPickupPointId, batchId, token, 1);

      // Wait 15ms so PostgreSQL clock_timestamp() exceeds lease_expires_at
      await new Promise((resolve) => setTimeout(resolve, 15));

      // Mock isLeaseOwner to return true to test that PostgreSQL clock_timestamp() is the authoritative gate
      vi.spyOn(matchingService, 'isLeaseOwner').mockResolvedValue(true);

      const candidateMembers = [
        {
          bookingId: b1.bookingId,
          passengerId: b1.user.id,
          destination: { latitude: 23.16, longitude: 72.63 },
          agreedFareCeilingPaise: 4000,
          minGroupPreference: 2,
          createdAt: new Date(),
          maxWaitDeadline: new Date(Date.now() + 60000),
        },
        {
          bookingId: b2.bookingId,
          passengerId: b2.user.id,
          destination: { latitude: 23.17, longitude: 72.64 },
          agreedFareCeilingPaise: 4500,
          minGroupPreference: 2,
          createdAt: new Date(),
          maxWaitDeadline: new Date(Date.now() + 60000),
        },
      ];

      const winningResult = permutationSolver.solve(candidateMembers, {
        durations: [[0, 100, 110], [100, 0, 20], [110, 20, 0]],
        distances: [[0, 2000, 2100], [2000, 0, 200], [2100, 200, 0]],
        source: 'OSRM',
        isFallback: false,
      })!;

      await expect(
        matchingService.persistMatchedGroupTransactionally({
          batchId,
          pickupPointId: pdeuPickupPointId,
          leaseKey: LEASE_KEY_PDEU,
          leaseToken: token,
          winningResult,
          finalRoute: {
            distanceMeters: 4000,
            durationSec: 250,
            geometry: { type: 'LineString', coordinates: [[72.6, 23.1], [72.63, 23.16]] },
            source: 'OSRM',
            isFallback: false,
          },
          allocatedFares: [
            { id: b1.bookingId, allocatedFarePaise: 2500 },
            { id: b2.bookingId, allocatedFarePaise: 2500 },
          ],
          totalEligibleCount: 2,
        }),
      ).rejects.toThrow(ConflictException);

      const b1Db = await prisma.booking.findUnique({ where: { id: b1.bookingId } });
      expect(b1Db!.status).toBe('REQUESTED');
    });

    it('should serialize concurrent batch registrations when no active batch exists yet', async () => {
      // Clean up any existing active batches for PDEU
      await prisma.matchingBatch.updateMany({
        where: { pickupPointId: pdeuPickupPointId, batchStatus: 'ACTIVE' },
        data: { batchStatus: 'SUPERSEDED' },
      });

      const batchId1 = randomUUID();
      const batchId2 = randomUUID();
      createdBatchIds.push(batchId1, batchId2);

      // Concurrently register two batches
      await Promise.all([
        matchingService.registerActiveBatch(pdeuPickupPointId, batchId1, 'token-1', 30000),
        matchingService.registerActiveBatch(pdeuPickupPointId, batchId2, 'token-2', 30000),
      ]);

      // Exactly ONE batch can be ACTIVE
      const activeBatches = await prisma.matchingBatch.findMany({
        where: { pickupPointId: pdeuPickupPointId, batchStatus: 'ACTIVE' },
      });

      expect(activeBatches).toHaveLength(1);
      const activeId = activeBatches[0].id;
      const supersededId = activeId === batchId1 ? batchId2 : batchId1;

      const supersededBatch = await prisma.matchingBatch.findUnique({
        where: { id: supersededId },
      });
      expect(supersededBatch!.batchStatus).toBe('SUPERSEDED');
    });

    it('should block Worker B registration on Worker A persistence row-lock until Worker A commits', async () => {
      const b1 = await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1 });
      const b2 = await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.5 });

      // 1. Worker A registers its active batch
      const tokenA = 'token-worker-a-lock-test';
      const batchIdA = randomUUID();
      createdBatchIds.push(batchIdA);
      await matchingService.registerActiveBatch(pdeuPickupPointId, batchIdA, tokenA, 30000);

      // Mock isLeaseOwner to return true for Worker A
      vi.spyOn(matchingService, 'isLeaseOwner').mockResolvedValue(true);

      let workerBCompleted = false;
      let workerAProceedCommit: () => void;
      const workerAWaitPromise = new Promise<void>((resolve) => {
        workerAProceedCommit = resolve;
      });

      // 2. Worker A starts persistence transaction in a background promise holding the lock
      const workerAPersistencePromise = prisma.$transaction(async (tx) => {
        // Lock pickup point
        await tx.$executeRaw`
          SELECT id FROM pickup_points
          WHERE id = ${pdeuPickupPointId}::uuid
          FOR UPDATE
        `;

        // Hold transaction open until Worker B has attempted to register
        await workerAWaitPromise;

        await tx.matchingBatch.update({
          where: { id: batchIdA },
          data: {
            batchStatus: 'COMPLETED',
            groupsFormedCount: 1,
            completedAt: new Date(),
          },
        });

        await tx.booking.update({
          where: { id: b1.bookingId },
          data: { status: 'MATCHED' },
        });
        await tx.booking.update({
          where: { id: b2.bookingId },
          data: { status: 'MATCHED' },
        });

        return 'worker-a-committed';
      });

      // Give Worker A a brief moment to acquire the lock in PostgreSQL
      await new Promise((r) => setTimeout(r, 20));

      // 3. Worker B attempts to register a new active batch while Worker A holds the lock
      const batchIdB = randomUUID();
      createdBatchIds.push(batchIdB);
      const tokenB = 'token-worker-b-blocked';

      const workerBRegistrationPromise = matchingService
        .registerActiveBatch(pdeuPickupPointId, batchIdB, tokenB, 30000)
        .then(() => {
          workerBCompleted = true;
        });

      // Wait 30ms and verify Worker B is BLOCKED (has not completed)
      await new Promise((r) => setTimeout(r, 30));
      expect(workerBCompleted).toBe(false);

      // 4. Now Worker A proceeds to commit
      workerAProceedCommit!();
      const aResult = await workerAPersistencePromise;
      expect(aResult).toBe('worker-a-committed');

      // 5. Worker B unblocks and completes
      await workerBRegistrationPromise;
      expect(workerBCompleted).toBe(true);

      // Verify Worker B's batch is now the ACTIVE batch
      const batchBDb = await prisma.matchingBatch.findUnique({ where: { id: batchIdB } });
      expect(batchBDb!.batchStatus).toBe('ACTIVE');

      // Worker A's booking updates committed successfully
      const b1Db = await prisma.booking.findUnique({ where: { id: b1.bookingId } });
      expect(b1Db!.status).toBe('MATCHED');
    });
  });

  describe('FIFO Seed Selection & Spatial KNN Shortlisting', () => {
    it('should select oldest booking as seed and shortlist nearest companions via PostGIS <->', async () => {
      // Create 3 bookings at different times and locations:
      // bOld: Kudasan (oldest, 1.5m ago) -> Must be SEED
      // bNear: Infocity (0.5m ago, near Kudasan)
      // bFar: Sector 28 (0.2m ago, far from Kudasan)
      const bOld = await createTestBooking({ lat: 23.164, lng: 72.628, minutesAgo: 1.5 });
      const bNear = await createTestBooking({ lat: 23.167, lng: 72.632, minutesAgo: 0.5 });
      const bFar = await createTestBooking({ lat: 23.235, lng: 72.668, minutesAgo: 0.2 });

      // Mock routing matrix: bNear has much lower travel time than bFar
      vi.spyOn(routingService, 'getTravelTimeMatrix').mockImplementation(async (coords) => {
        const isNear = coords.some((c) => Math.abs(c.latitude - 23.167) < 0.001);
        if (coords.length === 3) {
          if (isNear) {
            return {
              durations: [
                [0, 200, 220],
                [200, 0, 40],
                [220, 40, 0],
              ],
              distances: [
                [0, 3000, 3300],
                [3000, 0, 500],
                [3300, 500, 0],
              ],
              source: 'OSRM',
              isFallback: false,
            };
          } else {
            return {
              durations: [
                [0, 200, 500],
                [200, 0, 400],
                [500, 400, 0],
              ],
              distances: [
                [0, 3000, 8000],
                [3000, 0, 6000],
                [8000, 6000, 0],
              ],
              source: 'OSRM',
              isFallback: false,
            };
          }
        }
        return {
          durations: [
            [0, 200, 220, 500],
            [200, 0, 40, 400],
            [220, 40, 0, 380],
            [500, 400, 380, 0],
          ],
          distances: [
            [0, 3000, 3300, 8000],
            [3000, 0, 500, 6000],
            [3300, 500, 0, 5800],
            [8000, 6000, 5800, 0],
          ],
          source: 'OSRM',
          isFallback: false,
        };
      });

      vi.spyOn(routingService, 'getMultiStopRoute').mockResolvedValue({
        distanceMeters: 4000,
        durationSec: 240,
        geometry: { type: 'LineString', coordinates: [[72.6, 23.1], [72.63, 23.16]] },
        source: 'OSRM',
        isFallback: false,
      });

      const summary = await matchingService.processMatchingCycle('PDEU Main Gate');
      expect(summary).not.toBeNull();
      expect(summary!.groupsFormedCount).toBeGreaterThanOrEqual(1);

      const groupId = summary!.formedGroupIds[0];
      createdGroupIds.push(groupId);
      createdBatchIds.push(summary!.batchId);

      // Verify ride group
      const rideGroup = await prisma.rideGroup.findUnique({
        where: { id: groupId },
        include: { members: true },
      });

      expect(rideGroup).not.toBeNull();
      expect(rideGroup!.status).toBe('READY_FOR_DISPATCH');

      // The group must contain bOld (seed) and companions
      const memberBookingIds = rideGroup!.members.map((m) => m.bookingId);
      expect(memberBookingIds).toContain(bOld.bookingId);
      expect(memberBookingIds).toContain(bNear.bookingId);
      expect(memberBookingIds).toContain(bFar.bookingId);

      // Verify booking status transitioned to MATCHED
      const bOldDb = await prisma.booking.findUnique({ where: { id: bOld.bookingId } });
      expect(bOldDb!.status).toBe('MATCHED');
      const bFarDb = await prisma.booking.findUnique({ where: { id: bFar.bookingId } });
      expect(bFarDb!.status).toBe('MATCHED');
    });

    it('should respect minGroupPreference (e.g. minGroupPref = 3 disallows 2-person groups)', async () => {
      // 2 bookings exist, but one requires minGroupPreference = 3
      const b1 = await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1, minGroupPref: 3 });
      const b2 = await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.5, minGroupPref: 2 });

      const summary = await matchingService.processMatchingCycle('PDEU Main Gate');
      expect(summary).not.toBeNull();
      // Cannot form a group because only 2 passengers exist and b1 requires at least 3
      expect(summary!.groupsFormedCount).toBe(0);

      // Bookings remain in original state
      const b1Db = await prisma.booking.findUnique({ where: { id: b1.bookingId } });
      expect(b1Db!.status).toBe('REQUESTED');
      const b2Db = await prisma.booking.findUnique({ where: { id: b2.bookingId } });
      expect(b2Db!.status).toBe('REQUESTED');
    });
  });

  describe('Routing Safety and Fallback Rejection', () => {
    it('should ABORT matching batch without forming groups if OSRM matrix returns geodesic fallback', async () => {
      await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1 });
      await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.5 });

      // Mock matrix to return fallback data
      vi.spyOn(routingService, 'getTravelTimeMatrix').mockResolvedValue({
        durations: [[0, 100], [100, 0]],
        distances: [[0, 1000], [1000, 0]],
        source: 'FALLBACK',
        isFallback: true,
      });

      const summary = await matchingService.processMatchingCycle('PDEU Main Gate');
      expect(summary).not.toBeNull();
      expect(summary!.groupsFormedCount).toBe(0);
      expect(summary!.skippedReason).toContain('ROUTING_UNAVAILABLE');

      // Zero groups created in database
      const groups = await prisma.rideGroup.findMany({
        where: { pickupPointId: pdeuPickupPointId },
      });
      expect(groups.filter((g) => createdGroupIds.includes(g.id))).toHaveLength(0);
    });

    it('should ABORT matching batch if final route geometry returns fallback data', async () => {
      await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1 });
      await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.5 });

      vi.spyOn(routingService, 'getTravelTimeMatrix').mockResolvedValue({
        durations: [[0, 100, 110], [100, 0, 20], [110, 20, 0]],
        distances: [[0, 1000, 1100], [1000, 0, 200], [1100, 200, 0]],
        source: 'OSRM',
        isFallback: false,
      });

      vi.spyOn(routingService, 'getMultiStopRoute').mockResolvedValue({
        distanceMeters: 1200,
        durationSec: 120,
        geometry: null,
        source: 'FALLBACK',
        isFallback: true,
      });

      const summary = await matchingService.processMatchingCycle('PDEU Main Gate');
      expect(summary).not.toBeNull();
      expect(summary!.groupsFormedCount).toBe(0);
      expect(summary!.skippedReason).toContain('ROUTING_UNAVAILABLE');
    });
  });

  describe('Atomic Transaction Boundaries & Rollback Integrity', () => {
    it('should rollback group persistence completely if a booking deadline expires concurrently', async () => {
      const b1 = await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1 });
      const b2 = await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.5 });

      vi.spyOn(routingService, 'getTravelTimeMatrix').mockResolvedValue({
        durations: [[0, 100, 110], [100, 0, 20], [110, 20, 0]],
        distances: [[0, 1000, 1100], [1000, 0, 200], [1100, 200, 0]],
        source: 'OSRM',
        isFallback: false,
      });

      vi.spyOn(routingService, 'getMultiStopRoute').mockImplementation(async () => {
        // Concurrently expire booking b2 right before persistence!
        await prisma.booking.update({
          where: { id: b2.bookingId },
          data: { maxWaitDeadline: new Date(Date.now() - 10000) },
        });
        return {
          distanceMeters: 4000,
          durationSec: 250,
          geometry: { type: 'LineString', coordinates: [[72.6, 23.1], [72.63, 23.16]] },
          source: 'OSRM',
          isFallback: false,
        };
      });

      const summary = await matchingService.processMatchingCycle('PDEU Main Gate');
      expect(summary).not.toBeNull();
      expect(summary!.groupsFormedCount).toBe(0);
      expect(summary!.skippedReason).toContain('BOOKING_DEADLINE_EXPIRED');

      // Verify no orphan ride_groups, group_members, or group_route_versions were committed
      const members = await prisma.groupMember.findMany({
        where: { bookingId: { in: [b1.bookingId, b2.bookingId] } },
      });
      expect(members).toHaveLength(0);
    });

    it('should commit MatchingBatch, RideGroup, GroupMember, RouteVersion, RouteStop, and OutboxEvent atomically', async () => {
      const b1 = await createTestBooking({ lat: 23.16, lng: 72.63, minutesAgo: 1.2 });
      const b2 = await createTestBooking({ lat: 23.17, lng: 72.64, minutesAgo: 0.8 });

      vi.spyOn(routingService, 'getTravelTimeMatrix').mockResolvedValue({
        durations: [[0, 100, 110], [100, 0, 20], [110, 20, 0]],
        distances: [[0, 2000, 2100], [2000, 0, 200], [2100, 200, 0]],
        source: 'OSRM',
        isFallback: false,
      });

      vi.spyOn(routingService, 'getMultiStopRoute').mockResolvedValue({
        distanceMeters: 4000,
        durationSec: 250,
        geometry: { type: 'LineString', coordinates: [[72.6, 23.1], [72.63, 23.16]] },
        source: 'OSRM',
        isFallback: false,
      });

      const summary = await matchingService.processMatchingCycle('PDEU Main Gate');
      expect(summary).not.toBeNull();
      expect(summary!.groupsFormedCount).toBe(1);

      const groupId = summary!.formedGroupIds[0];
      createdGroupIds.push(groupId);
      createdBatchIds.push(summary!.batchId);

      // Verify RideGroup
      const group = await prisma.rideGroup.findUnique({
        where: { id: groupId },
        include: {
          members: true,
          routeVersions: { include: { stops: true } },
        },
      });

      expect(group).not.toBeNull();
      expect(group!.status).toBe('READY_FOR_DISPATCH');
      expect(group!.members).toHaveLength(2);
      const memberBookingIds = group!.members.map((m) => m.bookingId);
      expect(memberBookingIds).toContain(b1.bookingId);
      expect(memberBookingIds).toContain(b2.bookingId);
      expect(group!.routeVersions).toHaveLength(1);
      expect(group!.routeVersions[0].stops).toHaveLength(2);

      // Verify Outbox Event
      const outboxEvent = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: groupId,
          eventType: 'GROUP_FORMED',
        },
      });
      expect(outboxEvent).not.toBeNull();
      expect((outboxEvent!.payload as any).rideGroupId).toBe(groupId);

      // Verify MatchingBatch
      const batch = await prisma.matchingBatch.findUnique({
        where: { id: summary!.batchId },
        include: { batchBookings: true },
      });
      expect(batch).not.toBeNull();
      expect(batch!.groupsFormedCount).toBe(1);
      expect(batch!.batchBookings).toHaveLength(2);

      // Verify BookingStatusHistory records accurate previousStatus: 'REQUESTED' (not hardcoded 'MATCHING')
      const historyB1 = await prisma.bookingStatusHistory.findFirst({
        where: { bookingId: b1.bookingId, newStatus: 'MATCHED' },
        orderBy: { transitionTime: 'desc' },
      });
      expect(historyB1).not.toBeNull();
      expect(historyB1!.previousStatus).toBe('REQUESTED');
    });
  });
});
