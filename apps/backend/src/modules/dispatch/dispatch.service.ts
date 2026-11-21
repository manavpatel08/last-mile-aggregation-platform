import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { DriversService } from '../drivers/drivers.service.js';
import { RoutingService } from '../routing/routing.service.js';
import { OutboxService } from '../../infrastructure/outbox/outbox.service.js';
import { QUEUES } from '../../common/constants/index.js';
import { deriveBoardingOtp, hashBoardingOtp } from '../../common/utils/otp.util.js';
import { fenceAndCompleteIdempotentTransaction } from '../../common/interceptors/idempotency.interceptor.js';
import type { IdempotencyClaimContext } from '../../common/interceptors/idempotency.interceptor.js';
import {
  CandidateDriver,
  DispatchResult,
  DispatchTimeoutJobPayload,
  PendingOfferSummary,
  AcceptOfferResponseData,
  DRIVER_OFFER_TIMEOUT_MS,
  DISPATCH_TIMEOUT_JOB_NAME,
} from './dispatch.interfaces.js';
import { RejectOfferDto } from './dto/reject-offer.dto.js';

/**
 * ============================================================================
 * DispatchService: Stage 6 Sequential 1-to-1 Driver Dispatch Engine
 * ============================================================================
 *
 * Architecture Invariants Enforced:
 * 1. Strict 1-to-1 Dispatch: Exactly one driver receives a pending offer per group at a time.
 *    Enforced at DB level by partial unique index:
 *    `idx_unique_single_pending_offer_per_group ON driver_dispatch_offers (ride_group_id) WHERE status = 'PENDING'`
 *
 * 2. Multi-Offer Capability (ADR-018): An available driver MAY receive multiple pending offers for different groups.
 *    Acceptance of one group atomically withdraws all other pending offers for that driver.
 *
 * 3. Scoped Driver Exclusion: A driver who times out or rejects an offer is excluded strictly for
 *    the current group version and dispatch attempt.
 *    Enforced at DB level by partial unique index:
 *    `idx_unique_driver_offer_per_group_version ON driver_dispatch_offers (ride_group_id, group_version, dispatch_attempt_id, driver_id)`
 *
 * 4. Road Network ETA Ranking: Candidate drivers are ranked strictly by OSRM driving duration
 *    from their latest Redis GPS fix to the PDEU pickup hub. Geodesic / straight-line fallbacks
 *    are strictly rejected for dispatch ranking.
 *
 * 5. Non-Blocking Database Transactions:
 *    - Driver eligibility queries and Redis GPS fetches happen outside DB transactions.
 *    - OSRM matrix calculations happen outside DB transactions.
 *    - DB transaction is kept minimal: locks the ride group row with `SELECT ... FOR UPDATE`,
 *      inserts the attempt + offer, and updates group status to DISPATCHING.
 *
 * 6. Row-Lock Order & Driver Reservation (Phase 4):
 *    When a driver accepts an offer:
 *    a. Lock ride group row: `SELECT id, status, group_version FROM ride_groups WHERE id = :id FOR UPDATE`
 *    b. Lock driver profile and Atomic CAS on driver operational status:
 *       `UPDATE driver_profiles SET operational_status = 'RESERVED' WHERE id = :driverId AND operational_status = 'AVAILABLE' AND is_online = true`
 *       If 0 rows affected -> throw ConflictException('OFFER_ALREADY_TAKEN').
 *    c. Lock driver dispatch offer: `SELECT id, status, expires_at FROM driver_dispatch_offers WHERE id = :id FOR UPDATE`
 *    d. Transition offer to ACCEPTED, create driver_assignments record (RESERVED).
 *    e. Materialize Trip (CREATED) and trip_passengers (WAITING) with 4-digit hashed OTPs.
 *    f. Transition ride_groups and bookings to DRIVER_ASSIGNED.
 *    g. Withdraw conflicting offers atomically:
 *       - Pending offers for other groups to this driver -> WITHDRAWN
 *       - Pending offers for this group to other drivers -> WITHDRAWN
 * ============================================================================
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly driversService: DriversService,
    private readonly routingService: RoutingService,
    @Optional()
    @InjectQueue(QUEUES.DISPATCH)
    private readonly dispatchQueue?: Queue<DispatchTimeoutJobPayload>,
    @Optional()
    @Inject(forwardRef(() => OutboxService))
    private readonly outboxService?: OutboxService,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  /**
   * Finds and ranks eligible candidate drivers for a ride group.
   *
   * Eligibility Criteria:
   * 1. verificationStatus = 'APPROVED'
   * 2. isOnline = true
   * 3. operationalStatus = 'AVAILABLE'
   * 4. Has active vehicle with passengerCapacity >= groupSize
   * 5. No active assignment (status NOT IN ('RESERVED', 'ACTIVE'))
   * 6. Not excluded for this group version / dispatch attempt
   * 7. Valid, fresh GPS fix present in Redis cache (not expired / malformed)
   *
   * Ranking Metric:
   * - OSRM road driving duration (ETA in seconds) to the pickup point ascending.
   * - Deterministic tie-breaking by driverId ascending when ETAs are identical.
   * - If OSRM fails or returns fallback, ranking aborts and returns an empty list.
   */
  async findEligibleCandidateDrivers(
    rideGroupId: string,
    pickupPointId: string,
    groupSize: number = 2,
    attemptId?: string,
  ): Promise<CandidateDriver[]> {
    const minCapacity = Math.max(1, groupSize);

    // 1. Resolve group version for scoped exclusions
    let groupVersion = 1;
    try {
      const group = await this.prisma.rideGroup.findUnique({
        where: { id: rideGroupId },
        select: { groupVersion: true },
      });
      if (group) {
        groupVersion = group.groupVersion;
      }
    } catch {
      // Default to version 1 if group lookup fails
    }

    // 2. Query eligible drivers in PostgreSQL
    const dispatchOffersFilter = attemptId
      ? {
          none: {
            OR: [
              { rideGroupId, groupVersion },
              { dispatchAttemptId: attemptId },
            ],
          },
        }
      : {
          none: {
            rideGroupId,
            groupVersion,
          },
        };

    const eligibleDrivers = await this.prisma.driverProfile.findMany({
      where: {
        verificationStatus: 'APPROVED',
        isOnline: true,
        operationalStatus: 'AVAILABLE',
        vehicles: {
          some: {
            isActive: true,
            passengerCapacity: { gte: minCapacity },
          },
        },
        assignments: {
          none: {
            status: { in: ['RESERVED', 'ACTIVE'] },
          },
        },
        dispatchOffers: dispatchOffersFilter,
      },
      include: {
        vehicles: {
          where: { isActive: true },
          select: { passengerCapacity: true },
        },
      },
    });

    if (eligibleDrivers.length === 0) {
      this.logger.debug(
        `No eligible available drivers found in PostgreSQL for group ${rideGroupId} (capacity >= ${minCapacity})`,
      );
      return [];
    }

    // 3. Inspect Redis for fresh, valid GPS fixes
    const candidatesWithGps: Array<{
      driver: (typeof eligibleDrivers)[0];
      vehicleCapacity: number;
      latitude: number;
      longitude: number;
    }> = [];

    for (const driver of eligibleDrivers) {
      const gpsFix = await this.driversService.getDriverGpsFix(driver.id);
      if (!gpsFix) {
        this.logger.debug(
          `Driver ${driver.id} skipped: missing or expired GPS fix in Redis`,
        );
        continue;
      }

      if (
        typeof gpsFix.latitude !== 'number' ||
        typeof gpsFix.longitude !== 'number' ||
        Number.isNaN(gpsFix.latitude) ||
        Number.isNaN(gpsFix.longitude) ||
        gpsFix.latitude < -90 ||
        gpsFix.latitude > 90 ||
        gpsFix.longitude < -180 ||
        gpsFix.longitude > 180
      ) {
        this.logger.warn(
          `Driver ${driver.id} skipped: invalid coordinates in GPS fix (${gpsFix.latitude}, ${gpsFix.longitude})`,
        );
        continue;
      }

      const maxCapacity = Math.max(
        ...driver.vehicles.map((v) => v.passengerCapacity),
        0,
      );

      candidatesWithGps.push({
        driver,
        vehicleCapacity: maxCapacity,
        latitude: gpsFix.latitude,
        longitude: gpsFix.longitude,
      });
    }

    if (candidatesWithGps.length === 0) {
      this.logger.debug(
        `No candidate drivers with valid GPS fixes found for group ${rideGroupId}`,
      );
      return [];
    }

    // 4. Retrieve pickup point coordinates from PostgreSQL
    let pickupCoord: { latitude: number; longitude: number };
    try {
      const pickupPoints = await this.prisma.$queryRaw<
        Array<{ id: string; latitude: number; longitude: number }>
      >`
        SELECT id, ST_Y(center_point::geometry) as latitude, ST_X(center_point::geometry) as longitude
        FROM pickup_points
        WHERE id = ${pickupPointId}::uuid
      `;

      if (!pickupPoints || pickupPoints.length === 0) {
        this.logger.error(`Pickup point ${pickupPointId} not found`);
        return [];
      }

      pickupCoord = {
        latitude: Number(pickupPoints[0].latitude),
        longitude: Number(pickupPoints[0].longitude),
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to retrieve pickup point ${pickupPointId}: ${error?.message}`,
      );
      return [];
    }

    // 5. Call OSRM table matrix API for driving ETAs
    const matrixCoordinates = [
      ...candidatesWithGps.map((c) => ({
        latitude: c.latitude,
        longitude: c.longitude,
      })),
      pickupCoord,
    ];

    let matrixResult;
    try {
      matrixResult =
        await this.routingService.getTravelTimeMatrix(matrixCoordinates);
    } catch (error: any) {
      this.logger.error(
        `OSRM travel time matrix call failed: ${error?.message}`,
      );
      throw new ServiceUnavailableException({
        errorCode: 'ROUTING_UNAVAILABLE',
        message: `OSRM travel time matrix call failed: ${error?.message}`,
      });
    }

    // Strictly enforce road network routing: reject fallback or non-OSRM source
    if (
      !matrixResult ||
      matrixResult.isFallback ||
      matrixResult.source !== 'OSRM'
    ) {
      this.logger.warn(
        `OSRM matrix returned fallback/non-OSRM (source=${matrixResult?.source}, isFallback=${matrixResult?.isFallback}); aborting driver ranking for dispatch`,
      );
      throw new ServiceUnavailableException({
        errorCode: 'ROUTING_UNAVAILABLE',
        message: `OSRM matrix returned degraded or fallback response (source=${matrixResult?.source})`,
      });
    }

    const pickupIndex = candidatesWithGps.length;
    const rankedCandidates: CandidateDriver[] = [];

    for (let i = 0; i < candidatesWithGps.length; i++) {
      const c = candidatesWithGps[i];
      const etaSec = matrixResult.durations?.[i]?.[pickupIndex];

      if (
        typeof etaSec !== 'number' ||
        !Number.isFinite(etaSec) ||
        etaSec < 0
      ) {
        this.logger.warn(
          `Driver ${c.driver.id} omitted: invalid ETA (${etaSec}) from OSRM matrix`,
        );
        continue;
      }

      const distanceMeters = matrixResult.distances?.[i]?.[pickupIndex];

      rankedCandidates.push({
        driverId: c.driver.id,
        userId: c.driver.userId,
        licenseNumber: c.driver.licenseNumber,
        operationalStatus: c.driver.operationalStatus,
        vehicleCapacity: c.vehicleCapacity,
        latitude: c.latitude,
        longitude: c.longitude,
        etaSec,
        distanceMeters:
          typeof distanceMeters === 'number' && Number.isFinite(distanceMeters)
            ? distanceMeters
            : undefined,
      });
    }

    if (rankedCandidates.length === 0 && candidatesWithGps.length > 0) {
      this.logger.warn(
        `OSRM matrix returned invalid durations for all ${candidatesWithGps.length} candidate drivers`,
      );
      throw new ServiceUnavailableException({
        errorCode: 'ROUTING_UNAVAILABLE',
        message:
          'OSRM travel time matrix contained invalid durations for candidate drivers',
      });
    }

    // 6. Deterministic tie-breaking: ETA ascending, driverId ascending
    rankedCandidates.sort((a, b) => {
      if (a.etaSec !== b.etaSec) {
        return a.etaSec - b.etaSec;
      }
      return a.driverId.localeCompare(b.driverId);
    });

    return rankedCandidates;
  }

  /**
   * Durably schedules a BullMQ timeout job for a driver dispatch offer.
   * Invoked reliably by the outbox consumer for DISPATCH_OFFER_CREATED events.
   *
   * Invariants:
   * 1. Reads offer from PostgreSQL by offerId.
   * 2. If offer is no longer PENDING (e.g. ACCEPTED, REJECTED, EXPIRED, WITHDRAWN),
   *    skips queueing and returns false (no timeout needed).
   * 3. If PENDING, derives remaining delay from persisted expiresAt.
   * 4. Enqueues with deterministic jobId `dispatch-timeout-${offerId}` to prevent duplicate active jobs.
   * 5. If queue is down or queue.add throws, propagates the error so the outbox event remains retryable.
   */
  async scheduleOfferTimeout(offerId: string): Promise<{
    scheduled: boolean;
    jobId?: string;
    remainingMs?: number;
    reason?: string;
  }> {
    const offer = await this.prisma.driverDispatchOffer.findUnique({
      where: { id: offerId },
    });

    if (!offer) {
      throw new NotFoundException({
        errorCode: 'OFFER_NOT_FOUND',
        message: `Driver dispatch offer ${offerId} not found`,
      });
    }

    if (offer.status !== 'PENDING') {
      this.logger.debug(
        `Offer ${offerId} status is '${offer.status}', skipping timeout job scheduling`,
      );
      return {
        scheduled: false,
        reason: `OFFER_STATUS_${offer.status}`,
      };
    }

    if (!this.dispatchQueue) {
      this.logger.warn(
        `Dispatch queue not configured; cannot schedule timeout for pending offer ${offerId}`,
      );
      throw new ServiceUnavailableException({
        errorCode: 'QUEUE_NOT_AVAILABLE',
        message: `Dispatch queue not configured; cannot schedule timeout for pending offer ${offerId}`,
      });
    }

    const now = Date.now();
    const remainingMs = Math.max(0, offer.expiresAt.getTime() - now);

    const job = await this.dispatchQueue.add(
      DISPATCH_TIMEOUT_JOB_NAME,
      {
        offerId: offer.id,
        rideGroupId: offer.rideGroupId,
        driverId: offer.driverId,
        groupVersion: offer.groupVersion,
        dispatchAttemptId: offer.dispatchAttemptId,
      },
      {
        delay: remainingMs,
        jobId: `dispatch-timeout-${offer.id}`,
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );

    this.logger.log(
      `Scheduled durable timeout job ${job.id} for offer ${offer.id} with delay ${remainingMs}ms`,
    );

    return {
      scheduled: true,
      jobId: job.id,
      remainingMs,
    };
  }

  /**
   * Schedules a delayed timeout BullMQ job for an offer.
   * Delegates to durable scheduleOfferTimeout() implementation.
   */
  async scheduleOfferTimeoutJob(
    payload: DispatchTimeoutJobPayload,
  ): Promise<void> {
    await this.scheduleOfferTimeout(payload.offerId);
  }

  /**
   * Initiates sequential 1-to-1 dispatch for a ride group.
   *
   * Flow:
   * 1. Validates ride group status ('READY_FOR_DISPATCH' or 'DISPATCHING').
   * 2. Checks for existing active pending offer (short-circuit idempotency).
   * 3. Finds and ranks eligible candidate drivers via OSRM outside the DB transaction.
   * 4. If no candidates: marks active attempt EXHAUSTED (fleet exhaustion).
   * 5. Atomically reserves the offer in a short PostgreSQL transaction:
   *    - Acquires row lock on ride group (`FOR UPDATE`).
   *    - Verifies group status under lock.
   *    - Re-verifies absence of pending offers.
   *    - Creates or retrieves active DispatchAttempt.
   *    - Inserts DriverDispatchOffer with 20-second timeout.
   *    - Inserts DISPATCH_OFFER_CREATED outbox event atomically.
   *    - Updates RideGroup status to 'DISPATCHING'.
   * 6. Schedules delayed 20-second BullMQ timeout job after commit.
   * 7. Passenger bookings remain in 'MATCHED' status throughout dispatch.
   */
  async initiateDispatchForGroup(rideGroupId: string): Promise<DispatchResult> {
    // 1. Fetch ride group details
    const rideGroup = await this.prisma.rideGroup.findUnique({
      where: { id: rideGroupId },
      include: {
        members: { where: { isActiveMember: true } },
      },
    });

    if (!rideGroup) {
      throw new NotFoundException({
        errorCode: 'RIDE_GROUP_NOT_FOUND',
        message: `Ride group ${rideGroupId} not found`,
      });
    }

    // 2. Fast-path check: if driver already assigned to this group, return success
    const existingAssignment = await this.prisma.driverAssignment.findFirst({
      where: {
        rideGroupId,
        status: { in: ['RESERVED', 'ACTIVE', 'COMPLETED'] },
      },
    });

    if (existingAssignment) {
      this.logger.log(
        `Ride group ${rideGroupId} already has assigned driver (assignment ${existingAssignment.id})`,
      );
      return {
        success: true,
        attemptId: existingAssignment.dispatchAttemptId,
        driverId: existingAssignment.driverId,
        isExistingAssignment: true,
        isExistingOffer: true,
        message: 'Driver already assigned to group',
      };
    }

    // 3. Validate group status
    if (
      rideGroup.status !== 'READY_FOR_DISPATCH' &&
      rideGroup.status !== 'DISPATCHING'
    ) {
      this.logger.warn(
        `Ride group ${rideGroupId} is in status '${rideGroup.status}', not eligible for dispatch`,
      );
      return {
        success: false,
        reason: 'INVALID_GROUP_STATUS',
        message: `Ride group status is '${rideGroup.status}', expected 'READY_FOR_DISPATCH' or 'DISPATCHING'`,
      };
    }

    // 4. Fast-path idempotency: return existing pending offer if already active
    const existingOffer = await this.prisma.driverDispatchOffer.findFirst({
      where: {
        rideGroupId,
        status: 'PENDING',
      },
    });

    if (existingOffer) {
      this.logger.log(
        `Ride group ${rideGroupId} already has active pending offer ${existingOffer.id}`,
      );
      return {
        success: true,
        attemptId: existingOffer.dispatchAttemptId,
        offerId: existingOffer.id,
        driverId: existingOffer.driverId,
        expiresAt: existingOffer.expiresAt,
        isExistingOffer: true,
      };
    }

    // 4. Find active attempt (if existing) to filter previous candidate exclusions
    const activeAttempt = await this.prisma.dispatchAttempt.findFirst({
      where: {
        rideGroupId,
        groupVersion: rideGroup.groupVersion,
        status: 'ACTIVE',
      },
    });

    // 5. Query candidate drivers and rank by OSRM ETA (OUTSIDE DB transaction)
    const groupSize = Math.max(1, rideGroup.members.length);
    let rankedCandidates: CandidateDriver[];
    try {
      rankedCandidates = await this.findEligibleCandidateDrivers(
        rideGroupId,
        rideGroup.pickupPointId,
        groupSize,
        activeAttempt?.id,
      );
    } catch (err: any) {
      if (
        err instanceof ServiceUnavailableException ||
        err?.response?.errorCode === 'ROUTING_UNAVAILABLE' ||
        err?.message?.includes('OSRM')
      ) {
        this.logger.warn(
          `Routing unavailable during candidate driver ranking for group ${rideGroupId}: ${err?.message}`,
        );
        return {
          success: false,
          reason: 'ROUTING_UNAVAILABLE',
          retryable: true,
          message:
            err?.message ||
            'OSRM routing engine unavailable for driver candidate ranking',
        };
      }
      throw err;
    }

    if (rankedCandidates.length === 0) {
      this.logger.warn(
        `No eligible ranked candidate drivers found for ride group ${rideGroupId}`,
      );

      let attemptId: string | undefined;

      // Find active attempt or latest existing attempt for this group version
      const latestAttempt =
        activeAttempt ??
        (await this.prisma.dispatchAttempt.findFirst({
          where: {
            rideGroupId,
            groupVersion: rideGroup.groupVersion,
          },
          orderBy: { attemptNumber: 'desc' },
        }));

      if (latestAttempt) {
        attemptId = latestAttempt.id;
        if (latestAttempt.status === 'ACTIVE') {
          // Transition active attempt to EXHAUSTED
          await this.prisma.dispatchAttempt.update({
            where: { id: latestAttempt.id },
            data: { status: 'EXHAUSTED' },
          });

          await this.prisma.outboxEvent.create({
            data: {
              eventType: 'DISPATCH_ATTEMPT_EXHAUSTED',
              aggregateType: 'DISPATCH_ATTEMPT',
              aggregateId: latestAttempt.id,
              payload: {
                dispatchAttemptId: latestAttempt.id,
                rideGroupId,
                groupVersion: rideGroup.groupVersion,
                exhaustedAt: new Date().toISOString(),
              },
            },
          });
        }
        // If latestAttempt.status is already 'EXHAUSTED', do not create duplicate attempts or events
      } else {
        // Initial dispatch with 0 candidates: durably record attempt 1 as EXHAUSTED
        // so it cannot leave an untracked, silently abandoned group
        const attempt = await this.prisma.dispatchAttempt.create({
          data: {
            rideGroupId,
            groupVersion: rideGroup.groupVersion,
            attemptNumber: 1,
            status: 'EXHAUSTED',
          },
        });
        attemptId = attempt.id;

        await this.prisma.outboxEvent.create({
          data: {
            eventType: 'DISPATCH_ATTEMPT_EXHAUSTED',
            aggregateType: 'DISPATCH_ATTEMPT',
            aggregateId: attempt.id,
            payload: {
              dispatchAttemptId: attempt.id,
              rideGroupId,
              groupVersion: rideGroup.groupVersion,
              exhaustedAt: new Date().toISOString(),
            },
          },
        });
      }

      return {
        success: false,
        reason: 'FLEET_EXHAUSTED',
        retryable: true,
        attemptId,
        message: 'All eligible candidate drivers have been exhausted',
      };
    }

    const rank1Driver = rankedCandidates[0];

    // 6. Execute short atomic PostgreSQL persistence transaction
    let dispatchResult: DispatchResult;
    try {
      dispatchResult = await this.prisma.$transaction(async (tx) => {
        // a. Row lock on ride_groups
        const lockedGroups = await tx.$queryRaw<
          Array<{
            id: string;
            status: string;
            group_version: number;
            pickup_point_id: string;
          }>
        >`
          SELECT id, status, group_version, pickup_point_id
          FROM ride_groups
          WHERE id = ${rideGroupId}::uuid
          FOR UPDATE
        `;

        if (!lockedGroups || lockedGroups.length === 0) {
          throw new NotFoundException({
            errorCode: 'RIDE_GROUP_NOT_FOUND',
            message: `Ride group ${rideGroupId} not found during lock`,
          });
        }

        const lockedGroup = lockedGroups[0];

        // b. Re-verify status under lock
        if (
          lockedGroup.status !== 'READY_FOR_DISPATCH' &&
          lockedGroup.status !== 'DISPATCHING'
        ) {
          return {
            success: false,
            reason: 'INVALID_GROUP_STATUS',
            message: `Ride group status changed to '${lockedGroup.status}' during lock`,
          };
        }

        // c. Double-check pending offer under lock to prevent race condition
        const pendingOfferInTx = await tx.driverDispatchOffer.findFirst({
          where: {
            rideGroupId,
            status: 'PENDING',
          },
        });

        if (pendingOfferInTx) {
          return {
            success: true,
            attemptId: pendingOfferInTx.dispatchAttemptId,
            offerId: pendingOfferInTx.id,
            driverId: pendingOfferInTx.driverId,
            expiresAt: pendingOfferInTx.expiresAt,
            isExistingOffer: true,
          };
        }

        // d. Find or create DispatchAttempt
        let attempt = await tx.dispatchAttempt.findFirst({
          where: {
            rideGroupId,
            groupVersion: lockedGroup.group_version,
            status: 'ACTIVE',
          },
        });

        if (!attempt) {
          const prevAttemptCount = await tx.dispatchAttempt.count({
            where: {
              rideGroupId,
              groupVersion: lockedGroup.group_version,
            },
          });

          attempt = await tx.dispatchAttempt.create({
            data: {
              rideGroupId,
              groupVersion: lockedGroup.group_version,
              attemptNumber: prevAttemptCount + 1,
              status: 'ACTIVE',
            },
          });
        }

        // e. Create DriverDispatchOffer (status: PENDING, 20s expiry)
        const now = new Date();
        const expiresAt = new Date(now.getTime() + DRIVER_OFFER_TIMEOUT_MS);

        const offer = await tx.driverDispatchOffer.create({
          data: {
            dispatchAttemptId: attempt.id,
            rideGroupId,
            groupVersion: lockedGroup.group_version,
            driverId: rank1Driver.driverId,
            status: 'PENDING',
            offeredAt: now,
            expiresAt,
          },
        });

        // f. Persist durable outbox event atomically with the offer
        await tx.outboxEvent.create({
          data: {
            eventType: 'DISPATCH_OFFER_CREATED',
            aggregateType: 'DRIVER_DISPATCH_OFFER',
            aggregateId: offer.id,
            payload: {
              offerId: offer.id,
              rideGroupId,
              driverId: rank1Driver.driverId,
              groupVersion: lockedGroup.group_version,
              dispatchAttemptId: attempt.id,
              expiresAt: expiresAt.toISOString(),
            },
          },
        });

        // g. Update ride group status to DISPATCHING
        if (lockedGroup.status !== 'DISPATCHING') {
          await tx.rideGroup.update({
            where: { id: rideGroupId },
            data: { status: 'DISPATCHING' },
          });
        }

        return {
          success: true,
          attemptId: attempt.id,
          offerId: offer.id,
          driverId: rank1Driver.driverId,
          etaSec: rank1Driver.etaSec,
          expiresAt,
          isExistingOffer: false,
        };
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        // Unique constraint violation (e.g. idx_unique_single_pending_offer_per_group)
        this.logger.warn(
          `Unique constraint violation during offer creation for group ${rideGroupId}; recovering existing offer`,
        );
        const existingOffer = await this.prisma.driverDispatchOffer.findFirst({
          where: {
            rideGroupId,
            status: 'PENDING',
          },
        });
        if (existingOffer) {
          return {
            success: true,
            attemptId: existingOffer.dispatchAttemptId,
            offerId: existingOffer.id,
            driverId: existingOffer.driverId,
            expiresAt: existingOffer.expiresAt,
            isExistingOffer: true,
          };
        }
      }
      throw error;
    }

    // 7. Trigger durable timeout scheduling through the transactional outbox
    if (
      dispatchResult.success &&
      !dispatchResult.isExistingOffer &&
      dispatchResult.offerId
    ) {
      if (this.outboxService) {
        this.outboxService
          .triggerImmediateProcessing({
            aggregateId: dispatchResult.offerId,
            eventType: 'DISPATCH_OFFER_CREATED',
          })
          .catch((err) => {
            this.logger.warn(
              `Immediate outbox timeout trigger for offer ${dispatchResult.offerId} deferred to scheduled poll: ${err?.message}`,
            );
          });
      } else {
        // Fallback for isolated unit tests without OutboxService injected
        try {
          await this.scheduleOfferTimeout(dispatchResult.offerId);
        } catch (err: any) {
          this.logger.debug(
            `Direct timeout scheduling skipped in test environment: ${err?.message}`,
          );
        }
      }
    }

    return dispatchResult;
  }

  /**
   * Handles 20-second offer timeout from BullMQ delayed job.
   *
   * Invariants:
   * 1. Acquires row locks: ride_groups -> driver_dispatch_offers.
   * 2. If offer is not PENDING, or group version / attempt changed -> safe no-op.
   * 3. Atomically sets offer status = 'EXPIRED'.
   * 4. Cascades sequentially to next ranked driver without dissolving group.
   */
  async handleOfferTimeout(payload: DispatchTimeoutJobPayload): Promise<{
    expired: boolean;
    cascaded: boolean;
    nextOfferId?: string;
    reason?: string;
  }> {
    const { offerId, rideGroupId, groupVersion, dispatchAttemptId } = payload;

    const expireResult = await this.prisma.$transaction(async (tx) => {
      // 1. Lock ride group row
      const lockedGroups = await tx.$queryRaw<
        Array<{ id: string; status: string; group_version: number }>
      >`
        SELECT id, status, group_version
        FROM ride_groups
        WHERE id = ${rideGroupId}::uuid
        FOR UPDATE
      `;

      if (!lockedGroups || lockedGroups.length === 0) {
        return { shouldCascade: false, reason: 'RIDE_GROUP_NOT_FOUND' };
      }

      const lockedGroup = lockedGroups[0];

      // If group version has incremented, this timeout job is stale
      if (lockedGroup.group_version !== groupVersion) {
        this.logger.debug(
          `Timeout job stale for offer ${offerId}: group version changed (${lockedGroup.group_version} vs ${groupVersion})`,
        );
        return { shouldCascade: false, reason: 'STALE_GROUP_VERSION' };
      }

      // 2. Lock driver dispatch offer row
      const lockedOffers = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          group_version: number;
          dispatch_attempt_id: string;
          expires_at: Date;
          driver_id: string;
        }>
      >`
        SELECT id, status, group_version, dispatch_attempt_id, expires_at, driver_id
        FROM driver_dispatch_offers
        WHERE id = ${offerId}::uuid
        FOR UPDATE
      `;

      if (!lockedOffers || lockedOffers.length === 0) {
        return { shouldCascade: false, reason: 'OFFER_NOT_FOUND' };
      }

      const lockedOffer = lockedOffers[0];

      // Never expire non-PENDING offers (ACCEPTED, REJECTED, WITHDRAWN, EXPIRED)
      if (lockedOffer.status !== 'PENDING') {
        this.logger.debug(
          `Offer ${offerId} status is '${lockedOffer.status}', skipping timeout expiry`,
        );
        return {
          shouldCascade: false,
          reason: `OFFER_STATUS_${lockedOffer.status}`,
        };
      }

      // Check if dispatch attempt is still ACTIVE
      const attempt = await tx.dispatchAttempt.findUnique({
        where: { id: dispatchAttemptId },
      });

      if (!attempt || attempt.status !== 'ACTIVE') {
        this.logger.debug(
          `Dispatch attempt ${dispatchAttemptId} is '${attempt?.status}', skipping cascade`,
        );
        return { shouldCascade: false, reason: 'ATTEMPT_NOT_ACTIVE' };
      }

      // Stale attempt check: Does offer belong to the triggering dispatch attempt?
      if (lockedOffer.dispatch_attempt_id !== dispatchAttemptId) {
        this.logger.debug(
          `Offer ${offerId} attempt mismatch (${lockedOffer.dispatch_attempt_id} vs ${dispatchAttemptId}), skipping timeout expiry`,
        );
        return { shouldCascade: false, reason: 'STALE_DISPATCH_ATTEMPT' };
      }

      // Early timeout safety check: verify persisted expiresAt against current time
      const now = new Date();
      const expiresAt = new Date(lockedOffer.expires_at);

      if (now.getTime() < expiresAt.getTime()) {
        const remainingMs = expiresAt.getTime() - now.getTime();
        this.logger.warn(
          `Offer ${offerId} timeout job triggered prematurely (${remainingMs}ms remaining); rescheduling without expiring`,
        );
        return {
          shouldCascade: false,
          rescheduled: true,
          remainingMs,
          reason: 'OFFER_NOT_YET_EXPIRED',
        };
      }

      // Atomically mark offer EXPIRED
      await tx.driverDispatchOffer.update({
        where: { id: offerId },
        data: {
          status: 'EXPIRED',
          respondedAt: new Date(),
        },
      });

      // Record outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'DISPATCH_OFFER_EXPIRED',
          aggregateType: 'DRIVER_DISPATCH_OFFER',
          aggregateId: offerId,
          payload: {
            offerId,
            rideGroupId,
            driverId: lockedOffer.driver_id,
            groupVersion,
            dispatchAttemptId,
            expiredAt: new Date().toISOString(),
          },
        },
      });

      return { shouldCascade: true, driverId: lockedOffer.driver_id };
    });

    if (expireResult.rescheduled && expireResult.remainingMs && this.dispatchQueue) {
      await this.dispatchQueue.add(
        DISPATCH_TIMEOUT_JOB_NAME,
        payload,
        {
          delay: expireResult.remainingMs,
          jobId: `dispatch-timeout-${payload.offerId}-${Date.now()}`,
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );
      return {
        expired: false,
        cascaded: false,
        reason: 'RESCHEDULED_EARLY_TIMEOUT',
      };
    }

    if (!expireResult.shouldCascade) {
      return { expired: false, cascaded: false, reason: expireResult.reason };
    }

    // 3. Cascade sequentially to next candidate driver (OUTSIDE DB transaction)
    this.logger.log(
      `Offer ${offerId} expired; cascading to next candidate driver for group ${rideGroupId}`,
    );
    let cascadeResult: DispatchResult;
    try {
      cascadeResult = await this.initiateDispatchForGroup(rideGroupId);
    } catch (err: any) {
      this.logger.warn(
        `Direct cascade for group ${rideGroupId} after offer ${offerId} timeout failed (${err?.message}); durable outbox will retry`,
      );
      cascadeResult = {
        success: false,
        reason: 'ROUTING_UNAVAILABLE',
        retryable: true,
      };
    }

    if (this.outboxService) {
      this.outboxService.triggerImmediateProcessing().catch(() => {});
    }

    return {
      expired: true,
      cascaded: cascadeResult.success,
      nextOfferId: cascadeResult.offerId,
      reason: cascadeResult.reason,
    };
  }

  /**
   * Retrieves all currently pending, unexpired offers for the authenticated driver.
   * Multi-offer compliant (ADR-018): returns all valid offers for different groups.
   */
  async getPendingOffersForDriver(
    userId: string,
  ): Promise<PendingOfferSummary[]> {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });

    if (!driver) {
      throw new NotFoundException({
        errorCode: 'DRIVER_NOT_FOUND',
        message: 'Driver profile not found',
      });
    }

    if (driver.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException({
        errorCode: 'DRIVER_NOT_APPROVED',
        message: 'Driver profile is not approved',
      });
    }

    const now = new Date();
    const pendingOffers = await this.prisma.driverDispatchOffer.findMany({
      where: {
        driverId: driver.id,
        status: 'PENDING',
        expiresAt: { gt: now },
      },
      include: {
        rideGroup: {
          include: {
            pickupPoint: {
              select: {
                id: true,
                name: true,
              },
            },
            members: {
              where: { isActiveMember: true },
              select: { id: true, dropoffSequenceOrder: true },
            },
            routeVersions: {
              orderBy: { versionNumber: 'desc' },
              take: 1,
              select: {
                totalDistanceMeters: true,
                totalDurationSec: true,
              },
            },
          },
        },
      },
      orderBy: {
        expiresAt: 'asc',
      },
    });

    return pendingOffers.map((offer) => {
      const remainingSeconds = Math.max(
        0,
        Math.round((offer.expiresAt.getTime() - Date.now()) / 1000),
      );
      const activeMembersCount = offer.rideGroup.members.length;
      const latestRoute = offer.rideGroup.routeVersions[0];

      return {
        offerId: offer.id,
        dispatchAttemptId: offer.dispatchAttemptId,
        rideGroupId: offer.rideGroupId,
        groupVersion: offer.groupVersion,
        pickupPoint: {
          id: offer.rideGroup.pickupPoint.id,
          name: offer.rideGroup.pickupPoint.name,
        },
        passengerCount: activeMembersCount,
        totalEstimatedFare: (
          offer.rideGroup.totalSharedFarePaise / 100
        ).toFixed(2),
        totalDistanceMeters:
          latestRoute?.totalDistanceMeters ??
          offer.rideGroup.totalRouteDistanceMeters,
        totalDurationSec:
          latestRoute?.totalDurationSec ??
          offer.rideGroup.totalRouteDurationSec,
        offeredAt: offer.offeredAt.toISOString(),
        expiresAt: offer.expiresAt.toISOString(),
        remainingSeconds,
      };
    });
  }

  /**
   * Driver explicitly rejects an offer.
   * Atomically sets offer to 'REJECTED' and triggers immediate cascade to Rank #2 driver.
   */
  async rejectOffer(
    userId: string,
    offerId: string,
    dto?: RejectOfferDto,
    claim?: IdempotencyClaimContext,
  ): Promise<{ success: boolean; message: string }> {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });

    if (!driver) {
      throw new NotFoundException({
        errorCode: 'DRIVER_NOT_FOUND',
        message: 'Driver profile not found',
      });
    }

    if (driver.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException({
        errorCode: 'DRIVER_NOT_APPROVED',
        message: 'Driver profile is not approved',
      });
    }

    const rideGroupIdToCascade = await this.prisma.$transaction(async (tx) => {
      // 1. Lock offer row
      const lockedOffers = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          driver_id: string;
          ride_group_id: string;
          group_version: number;
          dispatch_attempt_id: string;
          expires_at: Date;
        }>
      >`
        SELECT id, status, driver_id, ride_group_id, group_version, dispatch_attempt_id, expires_at
        FROM driver_dispatch_offers
        WHERE id = ${offerId}::uuid
        FOR UPDATE
      `;

      if (!lockedOffers || lockedOffers.length === 0) {
        throw new NotFoundException({
          errorCode: 'OFFER_NOT_FOUND',
          message: 'Dispatch offer not found',
        });
      }

      const lockedOffer = lockedOffers[0];

      if (lockedOffer.driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'FORBIDDEN_OFFER_ACCESS',
          message: 'Offer belongs to another driver',
        });
      }

      // Idempotent retry: already rejected
      if (lockedOffer.status === 'REJECTED') {
        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          { success: true, message: 'Offer already rejected' },
          200,
        );
        return null;
      }

      if (lockedOffer.status !== 'PENDING') {
        throw new ConflictException({
          errorCode: 'OFFER_NOT_PENDING',
          message: `Offer cannot be rejected in status '${lockedOffer.status}'`,
        });
      }

      if (new Date() >= new Date(lockedOffer.expires_at)) {
        throw new ConflictException({
          errorCode: 'OFFER_EXPIRED',
          message: 'Offer has expired',
        });
      }

      // Update offer to REJECTED
      await tx.driverDispatchOffer.update({
        where: { id: offerId },
        data: {
          status: 'REJECTED',
          respondedAt: new Date(),
        },
      });

      // Record outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'DISPATCH_OFFER_REJECTED',
          aggregateType: 'DRIVER_DISPATCH_OFFER',
          aggregateId: offerId,
          payload: {
            offerId,
            rideGroupId: lockedOffer.ride_group_id,
            driverId: driver.id,
            groupVersion: lockedOffer.group_version,
            dispatchAttemptId: lockedOffer.dispatch_attempt_id,
            reason: dto?.reason ?? null,
            rejectedAt: new Date().toISOString(),
          },
        },
      });

      // Complete idempotency claim
      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        { success: true, message: 'Offer rejected successfully' },
        200,
      );

      return lockedOffer.ride_group_id;
    });

    // 2. Cascade sequentially to next candidate driver (OUTSIDE DB transaction)
    if (rideGroupIdToCascade) {
      try {
        await this.initiateDispatchForGroup(rideGroupIdToCascade);
      } catch (err: any) {
        this.logger.warn(
          `Direct cascade for group ${rideGroupIdToCascade} after offer ${offerId} rejection failed (${err?.message}); durable outbox will retry`,
        );
      }

      if (this.outboxService) {
        this.outboxService.triggerImmediateProcessing().catch(() => {});
      }
    }

    return { success: true, message: 'Offer rejected successfully' };
  }

  /**
   * Driver accepts a dispatch offer.
   *
   * Atomic Reservation Guarantee:
   * 1. Lock ride_groups row FOR UPDATE.
   * 2. Lock driver_profiles row FOR UPDATE + Atomic CAS (operational_status = 'AVAILABLE' -> 'RESERVED').
   * 3. Lock driver_dispatch_offers row FOR UPDATE.
   * 4. Transition offer to ACCEPTED.
   * 5. Create driver_assignments record (RESERVED).
   * 6. Transition ride_groups to DRIVER_ASSIGNED.
   * 7. Materialize Trip (CREATED) and trip_status_history.
   * 8. Transition bookings to DRIVER_ASSIGNED and materialize trip_passengers with 4-digit hashed OTPs.
   * 9. Withdraw competing offers for same group and driver's other offers across groups (ADR-018).
   * 10. Persist DISPATCH_OFFER_ACCEPTED and TRIP_CREATED outbox events.
   * 11. Complete idempotency claim.
   */
  async acceptOffer(
    userId: string,
    offerId: string,
    claim?: IdempotencyClaimContext,
  ): Promise<AcceptOfferResponseData> {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        vehicles: { where: { isActive: true } },
      },
    });

    if (!driver) {
      throw new NotFoundException({
        errorCode: 'DRIVER_NOT_FOUND',
        message: 'Driver profile not found',
      });
    }

    if (driver.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException({
        errorCode: 'DRIVER_NOT_APPROVED',
        message: 'Driver profile is not approved',
      });
    }

    // Verify driver has no existing active assignment
    const existingAssignment = await this.prisma.driverAssignment.findFirst({
      where: {
        driverId: driver.id,
        status: { in: ['RESERVED', 'ACTIVE'] },
      },
    });

    if (existingAssignment) {
      throw new ConflictException({
        errorCode: 'DRIVER_ALREADY_ASSIGNED',
        message: 'Driver already has an active assignment',
      });
    }

    // Identify offers to cascade after commit (multi-offer withdrawal)
    const withdrawnGroupIds: string[] = [];
    const memberOtps: Array<{ bookingId: string; otp: string }> = [];

    const responseData = await this.prisma.$transaction(async (tx) => {
      // Step 1: Pre-fetch offer basic details
      const offerBasic = await tx.driverDispatchOffer.findUnique({
        where: { id: offerId },
        select: { rideGroupId: true, driverId: true },
      });

      if (!offerBasic) {
        throw new NotFoundException({
          errorCode: 'OFFER_NOT_FOUND',
          message: 'Dispatch offer not found',
        });
      }

      if (offerBasic.driverId !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'FORBIDDEN_OFFER_ACCESS',
          message: 'Offer belongs to another driver',
        });
      }

      // Step 2: Lock ride_groups row
      const lockedGroups = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          group_version: number;
          total_shared_fare_paise: number;
        }>
      >`
        SELECT id, status, group_version, total_shared_fare_paise
        FROM ride_groups
        WHERE id = ${offerBasic.rideGroupId}::uuid
        FOR UPDATE
      `;

      if (!lockedGroups || lockedGroups.length === 0) {
        throw new NotFoundException({
          errorCode: 'RIDE_GROUP_NOT_FOUND',
          message: 'Ride group not found',
        });
      }

      const lockedGroup = lockedGroups[0];

      if (
        lockedGroup.status !== 'DISPATCHING' &&
        lockedGroup.status !== 'READY_FOR_DISPATCH'
      ) {
        throw new ConflictException({
          errorCode: 'OFFER_ALREADY_TAKEN',
          message: `Ride group is no longer in dispatching state (status=${lockedGroup.status})`,
        });
      }

      // Step 3: Lock driver_profiles row and execute Atomic CAS
      const lockedDrivers = await tx.$queryRaw<
        Array<{
          id: string;
          operational_status: string;
          is_online: boolean;
        }>
      >`
        SELECT id, operational_status, is_online
        FROM driver_profiles
        WHERE id = ${driver.id}::uuid
        FOR UPDATE
      `;

      if (!lockedDrivers || lockedDrivers.length === 0) {
        throw new NotFoundException('Driver profile not found during lock');
      }

      const updateDriverResult = await tx.$executeRaw`
        UPDATE driver_profiles
        SET operational_status = 'RESERVED',
            updated_at = NOW()
        WHERE id = ${driver.id}::uuid
          AND operational_status = 'AVAILABLE'
          AND is_online = true
      `;

      if (updateDriverResult === 0) {
        throw new ConflictException({
          errorCode: 'OFFER_ALREADY_TAKEN',
          message: 'Driver is no longer available or is offline',
        });
      }

      // Step 4: Lock driver_dispatch_offers row
      const lockedOffers = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          group_version: number;
          dispatch_attempt_id: string;
          expires_at: Date;
        }>
      >`
        SELECT id, status, group_version, dispatch_attempt_id, expires_at
        FROM driver_dispatch_offers
        WHERE id = ${offerId}::uuid
        FOR UPDATE
      `;

      if (!lockedOffers || lockedOffers.length === 0) {
        throw new NotFoundException('Offer not found during lock');
      }

      const lockedOffer = lockedOffers[0];

      if (lockedOffer.status !== 'PENDING') {
        throw new ConflictException({
          errorCode: 'OFFER_ALREADY_TAKEN',
          message: `Offer is no longer pending (status=${lockedOffer.status})`,
        });
      }

      if (lockedOffer.group_version !== lockedGroup.group_version) {
        throw new ConflictException({
          errorCode: 'OFFER_ALREADY_TAKEN',
          message: 'Ride group version changed before acceptance',
        });
      }

      if (new Date() >= new Date(lockedOffer.expires_at)) {
        throw new ConflictException({
          errorCode: 'OFFER_EXPIRED',
          message: 'Offer has expired',
        });
      }

      // Step 5: Verify group members and vehicle capacity
      const groupMembers = await tx.groupMember.findMany({
        where: {
          rideGroupId: lockedGroup.id,
          isActiveMember: true,
        },
        include: {
          booking: true,
        },
        orderBy: {
          dropoffSequenceOrder: 'asc',
        },
      });

      if (groupMembers.length === 0) {
        throw new ConflictException({
          errorCode: 'GROUP_EMPTY',
          message: 'No active members in ride group',
        });
      }

      const maxVehicleCapacity = Math.max(
        ...driver.vehicles.map((v) => v.passengerCapacity),
        0,
      );

      if (maxVehicleCapacity < groupMembers.length) {
        throw new ConflictException({
          errorCode: 'INSUFFICIENT_VEHICLE_CAPACITY',
          message: `Vehicle capacity (${maxVehicleCapacity}) is less than group size (${groupMembers.length})`,
        });
      }

      // Step 6: Mark winning offer ACCEPTED
      await tx.driverDispatchOffer.update({
        where: { id: offerId },
        data: {
          status: 'ACCEPTED',
          respondedAt: new Date(),
        },
      });

      // Step 7: Create DriverAssignment (status: RESERVED)
      const assignment = await tx.driverAssignment.create({
        data: {
          dispatchAttemptId: lockedOffer.dispatch_attempt_id,
          rideGroupId: lockedGroup.id,
          driverId: driver.id,
          status: 'RESERVED',
          assignedAt: new Date(),
        },
      });

      // Step 8: Update DispatchAttempt status to SUCCEEDED
      await tx.dispatchAttempt.update({
        where: { id: lockedOffer.dispatch_attempt_id },
        data: { status: 'SUCCEEDED' },
      });

      // Step 9: Transition RideGroup to DRIVER_ASSIGNED
      await tx.rideGroup.update({
        where: { id: lockedGroup.id },
        data: { status: 'DRIVER_ASSIGNED' },
      });

      // Step 10: Materialize Trip record
      const trip = await tx.trip.create({
        data: {
          rideGroupId: lockedGroup.id,
          driverAssignmentId: assignment.id,
          activeDriverId: driver.id,
          status: 'CREATED',
        },
      });

      await tx.tripStatusHistory.create({
        data: {
          tripId: trip.id,
          previousStatus: 'NONE',
          newStatus: 'CREATED',
          reason: 'Driver accepted dispatch offer; trip materialized',
        },
      });

      // Step 11: Transition bookings, create trip passengers & 4-digit hashed OTPs
      for (const member of groupMembers) {
        const b = member.booking;

        await tx.booking.update({
          where: { id: b.id },
          data: { status: 'DRIVER_ASSIGNED' },
        });

        await tx.bookingStatusHistory.create({
          data: {
            bookingId: b.id,
            previousStatus: b.status,
            newStatus: 'DRIVER_ASSIGNED',
            reason:
              'Driver accepted dispatch offer; driver assigned to ride group',
          },
        });

        const tripPassenger = await tx.tripPassenger.create({
          data: {
            tripId: trip.id,
            bookingId: b.id,
            passengerId: b.passengerId,
            status: 'WAITING',
            finalRideFarePaise: member.allocatedFarePaise,
            waitingChargePaise: 0,
          },
        });

        const otp = deriveBoardingOtp(b.id, assignment.id);
        const otpHash = hashBoardingOtp(otp);

        await tx.boardingVerification.create({
          data: {
            tripPassengerId: tripPassenger.id,
            otpHash,
            maxAttempts: 3,
            attemptsCount: 0,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min expiry
          },
        });

        memberOtps.push({ bookingId: b.id, otp });
      }

      // Step 12: Multi-Offer Withdrawal (ADR-018)
      // 12a: Withdraw competing pending offers for THIS group
      await tx.driverDispatchOffer.updateMany({
        where: {
          rideGroupId: lockedGroup.id,
          status: 'PENDING',
          id: { not: offerId },
        },
        data: {
          status: 'WITHDRAWN',
          respondedAt: new Date(),
        },
      });

      // 12b: Find and withdraw THIS driver's pending offers for OTHER groups
      const driverOtherOffers = await tx.driverDispatchOffer.findMany({
        where: {
          driverId: driver.id,
          status: 'PENDING',
          id: { not: offerId },
        },
        select: { id: true, rideGroupId: true },
      });

      for (const o of (driverOtherOffers ?? [])) {
        withdrawnGroupIds.push(o.rideGroupId);
      }

      await tx.driverDispatchOffer.updateMany({
        where: {
          driverId: driver.id,
          status: 'PENDING',
          id: { not: offerId },
        },
        data: {
          status: 'WITHDRAWN',
          respondedAt: new Date(),
        },
      });

      // Step 13: Persist Outbox Events
      await tx.outboxEvent.create({
        data: {
          eventType: 'DISPATCH_OFFER_ACCEPTED',
          aggregateType: 'DRIVER_DISPATCH_OFFER',
          aggregateId: offerId,
          payload: {
            offerId,
            assignmentId: assignment.id,
            tripId: trip.id,
            driverId: driver.id,
            rideGroupId: lockedGroup.id,
            acceptedAt: new Date().toISOString(),
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          eventType: 'TRIP_CREATED',
          aggregateType: 'TRIP',
          aggregateId: trip.id,
          payload: {
            tripId: trip.id,
            rideGroupId: lockedGroup.id,
            driverId: driver.id,
            driverAssignmentId: assignment.id,
            passengerCount: groupMembers.length,
            createdAt: new Date().toISOString(),
          },
        },
      });

      // Step 14: Route Geometry & Stops
      const routeVersion = await tx.groupRouteVersion.findFirst({
        where: {
          rideGroupId: lockedGroup.id,
          versionNumber: lockedGroup.group_version,
        },
      });

      const stops = await tx.$queryRaw<
        Array<{
          id: string;
          stop_order: number;
          stop_type: string;
          latitude: number;
          longitude: number;
        }>
      >`
        SELECT
          s.id,
          s.stop_order,
          s.stop_type,
          ST_Y(s.stop_location::geometry) as latitude,
          ST_X(s.stop_location::geometry) as longitude
        FROM group_route_stops s
        WHERE s.group_route_version_id = ${
          routeVersion?.id ?? '00000000-0000-0000-0000-000000000000'
        }::uuid
        ORDER BY s.stop_order ASC
      `;

      const response: AcceptOfferResponseData = {
        assignmentId: assignment.id,
        tripId: trip.id,
        rideGroupId: lockedGroup.id,
        passengerCount: groupMembers.length,
        totalEstimatedFare: (
          lockedGroup.total_shared_fare_paise / 100
        ).toFixed(2),
        navigationRoute: {
          geometry: routeVersion?.routeGeometry ?? {},
          stops: stops.map((s) => ({
            stopOrder: s.stop_order,
            stopType: s.stop_type,
            latitude: Number(s.latitude),
            longitude: Number(s.longitude),
          })),
        },
      };

      // Complete idempotency claim
      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        {
          success: true,
          data: response,
        },
        200,
      );

      return response;
    });

    // Step 15: Post-Commit Immediate Cascade for other groups whose offers were withdrawn
    for (const gId of withdrawnGroupIds) {
      this.initiateDispatchForGroup(gId).catch((err) => {
        this.logger.warn(
          `Post-withdrawal cascade for group ${gId} encountered error: ${err?.message}`,
        );
      });
    }

    // Step 16: Cache generated boarding OTPs in Redis outside the PostgreSQL transaction
    if (this.redisService) {
      for (const m of memberOtps) {
        this.redisService.setPassengerBoardingOtp(m.bookingId, m.otp, 1800).catch((err) => {
          this.logger.warn(
            `Failed to cache boarding OTP for booking ${m.bookingId} in Redis: ${err?.message}`,
          );
        });
      }
    }

    return responseData;
  }
}
