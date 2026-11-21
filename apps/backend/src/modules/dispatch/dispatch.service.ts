import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { DriversService } from '../drivers/drivers.service.js';
import { RoutingService } from '../routing/routing.service.js';
import {
  CandidateDriver,
  DispatchResult,
  DRIVER_OFFER_TIMEOUT_MS,
} from './dispatch.interfaces.js';

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
 * 2. Multi-Offer Capability: An available driver MAY receive multiple pending offers for different groups.
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
 * 6. Row-Lock Strategy for Driver Reservation (Phase 4 Preparation):
 *    When a driver accepts an offer in Phase 4:
 *    a. Lock ride group row: `SELECT id, status, group_version FROM ride_groups WHERE id = :id FOR UPDATE`
 *    b. Atomic CAS on driver operational status:
 *       `UPDATE driver_profiles SET operational_status = 'RESERVED' WHERE id = :driverId AND operational_status = 'AVAILABLE'`
 *       If 0 rows affected -> throw ConflictException('DRIVER_UNAVAILABLE').
 *    c. Transition offer to ACCEPTED, create driver_assignments record (RESERVED).
 *    d. Withdraw conflicting offers atomically:
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
      return [];
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
      return [];
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
   * Initiates sequential 1-to-1 dispatch for a ride group.
   *
   * Flow:
   * 1. Validates ride group status ('READY_FOR_DISPATCH' or 'DISPATCHING').
   * 2. Checks for existing active pending offer (short-circuit idempotency).
   * 3. Finds and ranks eligible candidate drivers via OSRM outside the DB transaction.
   * 4. Atomically reserves the offer in a short PostgreSQL transaction:
   *    - Acquires row lock on ride group (`FOR UPDATE`).
   *    - Verifies group status under lock.
   *    - Re-verifies absence of pending offers.
   *    - Creates or retrieves active DispatchAttempt.
   *    - Inserts DriverDispatchOffer with 20-second timeout.
   *    - Updates RideGroup status to 'DISPATCHING'.
   * 5. Passenger bookings remain in 'MATCHED' status throughout dispatch.
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

    // 2. Validate group status
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

    // 3. Fast-path idempotency: return existing pending offer if already active
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
    const rankedCandidates = await this.findEligibleCandidateDrivers(
      rideGroupId,
      rideGroup.pickupPointId,
      groupSize,
      activeAttempt?.id,
    );

    if (rankedCandidates.length === 0) {
      this.logger.warn(
        `No eligible ranked candidate drivers found for ride group ${rideGroupId}`,
      );
      return {
        success: false,
        reason: 'NO_ELIGIBLE_DRIVERS',
        message:
          'No eligible candidate drivers available with valid OSRM routes',
      };
    }

    const rank1Driver = rankedCandidates[0];

    // 6. Execute short atomic PostgreSQL persistence transaction
    try {
      return await this.prisma.$transaction(async (tx) => {
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

        // f. Update ride group status to DISPATCHING
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
  }
}
