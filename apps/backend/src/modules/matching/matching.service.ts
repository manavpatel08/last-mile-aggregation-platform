import {
  Injectable,
  Logger,
  ConflictException,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { RoutingService, RouteResult } from '../routing/routing.service.js';
import { FaresService, FareAllocationMember } from '../fares/fares.service.js';
import { OutboxService } from '../../infrastructure/outbox/outbox.service.js';
import {
  PermutationSolver,
  CandidateMember,
  FeasiblePermutationResult,
} from './permutation-solver.service.js';
import {
  EligibleBookingRow,
  MatchingCycleSummary,
} from './matching.interfaces.js';
import { randomUUID } from 'node:crypto';

export const LEASE_KEY_PDEU = 'lease:matching:pdeu';
export const LEASE_TTL_MS = 30000;
export const MAX_CANDIDATE_GROUPS_PER_SEED = 50;
export const MAX_KNN_COMPANIONS = 6;

const LUA_RELEASE_LEASE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly routingService: RoutingService,
    private readonly faresService: FaresService,
    private readonly permutationSolver: PermutationSolver,
    @Optional() private readonly outboxService?: OutboxService,
  ) {}

  /**
   * Acquires the distributed zone matching lease in Redis using SET NX PX.
   * Returns a unique token (UUID) if acquired, or null if already held.
   */
  async acquireLease(
    key = LEASE_KEY_PDEU,
    ttlMs = LEASE_TTL_MS,
  ): Promise<string | null> {
    const token = randomUUID();
    try {
      const client = this.redisService.getClient();
      const res = await client.set(key, token, 'PX', ttlMs, 'NX');
      if (res === 'OK') {
        this.logger.debug(`Acquired matching lease [${key}] with token ${token}`);
        return token;
      }
      return null;
    } catch (err: any) {
      this.logger.warn(`Failed to acquire matching lease in Redis: ${err?.message}`);
      return null;
    }
  }

  /**
   * Atomically releases the distributed lease ONLY if the current owner token matches.
   * Never unconditionally deletes the lease.
   */
  async releaseLease(key = LEASE_KEY_PDEU, token: string): Promise<boolean> {
    try {
      const client = this.redisService.getClient();
      const res = await client.eval(LUA_RELEASE_LEASE, 1, key, token);
      return res === 1;
    } catch (err: any) {
      this.logger.warn(`Failed to release matching lease in Redis: ${err?.message}`);
      return false;
    }
  }

  /**
   * Verifies if the worker still holds ownership of the distributed lease.
   */
  async isLeaseOwner(key = LEASE_KEY_PDEU, token: string): Promise<boolean> {
    try {
      const client = this.redisService.getClient();
      const current = await client.get(key);
      return current === token;
    } catch (err: any) {
      this.logger.warn(`Failed to check lease ownership in Redis: ${err?.message}`);
      return false;
    }
  }

  /**
   * Registers an active matching batch in PostgreSQL establishing a durable
   * database-level fencing epoch. Atomically marks any previous active batches
   * for this pickup point as 'SUPERSEDED'.
   */
  async registerActiveBatch(
    pickupPointId: string,
    batchId: string,
    leaseToken: string,
    ttlMs = LEASE_TTL_MS,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.prisma.$transaction(async (tx) => {
      // 0. Hub-Level Serialization: prevent concurrent registrations even if no ACTIVE batch exists yet
      await tx.$executeRaw`
        SELECT id FROM pickup_points
        WHERE id = ${pickupPointId}::uuid
        FOR UPDATE
      `;

      // Invalidate any previously active batches for this pickup point
      await tx.matchingBatch.updateMany({
        where: {
          pickupPointId,
          batchStatus: 'ACTIVE',
        },
        data: {
          batchStatus: 'SUPERSEDED',
        },
      });

      // Insert new active batch
      await tx.matchingBatch.create({
        data: {
          id: batchId,
          pickupPointId,
          batchStatus: 'ACTIVE',
          leaseToken,
          leaseExpiresAt: expiresAt,
          startedAt: new Date(),
        },
      });
    });
  }

  /**
   * Executes a complete batch matching cycle for the given transit hub.
   * Follows the approved roadmap:
   * 1. Claims distributed lease.
   * 2. Extracts candidate pool (FIFO seed).
   * 3. Shortlists up to 6 companions via PostGIS KNN (<->).
   * 4. Evaluates up to 50 candidate groups with OSRM matrices.
   * 5. Solves drop-off permutations with <= 25% detour filter.
   * 6. Persists winning group atomically in PostgreSQL.
   */
  async processMatchingCycle(
    pickupPointName = 'PDEU Main Gate',
    leaseKey = LEASE_KEY_PDEU,
  ): Promise<MatchingCycleSummary | null> {
    const startedAt = new Date();

    // 1. Resolve pickup point
    const pickupPoint = await this.prisma.pickupPoint.findFirst({
      where: { name: pickupPointName, isActive: true },
    });

    if (!pickupPoint) {
      this.logger.warn(`Pickup point [${pickupPointName}] not found or inactive`);
      return null;
    }

    // 2. Claim distributed zone lease in Redis
    const leaseToken = await this.acquireLease(leaseKey, LEASE_TTL_MS);
    if (!leaseToken) {
      this.logger.debug(
        `Matching lease [${leaseKey}] currently held by another worker; skipping cycle`,
      );
      return null;
    }

    const formedGroupIds: string[] = [];
    const batchId = randomUUID();
    let totalEligibleCount = 0;

    try {
      // 2b. Register active batch in PostgreSQL establishing a durable database-level fencing epoch
      await this.registerActiveBatch(
        pickupPoint.id,
        batchId,
        leaseToken,
        LEASE_TTL_MS,
      );

      // 3. Extract eligible candidate pool (ordered FIFO by created_at ASC)
      const eligiblePool = await this.queryEligibleBookings(pickupPoint.id);
      totalEligibleCount = eligiblePool.length;

      if (eligiblePool.length < 2) {
        this.logger.debug(
          `Insufficient eligible bookings at [${pickupPointName}] (${eligiblePool.length} found); skipping matching`,
        );
        return {
          batchId,
          pickupPointId: pickupPoint.id,
          totalEligibleBookings: totalEligibleCount,
          groupsFormedCount: 0,
          formedGroupIds: [],
          startedAt,
          completedAt: new Date(),
        };
      }

      // Track bookings matched or discarded in this cycle
      const claimedBookingIds = new Set<string>();

      // Extract coordinates for pickup origin P0
      const [pickupCoord] = await this.prisma.$queryRaw<
        Array<{ lng: number; lat: number }>
      >`
        SELECT ST_X(center_point) as lng, ST_Y(center_point) as lat
        FROM pickup_points
        WHERE id = ${pickupPoint.id}::uuid
      `;

      const p0 = {
        latitude: pickupCoord.lat,
        longitude: pickupCoord.lng,
      };

      // 4. Iteratively form groups until pool is exhausted or no more combinations match
      for (let i = 0; i < eligiblePool.length; i++) {
        const seed = eligiblePool[i];
        if (claimedBookingIds.has(seed.id)) {
          continue;
        }

        // Remaining candidates that can accompany seed
        const companionPool = await this.queryKnnCompanions(
          seed,
          pickupPoint.id,
          claimedBookingIds,
        );

        if (companionPool.length === 0) {
          continue;
        }

        // Generate bounded candidate groups containing seed
        const candidateGroups = this.generateCandidateGroups(
          seed,
          companionPool,
        );

        if (candidateGroups.length === 0) {
          continue;
        }

        const feasibleResults: FeasiblePermutationResult[] = [];

        // Evaluate candidate groups against OSRM matrices
        for (const candidateGroup of candidateGroups) {
          // Prepare coordinate array: P0 first, then candidate destinations
          const coords = [
            p0,
            ...candidateGroup.map((m) => m.destination),
          ];

          let matrix;
          try {
            matrix = await this.routingService.getTravelTimeMatrix(coords);
          } catch (err: any) {
            this.logger.warn(
              `OSRM matrix query failed during matching: ${err?.message}`,
            );
            // Defer matching cycle safely; do not persist with fallback
            throw new ServiceUnavailableException('ROUTING_UNAVAILABLE');
          }

          // Strict Routing Safety: never evaluate matching using approximate fallback
          if (matrix.isFallback || matrix.source !== 'OSRM') {
            this.logger.warn(
              'OSRM matrix returned geodesic fallback; aborting matching batch to protect 25% detour constraint',
            );
            throw new ServiceUnavailableException('ROUTING_UNAVAILABLE');
          }

          const solveResult = this.permutationSolver.solve(
            candidateGroup,
            matrix,
          );

          if (solveResult) {
            feasibleResults.push(solveResult);
          }
        }

        if (feasibleResults.length === 0) {
          // No feasible group could be formed for this seed (detours all > 25% or pref mismatch)
          continue;
        }

        // 5. Hierarchical ranking to select winning candidate group
        feasibleResults.sort((a, b) =>
          this.permutationSolver.compareCandidates(a, b),
        );

        let winningResult: FeasiblePermutationResult | null = null;
        let finalRoute: RouteResult | null = null;
        let allocatedFares: Array<{ id: string; allocatedFarePaise: number }> | null =
          null;

        for (const candidate of feasibleResults) {
          // 6. Request final OSRM Route geometry & distance for this candidate sequence
          const orderedCoords = [
            p0,
            ...candidate.orderedEvaluations.map((ev) => {
              const member = candidate.members.find(
                (m) => m.bookingId === ev.bookingId,
              )!;
              return member.destination;
            }),
          ];

          let route: RouteResult;
          try {
            route =
              await this.routingService.getMultiStopRoute(orderedCoords);
          } catch (err: any) {
            this.logger.warn(
              `OSRM final route query failed for candidate group: ${err?.message}`,
            );
            throw new ServiceUnavailableException('ROUTING_UNAVAILABLE');
          }

          if (route.isFallback || route.source !== 'OSRM') {
            this.logger.warn(
              'OSRM final route returned fallback geometry; deferring persistence',
            );
            throw new ServiceUnavailableException('ROUTING_UNAVAILABLE');
          }

          // 7. Calculate proportional fare allocations and verify fare ceiling
          const fareAllocationMembers: FareAllocationMember[] =
            candidate.members.map((m) => ({
              id: m.bookingId,
              soloFarePaise: m.agreedFareCeilingPaise,
              ceilingPaise: m.agreedFareCeilingPaise,
            }));

          let fares;
          try {
            fares = this.faresService.allocateSharedFares(
              fareAllocationMembers,
              route.distanceMeters,
            );
          } catch (err: any) {
            this.logger.warn(
              `Fare allocation failed for candidate group: ${err?.message}`,
            );
            continue;
          }

          // Verify ceiling constraint: allocatedFare <= ceilingPaise
          const ceilingExceeded = fares.some((af) => {
            const member = candidate.members.find(
              (m) => m.bookingId === af.id,
            );
            return member && af.allocatedFarePaise > member.agreedFareCeilingPaise;
          });

          if (ceilingExceeded) {
            this.logger.warn(
              'Allocated shared fare exceeded passenger ceiling; discarding candidate group',
            );
            continue;
          }

          winningResult = candidate;
          finalRoute = route;
          allocatedFares = fares;
          break;
        }

        if (!winningResult || !finalRoute || !allocatedFares) {
          continue;
        }

        // 8. Atomic PostgreSQL Transaction: Persist group, members, stops, and outbox event
        const groupId = await this.persistMatchedGroupTransactionally({
          batchId,
          pickupPointId: pickupPoint.id,
          leaseKey,
          leaseToken,
          winningResult,
          finalRoute,
          allocatedFares,
          totalEligibleCount,
        });

        if (groupId) {
          formedGroupIds.push(groupId);
          // Mark all group members as claimed so they won't be reused in this batch
          for (const m of winningResult.members) {
            claimedBookingIds.add(m.bookingId);
          }
        }
      }

      return {
        batchId,
        pickupPointId: pickupPoint.id,
        totalEligibleBookings: totalEligibleCount,
        groupsFormedCount: formedGroupIds.length,
        formedGroupIds,
        startedAt,
        completedAt: new Date(),
      };
    } catch (err: any) {
      if (err instanceof ServiceUnavailableException) {
        this.logger.warn(
          `Matching batch [${batchId}] safely deferred due to routing unavailability`,
        );
      } else {
        this.logger.error(
          `Matching cycle encountered error: ${err?.message}`,
          err?.stack,
        );
      }
      return {
        batchId,
        pickupPointId: pickupPoint.id,
        totalEligibleBookings: totalEligibleCount,
        groupsFormedCount: formedGroupIds.length,
        formedGroupIds,
        skippedReason: err?.message,
        startedAt,
        completedAt: new Date(),
      };
    } finally {
      // Mark active batch as completed if it wasn't superseded
      try {
        await this.prisma.matchingBatch.updateMany({
          where: { id: batchId, batchStatus: 'ACTIVE' },
          data: { batchStatus: 'COMPLETED', completedAt: new Date() },
        });
      } catch {
        // ignore
      }
      // Always release matching lease via atomic compare-and-delete
      await this.releaseLease(leaseKey, leaseToken);
    }
  }

  /**
   * Queries all eligible bookings for the given pickup hub ordered FIFO (created_at ASC).
   */
  private async queryEligibleBookings(
    pickupPointId: string,
  ): Promise<EligibleBookingRow[]> {
    return this.prisma.$queryRaw<EligibleBookingRow[]>`
      SELECT 
        b.id,
        b.passenger_id,
        b.fare_quote_id,
        b.pickup_point_id,
        b.requested_type,
        b.min_group_preference,
        b.status,
        b.agreed_fare_ceiling_paise,
        b.max_wait_deadline,
        b.created_at,
        ST_X(b.destination_location) as dest_lng,
        ST_Y(b.destination_location) as dest_lat,
        ST_X(b.passenger_pickup_location) as pickup_lng,
        ST_Y(b.passenger_pickup_location) as pickup_lat
      FROM bookings b
      WHERE b.pickup_point_id = ${pickupPointId}::uuid
        AND b.status IN ('REQUESTED', 'MATCHING')
        AND b.requested_type = 'SHARED'
        AND b.max_wait_deadline > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.booking_id = b.id
            AND gm.is_active_member = true
        )
      ORDER BY b.created_at ASC
    `;
  }

  /**
   * Uses PostGIS KNN (<->) to shortlist up to 6 nearest companion destinations to the seed.
   */
  private async queryKnnCompanions(
    seed: EligibleBookingRow,
    pickupPointId: string,
    excludedIds: Set<string>,
  ): Promise<EligibleBookingRow[]> {
    const rawCompanions = await this.prisma.$queryRaw<EligibleBookingRow[]>`
      SELECT 
        b.id,
        b.passenger_id,
        b.fare_quote_id,
        b.pickup_point_id,
        b.requested_type,
        b.min_group_preference,
        b.status,
        b.agreed_fare_ceiling_paise,
        b.max_wait_deadline,
        b.created_at,
        ST_X(b.destination_location) as dest_lng,
        ST_Y(b.destination_location) as dest_lat,
        ST_X(b.passenger_pickup_location) as pickup_lng,
        ST_Y(b.passenger_pickup_location) as pickup_lat
      FROM bookings b
      WHERE b.id != ${seed.id}::uuid
        AND b.pickup_point_id = ${pickupPointId}::uuid
        AND b.status IN ('REQUESTED', 'MATCHING')
        AND b.requested_type = 'SHARED'
        AND b.max_wait_deadline > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.booking_id = b.id
            AND gm.is_active_member = true
        )
      ORDER BY b.destination_location <-> (SELECT destination_location FROM bookings WHERE id = ${seed.id}::uuid)
      LIMIT ${MAX_KNN_COMPANIONS * 2}
    `;

    return rawCompanions
      .filter((c) => !excludedIds.has(c.id))
      .slice(0, MAX_KNN_COMPANIONS);
  }

  /**
   * Generates candidate groups of 2, 3, and 4 containing the seed.
   * Enforces minGroupPreference and caps candidate groups at 50 per seed.
   */
  private generateCandidateGroups(
    seed: EligibleBookingRow,
    companions: EligibleBookingRow[],
  ): CandidateMember[][] {
    const seedMember: CandidateMember = {
      bookingId: seed.id,
      passengerId: seed.passenger_id,
      destination: { latitude: seed.dest_lat, longitude: seed.dest_lng },
      agreedFareCeilingPaise: seed.agreed_fare_ceiling_paise,
      minGroupPreference: seed.min_group_preference,
      createdAt: new Date(seed.created_at),
      maxWaitDeadline: new Date(seed.max_wait_deadline),
    };

    const companionMembers: CandidateMember[] = companions.map((c) => ({
      bookingId: c.id,
      passengerId: c.passenger_id,
      destination: { latitude: c.dest_lat, longitude: c.dest_lng },
      agreedFareCeilingPaise: c.agreed_fare_ceiling_paise,
      minGroupPreference: c.min_group_preference,
      createdAt: new Date(c.created_at),
      maxWaitDeadline: new Date(c.max_wait_deadline),
    }));

    const candidateGroups: CandidateMember[][] = [];

    // Size 4 (seed + 3 companions)
    for (let i = 0; i < companionMembers.length; i++) {
      for (let j = i + 1; j < companionMembers.length; j++) {
        for (let k = j + 1; k < companionMembers.length; k++) {
          if (candidateGroups.length >= MAX_CANDIDATE_GROUPS_PER_SEED) break;
          const group = [
            seedMember,
            companionMembers[i],
            companionMembers[j],
            companionMembers[k],
          ];
          if (this.isGroupPreferenceSatisfied(group)) {
            candidateGroups.push(group);
          }
        }
      }
    }

    // Size 3 (seed + 2 companions)
    for (let i = 0; i < companionMembers.length; i++) {
      for (let j = i + 1; j < companionMembers.length; j++) {
        if (candidateGroups.length >= MAX_CANDIDATE_GROUPS_PER_SEED) break;
        const group = [seedMember, companionMembers[i], companionMembers[j]];
        if (this.isGroupPreferenceSatisfied(group)) {
          candidateGroups.push(group);
        }
      }
    }

    // Size 2 (seed + 1 companion)
    for (let i = 0; i < companionMembers.length; i++) {
      if (candidateGroups.length >= MAX_CANDIDATE_GROUPS_PER_SEED) break;
      const group = [seedMember, companionMembers[i]];
      if (this.isGroupPreferenceSatisfied(group)) {
        candidateGroups.push(group);
      }
    }

    return candidateGroups;
  }

  private isGroupPreferenceSatisfied(group: CandidateMember[]): boolean {
    const size = group.length;
    for (const m of group) {
      if (m.minGroupPreference > size) {
        return false;
      }
    }
    return true;
  }

  /**
   * Phase 4: Atomic PostgreSQL Persistence inside a single transaction.
   * Guarantees:
   * - Validates matching lease ownership/fencing before committing.
   * - Pessimistic row locking (SELECT ... FOR UPDATE) on bookings.
   * - Validates eligibility and deadlines.
   * - Prevents duplicate group membership.
   * - Inserts MatchingBatch, MatchingBatchBooking, RideGroup, GroupMember,
   *   GroupRouteVersion, GroupRouteStop, and GROUP_FORMED OutboxEvent atomically.
   */
  async persistMatchedGroupTransactionally(params: {
    batchId: string;
    pickupPointId: string;
    leaseKey: string;
    leaseToken: string;
    winningResult: FeasiblePermutationResult;
    finalRoute: RouteResult;
    allocatedFares: Array<{ id: string; allocatedFarePaise: number }>;
    totalEligibleCount: number;
  }): Promise<string | null> {
    const {
      batchId,
      pickupPointId,
      leaseKey,
      leaseToken,
      winningResult,
      finalRoute,
      allocatedFares,
      totalEligibleCount,
    } = params;

    // Verify lease ownership right before database transaction
    const stillOwner = await this.isLeaseOwner(leaseKey, leaseToken);
    if (!stillOwner) {
      this.logger.warn(
        `Matching lease [${leaseKey}] expired or lost before persistence; aborting`,
      );
      throw new ConflictException('MATCHING_LEASE_EXPIRED_OR_LOST');
    }

    const memberBookingIds = winningResult.members.map((m) => m.bookingId);
    const totalSharedFarePaise = allocatedFares.reduce(
      (sum, f) => sum + f.allocatedFarePaise,
      0,
    );

    const groupId = await this.prisma.$transaction(async (tx) => {
      // 0a. Hub-Level Serialization: Lock pickup point to serialize persistence and registrations
      await tx.$executeRaw`
        SELECT id FROM pickup_points
        WHERE id = ${pickupPointId}::uuid
        FOR UPDATE
      `;

      // 0b. Durable PostgreSQL-level Fencing Invariant:
      // Lock and verify that this batch is registered in PostgreSQL, has not been superseded
      // by a newer worker, and has not expired according to PostgreSQL's engine clock.
      const [batchRecord] = await tx.$queryRaw<
        Array<{
          id: string;
          batch_status: string;
          lease_token: string;
          is_expired: boolean;
        }>
      >`
        SELECT 
          id, 
          batch_status, 
          lease_token,
          (lease_expires_at <= clock_timestamp()) AS is_expired
        FROM matching_batches
        WHERE id = ${batchId}::uuid
          AND pickup_point_id = ${pickupPointId}::uuid
        FOR UPDATE
      `;

      if (!batchRecord) {
        this.logger.warn(
          `Matching batch [${batchId}] does not exist in database; aborting persistence`,
        );
        throw new ConflictException('MATCHING_LEASE_EXPIRED_OR_LOST');
      }

      if (
        batchRecord.batch_status === 'SUPERSEDED' ||
        (batchRecord.batch_status !== 'ACTIVE' &&
          batchRecord.batch_status !== 'COMPLETED')
      ) {
        this.logger.warn(
          `Matching batch [${batchId}] is no longer active (status=${batchRecord.batch_status}); aborting stale persistence`,
        );
        throw new ConflictException('MATCHING_LEASE_EXPIRED_OR_LOST');
      }

      if (batchRecord.is_expired) {
        this.logger.warn(
          `Matching batch [${batchId}] lease expired according to PostgreSQL clock; aborting stale persistence`,
        );
        throw new ConflictException('MATCHING_LEASE_EXPIRED_OR_LOST');
      }

      if (batchRecord.lease_token !== leaseToken) {
        this.logger.warn(
          `Matching batch [${batchId}] lease token mismatch; aborting stale persistence`,
        );
        throw new ConflictException('MATCHING_LEASE_EXPIRED_OR_LOST');
      }

      // 1. Lock and verify selected bookings
      const lockedBookings = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          max_wait_deadline: Date;
        }>
      >`
        SELECT id, status, max_wait_deadline
        FROM bookings
        WHERE id IN (${Prisma.join(memberBookingIds.map((id) => Prisma.sql`${id}::uuid`))})
        FOR UPDATE
      `;

      if (lockedBookings.length !== memberBookingIds.length) {
        this.logger.warn(
          'One or more bookings in winning candidate group no longer exist; rolling back',
        );
        throw new ConflictException('BOOKINGS_NOT_AVAILABLE');
      }

      const now = new Date();
      for (const b of lockedBookings) {
        if (!['REQUESTED', 'MATCHING'].includes(b.status)) {
          this.logger.warn(
            `Booking ${b.id} status changed to ${b.status}; rolling back matching`,
          );
          throw new ConflictException('BOOKING_STATUS_NOT_ELIGIBLE');
        }
        if (new Date(b.max_wait_deadline) <= now) {
          this.logger.warn(
            `Booking ${b.id} max wait deadline expired; rolling back matching`,
          );
          throw new ConflictException('BOOKING_DEADLINE_EXPIRED');
        }
      }

      // 2. Invariant: Check that none of the bookings have an active group membership
      const existingMembers = await tx.$queryRaw<Array<{ booking_id: string }>>`
        SELECT booking_id
        FROM group_members
        WHERE booking_id IN (${Prisma.join(memberBookingIds.map((id) => Prisma.sql`${id}::uuid`))})
          AND is_active_member = true
        FOR UPDATE
      `;

      if (existingMembers.length > 0) {
        this.logger.warn(
          'One or more bookings are already active in another group; rolling back',
        );
        throw new ConflictException('BOOKING_ALREADY_IN_ACTIVE_GROUP');
      }

      // 3. Update MatchingBatch record
      await tx.matchingBatch.update({
        where: { id: batchId },
        data: {
          batchStatus: 'COMPLETED',
          groupsFormedCount: { increment: 1 },
          totalEligibleBookings: totalEligibleCount,
          completedAt: new Date(),
        },
      });

      // Record matching batch bookings
      for (const bookingId of memberBookingIds) {
        await tx.matchingBatchBooking.create({
          data: {
            batchId,
            bookingId,
          },
        });
      }

      // 4. Create RideGroup (READY_FOR_DISPATCH)
      const rideGroup = await tx.rideGroup.create({
        data: {
          pickupPointId,
          rideType: 'SHARED',
          groupVersion: 1,
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise,
          totalRouteDistanceMeters: finalRoute.distanceMeters,
          totalRouteDurationSec: finalRoute.durationSec,
        },
      });

      // 5. Create GroupMember records
      const groupMemberMap = new Map<string, string>(); // bookingId -> groupMember.id
      for (const ev of winningResult.orderedEvaluations) {
        const fare = allocatedFares.find((f) => f.id === ev.bookingId);
        const allocatedFarePaise = fare ? fare.allocatedFarePaise : 0;

        const groupMember = await tx.groupMember.create({
          data: {
            rideGroupId: rideGroup.id,
            bookingId: ev.bookingId,
            dropoffSequenceOrder: ev.dropoffSequenceOrder,
            directDistanceMeters: ev.directDistanceMeters,
            directDurationSec: ev.directDurationSec,
            sharedDurationSec: ev.sharedDurationSec,
            calculatedDetourPercent: ev.calculatedDetourPercent,
            allocatedFarePaise,
            isActiveMember: true,
          },
        });
        groupMemberMap.set(ev.bookingId, groupMember.id);
      }

      // 6. Create GroupRouteVersion record
      const routeGeometry = finalRoute.geometry ?? {};
      const routeVersion = await tx.groupRouteVersion.create({
        data: {
          rideGroupId: rideGroup.id,
          versionNumber: 1,
          routeGeometry: routeGeometry as any,
          totalDistanceMeters: finalRoute.distanceMeters,
          totalDurationSec: finalRoute.durationSec,
        },
      });

      // 7. Create GroupRouteStop records (using raw SQL for Point geometry)
      for (const ev of winningResult.orderedEvaluations) {
        const groupMemberId = groupMemberMap.get(ev.bookingId)!;
        await tx.$executeRaw`
          INSERT INTO group_route_stops (
            id,
            group_route_version_id,
            group_member_id,
            stop_order,
            stop_location,
            stop_type
          ) VALUES (
            gen_random_uuid(),
            ${routeVersion.id}::uuid,
            ${groupMemberId}::uuid,
            ${ev.dropoffSequenceOrder},
            (SELECT destination_location FROM bookings WHERE id = ${ev.bookingId}::uuid),
            'DROPOFF'
          )
        `;
      }

      // 8. Transition selected bookings from REQUESTED/MATCHING -> MATCHED
      for (const ev of winningResult.orderedEvaluations) {
        const fare = allocatedFares.find((f) => f.id === ev.bookingId)!;
        const lockedBooking = lockedBookings.find((b) => b.id === ev.bookingId);
        const previousStatus = lockedBooking?.status ?? 'REQUESTED';

        await tx.booking.update({
          where: { id: ev.bookingId },
          data: {
            status: 'MATCHED',
            finalAllocatedFarePaise: fare.allocatedFarePaise,
          },
        });

        await tx.bookingStatusHistory.create({
          data: {
            bookingId: ev.bookingId,
            previousStatus,
            newStatus: 'MATCHED',
            reason: `Matched into ride group ${rideGroup.id} at sequence position ${ev.dropoffSequenceOrder}`,
          },
        });
      }

      // 9. Insert GROUP_FORMED transactional outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'GROUP_FORMED',
          aggregateType: 'RIDE_GROUP',
          aggregateId: rideGroup.id,
          payload: {
            rideGroupId: rideGroup.id,
            pickupPointId,
            groupVersion: 1,
            status: 'READY_FOR_DISPATCH',
            memberBookingIds,
            totalSharedFarePaise,
            totalRouteDistanceMeters: finalRoute.distanceMeters,
            totalRouteDurationSec: finalRoute.durationSec,
          },
        },
      });

      // 10. Final Fencing Check: verify lease ownership before finalizing commit
      const stillOwnerInside = await this.isLeaseOwner(leaseKey, leaseToken);
      if (!stillOwnerInside) {
        this.logger.warn(
          `Matching lease [${leaseKey}] lost during persistence transaction; rolling back`,
        );
        throw new ConflictException('MATCHING_LEASE_EXPIRED_OR_LOST');
      }

      this.logger.log(
        `Successfully formed RideGroup [${rideGroup.id}] with ${winningResult.groupSize} passengers. Duration: ${finalRoute.durationSec}s, Fare: ₹${(totalSharedFarePaise / 100).toFixed(2)}`,
      );

      return rideGroup.id;
    });

    // Trigger immediate outbox processing post-commit for Stage 6 handoff
    if (this.outboxService) {
      this.outboxService.triggerImmediateProcessing().catch((err) => {
        this.logger.warn(
          `Failed to trigger immediate outbox processing after forming group ${groupId}: ${err?.message}`,
        );
      });
    }

    return groupId;
  }
}
