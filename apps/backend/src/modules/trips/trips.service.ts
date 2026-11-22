import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { RoutingService } from '../routing/routing.service.js';
import { CACHE_KEYS, QUEUES } from '../../common/constants/index.js';
import { hashBoardingOtp } from '../../common/utils/otp.util.js';
import { VerifyBoardingDto } from './dto/verify-boarding.dto.js';
import { ReportBreakdownDto } from './dto/report-breakdown.dto.js';
import { calculateWaitingChargePaise } from './trips.util.js';
import {
  IdempotencyClaimContext,
  verifyIdempotencyClaim,
  fenceAndCompleteIdempotentTransaction,
} from '../../common/interceptors/idempotency.interceptor.js';

export interface TripPassengerResponse {
  id: string;
  passengerId: string;
  bookingId: string;
  status: string;
  finalRideFarePaise: number;
  waitingChargePaise: number;
  boardedAt: string | null;
  droppedOffAt: string | null;
}

export interface TripDetailResponse {
  tripId: string;
  rideGroupId: string;
  activeDriverId: string;
  status: string;
  driverArrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  passengers: TripPassengerResponse[];
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly redisService?: RedisService,
    @Optional()
    private readonly routingService?: RoutingService,
    @Optional()
    @InjectQueue(QUEUES.DISPATCH)
    private readonly dispatchQueue?: Queue,
  ) {}

  /**
   * Helper to verify calling driver exists, is approved, and matches assigned trip driver
   */
  private async getVerifiedDriverProfile(userId: string) {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });

    if (!driver) {
      throw new ForbiddenException({
        errorCode: 'DRIVER_PROFILE_NOT_FOUND',
        message: 'No driver profile associated with this user account.',
      });
    }

    if (driver.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException({
        errorCode: 'DRIVER_NOT_APPROVED',
        message: 'Driver profile has not been approved by administrator.',
      });
    }

    return driver;
  }

  /**
   * Driver reports arrival at pickup hub (PDEU Main Gate).
   * Strictly evaluates the server-recorded GPS telemetry in Redis (<= 30s fresh).
   * Frontend-supplied coordinates are never evaluated or trusted.
   * Enforces 150m geofence via PostGIS ST_DWithin.
   * Transitions trip to AT_PICKUP, persists driver_arrived_at exactly once,
   * updates associated bookings to DRIVER_ARRIVED, and is idempotent on duplicate arrival calls.
   */
  async reportArrival(
    driverUserId: string,
    tripId: string,
    claimOrMaybeDto?: IdempotencyClaimContext | Record<string, unknown>,
    maybeClaim?: IdempotencyClaimContext,
  ) {
    let claim: IdempotencyClaimContext | undefined;

    if (
      claimOrMaybeDto &&
      ('ownerToken' in claimOrMaybeDto || 'idempotencyKey' in claimOrMaybeDto)
    ) {
      claim = claimOrMaybeDto as IdempotencyClaimContext;
    } else if (
      maybeClaim &&
      ('ownerToken' in maybeClaim || 'idempotencyKey' in maybeClaim)
    ) {
      claim = maybeClaim;
    }

    const driver = await this.getVerifiedDriverProfile(driverUserId);

    // Retrieve driver GPS fix strictly from Redis before opening DB transaction
    let gpsFix: {
      latitude: number;
      longitude: number;
      heading?: number | null;
      speed?: number | null;
      updatedAt?: string;
    } | null = null;

    if (this.redisService) {
      try {
        const client = this.redisService.getClient();
        const raw = await client.get(
          `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driver.id}`,
        );
        if (raw) {
          gpsFix = JSON.parse(raw);
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to read driver GPS fix from Redis for arrival geofence check: ${err?.message}`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Verify claim ownership and lock idempotency record
      await verifyIdempotencyClaim(tx, claim);

      // Pessimistic lock on trip row using SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_assignment_id: string;
          ride_group_id: string;
          driver_arrived_at: Date | null;
        }>
      >`
        SELECT id, status, active_driver_id, driver_assignment_id, ride_group_id, driver_arrived_at
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.active_driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'DRIVER_NOT_ASSIGNED_TO_TRIP',
          message: 'Caller is not the assigned active driver for this trip.',
        });
      }

      // Requirement: Duplicate arrival requests must return the existing successful arrival result
      // without resetting driver_arrived_at or requiring another GPS check.
      if (trip.status === 'AT_PICKUP') {
        const arrivalResult = {
          tripId: trip.id,
          status: trip.status,
          driverArrivedAt: trip.driver_arrived_at
            ? new Date(trip.driver_arrived_at).toISOString()
            : null,
        };

        const responsePayload = {
          success: true,
          message: 'Driver arrival confirmed',
          data: arrivalResult,
        };

        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.OK,
        );

        return arrivalResult;
      }

      if (!['CREATED', 'DRIVER_EN_ROUTE'].includes(trip.status)) {
        throw new BadRequestException({
          errorCode: 'INVALID_TRIP_STATUS_FOR_ARRIVAL',
          message: `Cannot report arrival for trip in status '${trip.status}'.`,
        });
      }

      // Strict Server-Recorded GPS Telemetry Validation
      if (!gpsFix) {
        throw new BadRequestException({
          errorCode: 'MISSING_GPS_FIX',
          message:
            'No recorded GPS telemetry found for driver. Active GPS fix is required to verify arrival at pickup hub.',
        });
      }

      const lat = gpsFix.latitude;
      const lng = gpsFix.longitude;

      if (
        typeof lat !== 'number' ||
        typeof lng !== 'number' ||
        isNaN(lat) ||
        isNaN(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        throw new BadRequestException({
          errorCode: 'INVALID_GPS_FIX',
          message: 'Driver GPS fix contains invalid coordinates.',
        });
      }

      const fixTime = gpsFix.updatedAt
        ? new Date(gpsFix.updatedAt).getTime()
        : NaN;
      const nowMs = Date.now();
      const MAX_GPS_AGE_MS = 30_000;

      if (isNaN(fixTime) || nowMs - fixTime > MAX_GPS_AGE_MS) {
        throw new BadRequestException({
          errorCode: 'STALE_GPS_FIX',
          message:
            'Driver GPS fix is stale (>30s old). Recent telemetry required to verify pickup arrival.',
        });
      }

      // Enforce approved PDEU pickup geofence (150m radius) via PostGIS
      const geofenceCheck = await tx.$queryRaw<
        Array<{
          id: string;
          name: string;
          radius_meters: number;
          distance_meters: number;
          is_valid: boolean;
        }>
      >`
        SELECT
          pp.id,
          pp.name,
          pp.radius_meters,
          ST_Distance(pp.center_point::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) as distance_meters,
          ST_DWithin(pp.center_point::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, pp.radius_meters) as is_valid
        FROM ride_groups rg
        JOIN pickup_points pp ON rg.pickup_point_id = pp.id
        WHERE rg.id = ${trip.ride_group_id}::uuid;
      `;

      if (
        !geofenceCheck ||
        geofenceCheck.length === 0 ||
        !geofenceCheck[0].is_valid
      ) {
        const distance =
          geofenceCheck && geofenceCheck.length > 0
            ? `${Math.round(Number(geofenceCheck[0].distance_meters))}m`
            : 'unknown distance';
        const hubName =
          geofenceCheck && geofenceCheck.length > 0
            ? geofenceCheck[0].name
            : 'pickup hub';
        const limit =
          geofenceCheck && geofenceCheck.length > 0
            ? `${geofenceCheck[0].radius_meters}m`
            : '150m';

        throw new BadRequestException({
          errorCode: 'OUTSIDE_PICKUP_GEOFENCE',
          message: `Driver location is ${distance} from ${hubName}, exceeding the authorized ${limit} geofence limit.`,
        });
      }

      const now = new Date();

      // Update trip status to AT_PICKUP and persist driver_arrived_at exactly once
      const updatedTrip = await tx.trip.update({
        where: { id: tripId },
        data: {
          status: 'AT_PICKUP',
          driverArrivedAt: now,
        },
      });

      // Update driver assignment arrived_at
      await tx.driverAssignment.update({
        where: { id: trip.driver_assignment_id },
        data: { arrivedAt: now },
      });

      // Update associated bookings to DRIVER_ARRIVED
      const passengers = await tx.tripPassenger.findMany({
        where: { tripId },
      });

      for (const p of passengers) {
        await tx.booking.update({
          where: { id: p.bookingId },
          data: { status: 'DRIVER_ARRIVED' },
        });

        await tx.bookingStatusHistory.create({
          data: {
            bookingId: p.bookingId,
            previousStatus: 'DRIVER_ASSIGNED',
            newStatus: 'DRIVER_ARRIVED',
            reason: 'Driver reported arrival at pickup hub',
          },
        });
      }

      // Record trip status history
      await tx.tripStatusHistory.create({
        data: {
          tripId,
          previousStatus: trip.status,
          newStatus: 'AT_PICKUP',
          reason: 'Driver arrived at pickup hub',
        },
      });

      // Outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'TRIP_DRIVER_ARRIVED',
          aggregateType: 'TRIP',
          aggregateId: tripId,
          payload: {
            tripId,
            driverId: driver.id,
            arrivedAt: now,
          },
        },
      });

      const arrivalResult = {
        tripId: updatedTrip.id,
        status: updatedTrip.status,
        driverArrivedAt: updatedTrip.driverArrivedAt?.toISOString(),
      };

      const responsePayload = {
        success: true,
        message: 'Driver arrival confirmed',
        data: arrivalResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return arrivalResult;
    });
  }

  /**
   * Verify passenger boarding via secure 4-digit hashed OTP.
   * Calculates waiting charges: first 5m free, ₹5/started min thereafter.
   * Atomic attempt tracking commits failed attempts to prevent rollback bypass.
   */
  async verifyBoarding(
    driverUserId: string,
    tripId: string,
    dto: VerifyBoardingDto,
    claim?: IdempotencyClaimContext,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    const result = await this.prisma.$transaction(async (tx) => {
      // Verify claim ownership and lock idempotency record
      await verifyIdempotencyClaim(tx, claim);

      // Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_arrived_at: Date | null;
        }>
      >`
        SELECT id, status, active_driver_id, driver_arrived_at
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.active_driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'DRIVER_NOT_ASSIGNED_TO_TRIP',
          message: 'Caller is not the assigned driver for this trip.',
        });
      }

      // Review Finding 6.1: Verify trip state is in pickup state (AT_PICKUP)
      if (trip.status !== 'AT_PICKUP') {
        throw new BadRequestException({
          errorCode: 'INVALID_TRIP_STATUS_FOR_BOARDING',
          message: `Trip must be in status 'AT_PICKUP' to verify boarding (current: '${trip.status}').`,
        });
      }

      // Lock trip passenger row with SELECT ... FOR UPDATE
      const passengers = await tx.$queryRaw<
        Array<{
          id: string;
          trip_id: string;
          passenger_id: string;
          booking_id: string;
          status: string;
          waiting_charge_paise: number;
          boarded_at: Date | null;
        }>
      >`
        SELECT id, trip_id, passenger_id, booking_id, status, waiting_charge_paise, boarded_at
        FROM trip_passengers
        WHERE trip_id = ${tripId}::uuid AND passenger_id = ${dto.passengerId}::uuid
        FOR UPDATE;
      `;

      if (!passengers || passengers.length === 0) {
        throw new NotFoundException({
          errorCode: 'PASSENGER_NOT_ON_TRIP',
          message: 'Passenger is not associated with this trip manifest.',
        });
      }

      const passenger = passengers[0];

      // Lock boarding verification row with SELECT ... FOR UPDATE
      const verifications = await tx.$queryRaw<
        Array<{
          id: string;
          trip_passenger_id: string;
          otp_hash: string;
          is_verified: boolean;
          attempts_count: number;
          max_attempts: number;
          expires_at: Date;
        }>
      >`
        SELECT id, trip_passenger_id, otp_hash, is_verified, attempts_count, max_attempts, expires_at
        FROM boarding_verifications
        WHERE trip_passenger_id = ${passenger.id}::uuid
        FOR UPDATE;
      `;

      if (!verifications || verifications.length === 0) {
        throw new NotFoundException({
          errorCode: 'BOARDING_VERIFICATION_NOT_FOUND',
          message: 'No boarding verification found for passenger.',
        });
      }

      const verification = verifications[0];

      if (verification.is_verified && passenger.status === 'BOARDED') {
        const alreadyBoardedResult = {
          tripPassengerId: passenger.id,
          passengerStatus: passenger.status,
          waitingChargePaise: passenger.waiting_charge_paise,
          boardedAt: passenger.boarded_at?.toISOString(),
        };

        const responsePayload = {
          success: true,
          message: 'Passenger boarding verified',
          data: alreadyBoardedResult,
        };

        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.OK,
        );

        return {
          outcome: 'ALREADY_BOARDED',
          data: alreadyBoardedResult,
          bookingId: passenger.booking_id,
        };
      }

      // Check passenger status: Must be WAITING if not already BOARDED
      if (passenger.status !== 'WAITING') {
        throw new BadRequestException({
          errorCode: 'INVALID_PASSENGER_STATUS_FOR_BOARDING',
          message: `Cannot verify boarding for passenger in status '${passenger.status}'. Must be 'WAITING'.`,
        });
      }

      const now = new Date();

      // Check if OTP has expired
      if (
        verification.expires_at &&
        new Date(verification.expires_at).getTime() <= now.getTime()
      ) {
        const timestamp = now.toISOString();
        const path =
          claim?.requestUrl || `/api/v1/trips/${tripId}/verify-boarding`;

        const errorPayload = {
          success: false,
          statusCode: HttpStatus.BAD_REQUEST,
          errorCode: 'OTP_EXPIRED',
          message: 'Boarding OTP has expired.',
          errors: [],
          timestamp,
          path,
        };

        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          errorPayload,
          HttpStatus.BAD_REQUEST,
        );

        return { outcome: 'OTP_EXPIRED', timestamp };
      }

      // Enforce maximum 3 attempts
      if (verification.attempts_count >= verification.max_attempts) {
        const timestamp = now.toISOString();
        const path =
          claim?.requestUrl || `/api/v1/trips/${tripId}/verify-boarding`;

        const errorPayload = {
          success: false,
          statusCode: HttpStatus.BAD_REQUEST,
          errorCode: 'OTP_MAX_ATTEMPTS_EXCEEDED',
          message: 'Maximum OTP verification attempts (3) exceeded.',
          errors: [],
          timestamp,
          path,
        };

        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          errorPayload,
          HttpStatus.BAD_REQUEST,
        );

        return { outcome: 'MAX_ATTEMPTS_EXCEEDED', timestamp };
      }

      // Compare SHA-256 hash using hashBoardingOtp
      const inputHash = hashBoardingOtp(dto.otp);

      if (inputHash !== verification.otp_hash) {
        // Increment attempts count inside transaction
        await tx.boardingVerification.update({
          where: { id: verification.id },
          data: {
            attemptsCount: { increment: 1 },
          },
        });

        const timestamp = now.toISOString();
        const path =
          claim?.requestUrl || `/api/v1/trips/${tripId}/verify-boarding`;

        const errorPayload = {
          success: false,
          statusCode: HttpStatus.BAD_REQUEST,
          errorCode: 'INVALID_OTP',
          message: 'Invalid boarding OTP provided.',
          errors: [],
          timestamp,
          path,
        };

        // Complete the idempotency record atomically within this SAME transaction
        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          errorPayload,
          HttpStatus.BAD_REQUEST,
        );

        return { outcome: 'INVALID_OTP', timestamp };
      }

      // OTP matched: Calculate waiting charges using authoritative rule
      const waitingChargePaise = calculateWaitingChargePaise(
        trip.driver_arrived_at,
        now,
      );

      // Mark verification completed
      await tx.boardingVerification.update({
        where: { id: verification.id },
        data: {
          isVerified: true,
          verifiedAt: now,
        },
      });

      // Update passenger journey status
      const updatedPassenger = await tx.tripPassenger.update({
        where: { id: passenger.id },
        data: {
          status: 'BOARDED',
          boardedAt: now,
          waitingChargePaise,
        },
      });

      // Update booking status
      await tx.booking.update({
        where: { id: passenger.booking_id },
        data: { status: 'BOARDED' },
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: passenger.booking_id,
          previousStatus: 'DRIVER_ARRIVED',
          newStatus: 'BOARDED',
          reason: 'Boarding verified via 4-digit OTP',
        },
      });

      // Outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'PASSENGER_BOARDED',
          aggregateType: 'TRIP_PASSENGER',
          aggregateId: passenger.id,
          payload: {
            tripId,
            passengerId: dto.passengerId,
            waitingChargePaise,
            boardedAt: now,
          },
        },
      });

      const boardingResult = {
        tripPassengerId: updatedPassenger.id,
        passengerStatus: updatedPassenger.status,
        waitingChargePaise,
        boardedAt: updatedPassenger.boardedAt?.toISOString(),
      };

      const responsePayload = {
        success: true,
        message: 'Passenger boarding verified',
        data: boardingResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return {
        outcome: 'SUCCESS',
        data: boardingResult,
        bookingId: passenger.booking_id,
      };
    });

    const bookingIdToInvalidate = (result as any).bookingId;
    if (
      bookingIdToInvalidate &&
      (result.outcome === 'SUCCESS' || result.outcome === 'ALREADY_BOARDED')
    ) {
      this.redisService
        ?.deletePassengerBoardingOtp(bookingIdToInvalidate)
        .catch((err) => {
          this.logger.warn(
            `Failed to invalidate Redis passenger boarding OTP for booking ${bookingIdToInvalidate}: ${(err as Error).message}`,
          );
        });
    }

    if (result.outcome === 'OTP_EXPIRED') {
      throw new BadRequestException({
        errorCode: 'OTP_EXPIRED',
        message: 'Boarding OTP has expired.',
        timestamp: result.timestamp,
      });
    }

    if (result.outcome === 'MAX_ATTEMPTS_EXCEEDED') {
      throw new BadRequestException({
        errorCode: 'OTP_MAX_ATTEMPTS_EXCEEDED',
        message: 'Maximum OTP verification attempts (3) exceeded.',
        timestamp: result.timestamp,
      });
    }

    if (result.outcome === 'INVALID_OTP') {
      throw new BadRequestException({
        errorCode: 'INVALID_OTP',
        message: 'Invalid boarding OTP provided.',
        timestamp: result.timestamp,
      });
    }

    return result.data;
  }

  /**
   * Driver departs pickup hub: transitions vehicle trip from AT_PICKUP to IN_PROGRESS.
   * Requires all active passengers to be BOARDED (at least 1 passenger boarded).
   * Transitions ride_groups to IN_PROGRESS and boarded bookings to IN_PROGRESS.
   * Idempotent on duplicate requests.
   */
  async startTrip(
    driverUserId: string,
    tripId: string,
    claim?: IdempotencyClaimContext,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
      // Verify claim ownership and lock idempotency record
      await verifyIdempotencyClaim(tx, claim);

      // Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_assignment_id: string;
          ride_group_id: string;
          started_at: Date | null;
        }>
      >`
        SELECT id, status, active_driver_id, driver_assignment_id, ride_group_id, started_at
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.active_driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'DRIVER_NOT_ASSIGNED_TO_TRIP',
          message: 'Caller is not the assigned active driver for this trip.',
        });
      }

      // Idempotent duplicate start: If trip is already IN_PROGRESS, return existing start result
      if (trip.status === 'IN_PROGRESS') {
        const startResult = {
          tripId: trip.id,
          status: trip.status,
          startedAt: trip.started_at
            ? new Date(trip.started_at).toISOString()
            : null,
        };

        const responsePayload = {
          success: true,
          message: 'Trip started successfully',
          data: startResult,
        };

        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.OK,
        );

        return startResult;
      }

      if (trip.status !== 'AT_PICKUP') {
        const passengers = await tx.tripPassenger.findMany({
          where: { tripId },
        });
        const boarded = passengers.filter((p) => p.status === 'BOARDED');
        if (boarded.length === 0 && trip.status === 'CANCELLED') {
          throw new BadRequestException({
            errorCode: 'NO_BOARDED_PASSENGERS',
            message: 'Cannot start trip with zero boarded passengers.',
          });
        }

        throw new BadRequestException({
          errorCode: 'INVALID_TRIP_STATUS_FOR_START',
          message: `Trip must be in status 'AT_PICKUP' to start (current: '${trip.status}').`,
        });
      }

      // Check active passengers
      const passengers = await tx.tripPassenger.findMany({
        where: { tripId },
      });

      const unboarded = passengers.filter((p) => p.status === 'WAITING');
      if (unboarded.length > 0) {
        throw new BadRequestException({
          errorCode: 'PASSENGERS_NOT_BOARDED',
          message: `All passengers must be boarded or declared no-show before departing (${unboarded.length} remaining).`,
        });
      }

      const boarded = passengers.filter((p) => p.status === 'BOARDED');
      if (boarded.length === 0) {
        throw new BadRequestException({
          errorCode: 'NO_BOARDED_PASSENGERS',
          message: 'Cannot start trip with zero boarded passengers.',
        });
      }

      const now = new Date();

      // Update trip status to IN_PROGRESS and persist started_at exactly once
      const updatedTrip = await tx.trip.update({
        where: { id: tripId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: now,
          currentStopOrder: 0,
        },
      });

      // Transition ride group from DRIVER_ASSIGNED to IN_PROGRESS per STATE_MACHINES.md
      await tx.rideGroup.update({
        where: { id: trip.ride_group_id },
        data: { status: 'IN_PROGRESS' },
      });

      // Update driver assignment started_at
      await tx.driverAssignment.update({
        where: { id: trip.driver_assignment_id },
        data: { startedAt: now },
      });

      // Update boarded bookings to IN_PROGRESS
      for (const p of passengers) {
        if (p.status === 'BOARDED') {
          await tx.booking.update({
            where: { id: p.bookingId },
            data: { status: 'IN_PROGRESS' },
          });

          await tx.bookingStatusHistory.create({
            data: {
              bookingId: p.bookingId,
              previousStatus: 'BOARDED',
              newStatus: 'IN_PROGRESS',
              reason: 'Vehicle departed pickup hub; trip in progress',
            },
          });
        }
      }

      await tx.tripStatusHistory.create({
        data: {
          tripId,
          previousStatus: 'AT_PICKUP',
          newStatus: 'IN_PROGRESS',
          reason: 'Vehicle departed pickup hub',
        },
      });

      await tx.outboxEvent.create({
        data: {
          eventType: 'TRIP_STARTED',
          aggregateType: 'TRIP',
          aggregateId: tripId,
          payload: {
            tripId,
            rideGroupId: trip.ride_group_id,
            driverId: driver.id,
            startedAt: now.toISOString(),
            status: 'IN_PROGRESS',
          },
        },
      });

      const startResult = {
        tripId: updatedTrip.id,
        status: updatedTrip.status,
        startedAt: now.toISOString(),
      };

      const responsePayload = {
        success: true,
        message: 'Trip started successfully',
        data: startResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return startResult;
    });
  }

  /**
   * Complete individual passenger drop-off.
   * Validates sequential drop-off according to approved stop_order from group_route_stops.
   * Advances trips.current_stop_order atomically.
   * Finalizes passenger fare and waiting charges drop-off settlement.
   * Idempotent on duplicate completion requests.
   */
  async completePassenger(
    driverUserId: string,
    tripId: string,
    passengerId: string,
    claim?: IdempotencyClaimContext,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
      // Verify claim ownership and lock idempotency record
      await verifyIdempotencyClaim(tx, claim);

      // Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_assignment_id: string;
          ride_group_id: string;
          current_stop_order: number;
        }>
      >`
        SELECT id, status, active_driver_id, driver_assignment_id, ride_group_id, current_stop_order
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.active_driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'DRIVER_NOT_ASSIGNED_TO_TRIP',
          message: 'Caller is not the assigned driver for this trip.',
        });
      }

      // Lock trip passenger row with SELECT ... FOR UPDATE
      const passengers = await tx.$queryRaw<
        Array<{
          id: string;
          trip_id: string;
          passenger_id: string;
          booking_id: string;
          status: string;
          final_ride_fare_paise: number;
          waiting_charge_paise: number;
        }>
      >`
        SELECT id, trip_id, passenger_id, booking_id, status, final_ride_fare_paise, waiting_charge_paise
        FROM trip_passengers
        WHERE trip_id = ${tripId}::uuid AND passenger_id = ${passengerId}::uuid
        FOR UPDATE;
      `;

      if (!passengers || passengers.length === 0) {
        throw new NotFoundException({
          errorCode: 'PASSENGER_NOT_ON_TRIP',
          message: 'Passenger is not on this trip.',
        });
      }

      const passenger = passengers[0];

      // Duplicate passenger completion idempotency
      if (passenger.status === 'COMPLETED') {
        if (claim) {
          throw new BadRequestException({
            errorCode: 'INVALID_PASSENGER_STATUS_FOR_COMPLETION',
            message: `Cannot complete drop-off for passenger in status '${passenger.status}'.`,
          });
        }

        const totalCashToCollectPaise =
          passenger.final_ride_fare_paise + passenger.waiting_charge_paise;

        const completionResult = {
          passengerId,
          status: 'COMPLETED',
          rideFarePaise: passenger.final_ride_fare_paise,
          rideFare: (passenger.final_ride_fare_paise / 100).toFixed(2),
          waitingChargePaise: passenger.waiting_charge_paise,
          waitingCharge: (passenger.waiting_charge_paise / 100).toFixed(2),
          totalCashToCollectPaise,
          totalCashToCollect: (totalCashToCollectPaise / 100).toFixed(2),
        };

        const responsePayload = {
          success: true,
          data: completionResult,
        };

        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.OK,
        );

        return completionResult;
      }

      if (trip.status !== 'IN_PROGRESS') {
        throw new BadRequestException({
          errorCode: 'INVALID_TRIP_STATUS_FOR_COMPLETION',
          message: `Trip must be 'IN_PROGRESS' to complete passenger drop-off (current: '${trip.status}').`,
        });
      }

      if (passenger.status !== 'BOARDED') {
        throw new BadRequestException({
          errorCode: 'INVALID_PASSENGER_STATUS_FOR_COMPLETION',
          message: `Cannot complete drop-off for passenger in status '${passenger.status}'.`,
        });
      }

      // Sequential stop-order evaluation:
      // Query all passengers on this trip and their associated route stops
      const allTripPassengers = await tx.$queryRaw<
        Array<{
          id: string;
          passenger_id: string;
          booking_id: string;
          status: string;
          stop_order: number;
        }>
      >`
        SELECT
          tp.id,
          tp.passenger_id,
          tp.booking_id,
          tp.status,
          COALESCE(grs.stop_order, gm.dropoff_sequence_order, 1)::int as stop_order
        FROM trip_passengers tp
        JOIN trips t ON t.id = tp.trip_id
        LEFT JOIN group_members gm ON gm.ride_group_id = t.ride_group_id AND gm.booking_id = tp.booking_id
        LEFT JOIN LATERAL (
          SELECT grv.id FROM group_route_versions grv
          WHERE grv.ride_group_id = t.ride_group_id
          ORDER BY grv.version_number DESC
          LIMIT 1
        ) latest_grv ON true
        LEFT JOIN group_route_stops grs ON grs.group_route_version_id = latest_grv.id AND grs.group_member_id = gm.id
        WHERE tp.trip_id = ${tripId}::uuid;
      `;

      const targetPassengerRecord = allTripPassengers.find(
        (p) => p.passenger_id === passengerId,
      );
      const targetStopOrder = targetPassengerRecord?.stop_order ?? 1;

      // Cannot drop off passenger at stop N if any passenger at earlier stop M < N is still BOARDED
      const earlierIncompletePassengers = allTripPassengers.filter(
        (p) => p.status === 'BOARDED' && p.stop_order < targetStopOrder,
      );

      if (earlierIncompletePassengers.length > 0) {
        const earlierStop = Math.min(
          ...earlierIncompletePassengers.map((p) => p.stop_order),
        );
        throw new BadRequestException({
          errorCode: 'INVALID_STOP_SEQUENCE',
          message: `Cannot drop off passenger at stop ${targetStopOrder} before completing earlier stop ${earlierStop}.`,
        });
      }

      const now = new Date();

      // Mark passenger completed
      await tx.tripPassenger.update({
        where: { id: passenger.id },
        data: {
          status: 'COMPLETED',
          droppedOffAt: now,
        },
      });

      // Advance trips.current_stop_order to targetStopOrder
      const newStopOrder = Math.max(trip.current_stop_order, targetStopOrder);
      if (newStopOrder !== trip.current_stop_order) {
        await tx.trip.update({
          where: { id: tripId },
          data: { currentStopOrder: newStopOrder },
        });
      }

      // Mark booking completed
      await tx.booking.update({
        where: { id: passenger.booking_id },
        data: {
          status: 'COMPLETED',
          finalAllocatedFarePaise: passenger.final_ride_fare_paise,
        },
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: passenger.booking_id,
          previousStatus: 'IN_PROGRESS',
          newStatus: 'COMPLETED',
          reason: 'Passenger arrived and dropped off at destination',
        },
      });

      // Increment completed rides count
      await tx.passengerProfile.updateMany({
        where: { userId: passengerId },
        data: {
          totalRidesCompleted: { increment: 1 },
        },
      });

      // Total cash to collect for Stage 7 covers allocated ride fare and waiting charges
      // (Stage 8 handles cash confirmation and cancellation-fee surcharge settlement)
      const totalCashToCollectPaise =
        passenger.final_ride_fare_paise + passenger.waiting_charge_paise;

      await tx.outboxEvent.create({
        data: {
          eventType: 'PASSENGER_DROPPED_OFF',
          aggregateType: 'TRIP_PASSENGER',
          aggregateId: passenger.id,
          payload: {
            tripId,
            passengerId,
            bookingId: passenger.booking_id,
            stopOrder: targetStopOrder,
            rideFarePaise: passenger.final_ride_fare_paise,
            waitingChargePaise: passenger.waiting_charge_paise,
            totalCashToCollectPaise,
          },
        },
      });

      const completionResult = {
        passengerId,
        status: 'COMPLETED',
        rideFarePaise: passenger.final_ride_fare_paise,
        rideFare: (passenger.final_ride_fare_paise / 100).toFixed(2),
        waitingChargePaise: passenger.waiting_charge_paise,
        waitingCharge: (passenger.waiting_charge_paise / 100).toFixed(2),
        totalCashToCollectPaise,
        totalCashToCollect: (totalCashToCollectPaise / 100).toFixed(2),
      };

      const responsePayload = {
        success: true,
        data: completionResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return completionResult;
    });
  }

  /**
   * Driver declares passenger no-show after 10 minutes from driver arrival.
   * Assesses flat ₹30 no-show fee into cancellation_fees ledger. Zero waiting charge.
   * Idempotent on duplicate requests.
   */
  async declareNoShow(
    driverUserId: string,
    tripId: string,
    passengerId: string,
    claim?: IdempotencyClaimContext,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    const result = await this.prisma.$transaction(async (tx) => {
      // Verify claim ownership and lock idempotency record
      await verifyIdempotencyClaim(tx, claim);

      // Standard lock order across the monolith: trips -> bookings -> trip_passengers
      // 1. Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_arrived_at: Date | null;
        }>
      >`
        SELECT id, status, active_driver_id, driver_arrived_at
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.active_driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'DRIVER_NOT_ASSIGNED_TO_TRIP',
          message: 'Caller is not the assigned driver for this trip.',
        });
      }

      // 2. Lock bookings row associated with passenger journey
      const bookings = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >`
        SELECT id, status
        FROM bookings
        WHERE id = (
          SELECT booking_id
          FROM trip_passengers
          WHERE trip_id = ${tripId}::uuid AND passenger_id = ${passengerId}::uuid
          LIMIT 1
        )
        FOR UPDATE;
      `;

      if (!bookings || bookings.length === 0) {
        throw new NotFoundException({
          errorCode: 'BOOKING_NOT_FOUND',
          message: 'Booking not found for this passenger.',
        });
      }

      const booking = bookings[0];

      if (booking.status === 'CANCELLED') {
        throw new BadRequestException({
          errorCode: 'INVALID_PASSENGER_STATUS_FOR_NO_SHOW',
          message:
            "Cannot declare no-show for passenger in status 'CANCELLED'.",
        });
      }

      // 3. Lock trip passenger row with SELECT ... FOR UPDATE
      const passengers = await tx.$queryRaw<
        Array<{
          id: string;
          trip_id: string;
          passenger_id: string;
          booking_id: string;
          status: string;
        }>
      >`
        SELECT id, trip_id, passenger_id, booking_id, status
        FROM trip_passengers
        WHERE trip_id = ${tripId}::uuid AND passenger_id = ${passengerId}::uuid
        FOR UPDATE;
      `;

      if (!passengers || passengers.length === 0) {
        throw new NotFoundException({
          errorCode: 'PASSENGER_NOT_ON_TRIP',
          message: 'Passenger is not on this trip.',
        });
      }

      const passenger = passengers[0];

      if (passenger.status === 'CANCELLED') {
        throw new BadRequestException({
          errorCode: 'INVALID_PASSENGER_STATUS_FOR_NO_SHOW',
          message:
            "Cannot declare no-show for passenger in status 'CANCELLED'.",
        });
      }

      // Idempotency check: if passenger is already NO_SHOW, return existing result
      if (passenger.status === 'NO_SHOW') {
        const noShowResult = {
          passengerId,
          status: 'NO_SHOW',
          penaltyAssessedPaise: 3000,
          penaltyAssessed: '30.00',
        };

        const responsePayload = {
          success: true,
          message: 'Passenger declared no-show',
          data: noShowResult,
        };

        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.OK,
        );

        return {
          noShowResult,
          routeReconciliationInfo: null,
        };
      }

      if (!trip.driver_arrived_at) {
        throw new BadRequestException({
          errorCode: 'DRIVER_NOT_AT_PICKUP',
          message: 'Driver arrival has not been recorded for this trip.',
        });
      }

      // Check 10-minute threshold (600 seconds)
      const now = new Date();
      const arrivalTime = new Date(trip.driver_arrived_at).getTime();
      const elapsedSeconds = (now.getTime() - arrivalTime) / 1000;

      if (elapsedSeconds < 600) {
        throw new BadRequestException({
          errorCode: 'NO_SHOW_THRESHOLD_NOT_MET',
          message: `No-show cannot be declared until 10 minutes have elapsed since arrival (${Math.floor(elapsedSeconds)}s elapsed).`,
        });
      }

      if (passenger.status !== 'WAITING') {
        throw new BadRequestException({
          errorCode: 'INVALID_PASSENGER_STATUS_FOR_NO_SHOW',
          message: `Cannot declare no-show for passenger in status '${passenger.status}'.`,
        });
      }

      // Update passenger journey status to NO_SHOW with ₹0 waiting charge
      await tx.tripPassenger.update({
        where: { id: passenger.id },
        data: {
          status: 'NO_SHOW',
          waitingChargePaise: 0,
        },
      });

      // Update booking status
      await tx.booking.update({
        where: { id: passenger.booking_id },
        data: {
          status: 'NO_SHOW',
        },
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: passenger.booking_id,
          previousStatus: 'DRIVER_ARRIVED',
          newStatus: 'NO_SHOW',
          reason: 'Commuter failed to board within 10-minute grace window',
        },
      });

      // Insert flat ₹30 no-show fee into cancellation_fees ledger as OUTSTANDING
      // Guarded by unique index idx_unique_cancellation_fee_per_booking
      const existingFee = await tx.cancellationFee.findUnique({
        where: { originalBookingId: passenger.booking_id },
      });

      if (!existingFee) {
        await tx.cancellationFee.create({
          data: {
            passengerId,
            originalBookingId: passenger.booking_id,
            amountPaise: 3000,
            status: 'OUTSTANDING',
          },
        });
      }

      // Deactivate active membership in group_members
      await tx.groupMember.updateMany({
        where: {
          bookingId: passenger.booking_id,
          isActiveMember: true,
        },
        data: {
          isActiveMember: false,
        },
      });

      // Check all passengers on this trip
      const allTripPassengers = await tx.tripPassenger.findMany({
        where: { tripId },
      });

      const nonTerminalPassengers = allTripPassengers.filter(
        (p) =>
          !['NO_SHOW', 'CANCELLED'].includes(p.status) &&
          p.id !== passenger.id,
      );
      const boardedPassengers = allTripPassengers.filter(
        (p) => p.status === 'BOARDED',
      );

      let routeReconciliationInfo: {
        rideGroupId: string;
        expectedGroupVersion: number;
        pickupPoint: { lat: number; lng: number };
        destinations: Array<{
          groupMemberId: string;
          bookingId: string;
          lat: number;
          lng: number;
        }>;
      } | null = null;

      // Handle the case where every passenger becomes NO_SHOW or CANCELLED (0 boarded)
      if (
        nonTerminalPassengers.length === 0 &&
        boardedPassengers.length === 0
      ) {
        // Vehicle trip cancelled at pickup per state machine
        await tx.trip.update({
          where: { id: tripId },
          data: { status: 'CANCELLED' },
        });

        await tx.tripStatusHistory.create({
          data: {
            tripId,
            previousStatus: trip.status,
            newStatus: 'CANCELLED',
            reason:
              'All passengers declared no-show or cancelled; trip cancelled at pickup',
          },
        });

        const tripRecord = await tx.trip.findUnique({
          where: { id: tripId },
          select: { rideGroupId: true, driverAssignmentId: true },
        });

        if (tripRecord) {
          await tx.rideGroup.update({
            where: { id: tripRecord.rideGroupId },
            data: { status: 'DISSOLVED' },
          });

          await tx.driverAssignment.update({
            where: { id: tripRecord.driverAssignmentId },
            data: { status: 'RELEASED' },
          });
        }

        // Release driver operational status back to AVAILABLE
        await tx.driverProfile.update({
          where: { id: trip.active_driver_id },
          data: { operationalStatus: 'AVAILABLE' },
        });

        await tx.outboxEvent.create({
          data: {
            eventType: 'TRIP_CANCELLED',
            aggregateType: 'TRIP',
            aggregateId: tripId,
            payload: {
              tripId,
              rideGroupId: tripRecord?.rideGroupId,
              driverId: trip.active_driver_id,
              reason: 'ALL_PASSENGERS_NO_SHOW',
            },
          },
        });

        await tx.outboxEvent.create({
          data: {
            eventType: 'DRIVER_ASSIGNMENT_RELEASED',
            aggregateType: 'DRIVER_ASSIGNMENT',
            aggregateId: tripRecord?.driverAssignmentId ?? tripId,
            payload: {
              driverId: trip.active_driver_id,
              rideGroupId: tripRecord?.rideGroupId,
              operationalStatus: 'AVAILABLE',
            },
          },
        });
      } else {
        // Other passengers remain (some are BOARDED or WAITING)
        const tripRecord = await tx.trip.findUnique({
          where: { id: tripId },
          select: { rideGroupId: true },
        });

        if (tripRecord) {
          const activeMembers = await tx.groupMember.findMany({
            where: {
              rideGroupId: tripRecord.rideGroupId,
              isActiveMember: true,
            },
            orderBy: { dropoffSequenceOrder: 'asc' },
          });

          if (activeMembers.length >= 1) {
            const updatedGroup = await tx.rideGroup.update({
              where: { id: tripRecord.rideGroupId },
              data: { groupVersion: { increment: 1 } },
              select: { id: true, groupVersion: true, pickupPointId: true },
            });

            const [pickupPoint] = await tx.$queryRaw<
              Array<{ lat: number; lng: number }>
            >`
              SELECT ST_Y(center_point::geometry) as lat, ST_X(center_point::geometry) as lng
              FROM pickup_points
              WHERE id = ${updatedGroup.pickupPointId}::uuid;
            `;

            const memberDestinations: Array<{
              groupMemberId: string;
              bookingId: string;
              lat: number;
              lng: number;
            }> = [];

            for (const m of activeMembers) {
              const [dest] = await tx.$queryRaw<
                Array<{ lat: number; lng: number }>
              >`
                SELECT ST_Y(destination_location::geometry) as lat, ST_X(destination_location::geometry) as lng
                FROM bookings
                WHERE id = ${m.bookingId}::uuid;
              `;
              if (dest) {
                memberDestinations.push({
                  groupMemberId: m.id,
                  bookingId: m.bookingId,
                  lat: Number(dest.lat),
                  lng: Number(dest.lng),
                });
              }
            }

            if (pickupPoint && memberDestinations.length >= 1) {
              routeReconciliationInfo = {
                rideGroupId: updatedGroup.id,
                expectedGroupVersion: updatedGroup.groupVersion,
                pickupPoint: {
                  lat: Number(pickupPoint.lat),
                  lng: Number(pickupPoint.lng),
                },
                destinations: memberDestinations,
              };
            }
          }
        }
      }

      // Outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'PASSENGER_NO_SHOW',
          aggregateType: 'TRIP_PASSENGER',
          aggregateId: passenger.id,
          payload: {
            tripId,
            passengerId,
            penaltyAssessedPaise: 3000,
            elapsedSeconds,
          },
        },
      });

      const noShowResult = {
        passengerId,
        status: 'NO_SHOW',
        penaltyAssessedPaise: 3000,
        penaltyAssessed: '30.00',
      };

      const responsePayload = {
        success: true,
        message: 'Passenger declared no-show',
        data: noShowResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return {
        noShowResult,
        routeReconciliationInfo,
      };
    });

    if (result.routeReconciliationInfo && this.routingService) {
      await this.recalculateAndPersistRoute(result.routeReconciliationInfo).catch(
        (err) => {
          this.logger.warn(
            `Route recalculation failed after no-show declaration for group ${result.routeReconciliationInfo?.rideGroupId}: ${(err as Error).message}`,
          );
        },
      );
    }

    return result.noShowResult;
  }

  /**
   * Finalize vehicle trip after all drop-offs or no-shows are resolved.
   * Releases driver operational status back to AVAILABLE via atomic conditional update.
   * Idempotent on duplicate completion requests.
   */
  async completeTrip(
    driverUserId: string,
    tripId: string,
    claim?: IdempotencyClaimContext,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
      // Verify claim ownership and lock idempotency record
      await verifyIdempotencyClaim(tx, claim);

      // Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_assignment_id: string;
          ride_group_id: string;
          completed_at: Date | null;
        }>
      >`
        SELECT id, status, active_driver_id, driver_assignment_id, ride_group_id, completed_at
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.active_driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'DRIVER_NOT_ASSIGNED_TO_TRIP',
          message: 'Caller is not the assigned driver for this trip.',
        });
      }

      // Idempotent duplicate trip completion:
      // If trip is already COMPLETED, return the existing result without resetting completed_at or duplicate side effects
      if (trip.status === 'COMPLETED') {
        const tripResult = {
          tripId: trip.id,
          status: trip.status,
          completedAt: trip.completed_at
            ? new Date(trip.completed_at).toISOString()
            : null,
        };

        const responsePayload = {
          success: true,
          message: 'Trip completed successfully',
          data: tripResult,
        };

        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.OK,
        );

        return tripResult;
      }

      if (trip.status !== 'IN_PROGRESS') {
        throw new BadRequestException({
          errorCode: 'INVALID_TRIP_STATUS_FOR_COMPLETION',
          message: `Trip must be 'IN_PROGRESS' to complete (current: '${trip.status}').`,
        });
      }

      // Lock driver profile row with SELECT ... FOR UPDATE
      await tx.$queryRaw`
        SELECT id FROM driver_profiles WHERE id = ${driver.id}::uuid FOR UPDATE;
      `;

      // Verify all passengers are finalized (COMPLETED, NO_SHOW, or CANCELLED)
      const passengers = await tx.tripPassenger.findMany({
        where: { tripId },
      });

      const unfinalized = passengers.filter(
        (p) => !['COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(p.status),
      );

      if (unfinalized.length > 0) {
        throw new BadRequestException({
          errorCode: 'UNFINALIZED_PASSENGERS',
          message: `All passengers must be dropped off or declared no-show before completing trip (${unfinalized.length} remaining).`,
        });
      }

      const now = new Date();

      // Update trip to COMPLETED and set completed_at exactly once
      const updatedTrip = await tx.trip.update({
        where: { id: tripId },
        data: {
          status: 'COMPLETED',
          completedAt: now,
        },
      });

      // Update driver assignment to COMPLETED
      await tx.driverAssignment.update({
        where: { id: trip.driver_assignment_id },
        data: {
          status: 'COMPLETED',
          completedAt: now,
        },
      });

      // Update ride group to COMPLETED
      await tx.rideGroup.update({
        where: { id: trip.ride_group_id },
        data: { status: 'COMPLETED' },
      });

      // Atomic conditional update to release driver operational_status back to AVAILABLE
      // checking that the driver has no other active or reserved assignment
      const otherActiveAssignments = await tx.driverAssignment.count({
        where: {
          driverId: driver.id,
          id: { not: trip.driver_assignment_id },
          status: { in: ['RESERVED', 'ACTIVE'] },
        },
      });

      if (otherActiveAssignments === 0) {
        await tx.driverProfile.updateMany({
          where: {
            id: driver.id,
            operationalStatus: { not: 'SUSPENDED' },
          },
          data: {
            operationalStatus: 'AVAILABLE',
          },
        });
      }

      await tx.tripStatusHistory.create({
        data: {
          tripId,
          previousStatus: 'IN_PROGRESS',
          newStatus: 'COMPLETED',
          reason: 'All passenger drop-offs completed; trip finalized',
        },
      });

      await tx.outboxEvent.create({
        data: {
          eventType: 'TRIP_COMPLETED',
          aggregateType: 'TRIP',
          aggregateId: tripId,
          payload: {
            tripId,
            rideGroupId: trip.ride_group_id,
            driverId: driver.id,
            completedAt: now.toISOString(),
            status: 'COMPLETED',
          },
        },
      });

      const tripResult = {
        tripId: updatedTrip.id,
        status: updatedTrip.status,
        completedAt: now.toISOString(),
      };

      const responsePayload = {
        success: true,
        message: 'Trip completed successfully',
        data: tripResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return tripResult;
    });
  }

  /**
   * Get trip details with passengers and manifest
   */
  async getTrip(
    user: { id: string; role: string },
    tripId: string,
  ): Promise<TripDetailResponse> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        passengers: true,
      },
    });

    if (!trip) {
      throw new NotFoundException({
        errorCode: 'TRIP_NOT_FOUND',
        message: `Trip with ID ${tripId} not found.`,
      });
    }

    // Access control
    if (user.role === 'DRIVER') {
      const driver = await this.prisma.driverProfile.findUnique({
        where: { userId: user.id },
      });
      if (!driver || driver.id !== trip.activeDriverId) {
        throw new ForbiddenException({
          errorCode: 'FORBIDDEN',
          message: 'Drivers can only access their assigned trips.',
        });
      }
    } else if (user.role === 'PASSENGER') {
      const isOnTrip = trip.passengers.some((p) => p.passengerId === user.id);
      if (!isOnTrip) {
        throw new ForbiddenException({
          errorCode: 'FORBIDDEN',
          message: 'Passengers can only access trips they are part of.',
        });
      }
    }

    return {
      tripId: trip.id,
      rideGroupId: trip.rideGroupId,
      activeDriverId: trip.activeDriverId,
      status: trip.status,
      driverArrivedAt: trip.driverArrivedAt
        ? trip.driverArrivedAt.toISOString()
        : null,
      startedAt: trip.startedAt ? trip.startedAt.toISOString() : null,
      completedAt: trip.completedAt ? trip.completedAt.toISOString() : null,
      passengers: trip.passengers.map((p) => ({
        id: p.id,
        passengerId: p.passengerId,
        bookingId: p.bookingId,
        status: p.status,
        finalRideFarePaise: p.finalRideFarePaise,
        waitingChargePaise: p.waitingChargePaise,
        boardedAt: p.boardedAt ? p.boardedAt.toISOString() : null,
        droppedOffAt: p.droppedOffAt ? p.droppedOffAt.toISOString() : null,
      })),
    };
  }

  /**
   * @internal Internal orchestration and testing helper: materializes a trip from a ride group,
   * driver assignment, and passenger bookings with 4-digit hashed OTPs.
   * This method is NOT exposed via any public HTTP controller endpoint.
   */
  async createTripManifest(data: {
    driverId: string;
    rideGroupId: string;
    passengers: Array<{
      bookingId: string;
      passengerId: string;
      farePaise: number;
      otp: string;
    }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Create dispatch attempt & driver assignment
      const dispatchAttempt = await tx.dispatchAttempt.create({
        data: {
          rideGroupId: data.rideGroupId,
          groupVersion: 1,
          status: 'ACTIVE',
        },
      });

      const driverAssignment = await tx.driverAssignment.create({
        data: {
          dispatchAttemptId: dispatchAttempt.id,
          rideGroupId: data.rideGroupId,
          driverId: data.driverId,
          status: 'RESERVED',
        },
      });

      // 2. Create vehicle trip
      const trip = await tx.trip.create({
        data: {
          rideGroupId: data.rideGroupId,
          driverAssignmentId: driverAssignment.id,
          activeDriverId: data.driverId,
          status: 'CREATED',
        },
      });

      // 3. Create trip passengers and hashed OTP verifications
      for (const p of data.passengers) {
        const tripPassenger = await tx.tripPassenger.create({
          data: {
            tripId: trip.id,
            bookingId: p.bookingId,
            passengerId: p.passengerId,
            status: 'WAITING',
            finalRideFarePaise: p.farePaise,
            waitingChargePaise: 0,
          },
        });

        const otpHash = crypto
          .createHash('sha256')
          .update(p.otp)
          .digest('hex');

        await tx.boardingVerification.create({
          data: {
            tripPassengerId: tripPassenger.id,
            otpHash,
            maxAttempts: 3,
            attemptsCount: 0,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          },
        });

        await tx.booking.update({
          where: { id: p.bookingId },
          data: { status: 'DRIVER_ASSIGNED' },
        });

        await tx.bookingStatusHistory.create({
          data: {
            bookingId: p.bookingId,
            previousStatus: 'MATCHED',
            newStatus: 'DRIVER_ASSIGNED',
            reason: 'Driver accepted dispatch offer; driver assigned',
          },
        });
      }

      return trip;
    });
  }

  /**
   * Recalculates route using OSRM for surviving passengers after a passenger no-show.
   * Runs strictly outside open database transactions, applies groupVersion fencing check,
   * and persists new GroupRouteVersion and GroupRouteStop records.
   */
  private async recalculateAndPersistRoute(info: {
    rideGroupId: string;
    expectedGroupVersion: number;
    pickupPoint: { lat: number; lng: number };
    destinations: Array<{
      groupMemberId: string;
      bookingId: string;
      lat: number;
      lng: number;
    }>;
  }): Promise<void> {
    if (!this.routingService) return;

    try {
      const waypoints = [
        { latitude: info.pickupPoint.lat, longitude: info.pickupPoint.lng },
        ...info.destinations.map((d) => ({
          latitude: d.lat,
          longitude: d.lng,
        })),
      ];

      const routeResult = await this.routingService.getMultiStopRoute(waypoints);
      if (routeResult.distanceMeters <= 0) return;

      await this.prisma.$transaction(async (tx) => {
        const groups = await tx.$queryRaw<
          Array<{ id: string; group_version: number; status: string }>
        >`
          SELECT id, group_version, status
          FROM ride_groups
          WHERE id = ${info.rideGroupId}::uuid
          FOR UPDATE;
        `;

        if (!groups || groups.length === 0) return;
        const group = groups[0];

        // Fencing check: discard stale route calculation if group version has changed
        // or if group has moved to a terminal state
        if (
          group.group_version !== info.expectedGroupVersion ||
          ['DISSOLVED', 'CANCELLED', 'COMPLETED'].includes(group.status)
        ) {
          return;
        }

        const routeGeometry = routeResult.geometry ?? {};
        const newRouteVersion = await tx.groupRouteVersion.create({
          data: {
            rideGroupId: info.rideGroupId,
            versionNumber: info.expectedGroupVersion,
            routeGeometry: routeGeometry as any,
            totalDistanceMeters: routeResult.distanceMeters,
            totalDurationSec: routeResult.durationSec,
          },
        });

        for (let i = 0; i < info.destinations.length; i++) {
          const dest = info.destinations[i];
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
              ${newRouteVersion.id}::uuid,
              ${dest.groupMemberId}::uuid,
              ${i + 1},
              (SELECT destination_location FROM bookings WHERE id = ${dest.bookingId}::uuid),
              'DROPOFF'
            );
          `;
        }

        await tx.outboxEvent.create({
          data: {
            eventType: 'GROUP_ROUTE_UPDATED',
            aggregateType: 'RIDE_GROUP',
            aggregateId: info.rideGroupId,
            payload: {
              rideGroupId: info.rideGroupId,
              groupVersion: info.expectedGroupVersion,
              totalDistanceMeters: routeResult.distanceMeters,
              totalDurationSec: routeResult.durationSec,
            },
          },
        });
      });
    } catch (err) {
      this.logger.warn(
        `Failed to recalculate and persist route for group ${info.rideGroupId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Report mid-trip vehicle breakdown (POST /api/v1/trips/:id/report-breakdown).
   * - Validates active driver calling.
   * - Transitions trip to INTERRUPTED.
   * - Captures immutable snapshot of BOARDED passengers and remaining drop-off details.
   * - Persists TripIncident record.
   * - Finds and ranks eligible replacement drivers by OSRM ETA.
   * - If 0 replacement drivers available, automatically aborts trip with ₹0 fare and refund audit.
   */
  async reportBreakdown(
    driverUserId: string,
    tripId: string,
    dto: ReportBreakdownDto,
    claim?: IdempotencyClaimContext,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    let incidentLat: number;
    let incidentLng: number;

    if (
      dto.incidentLocation &&
      typeof dto.incidentLocation.latitude === 'number' &&
      typeof dto.incidentLocation.longitude === 'number' &&
      !Number.isNaN(dto.incidentLocation.latitude) &&
      !Number.isNaN(dto.incidentLocation.longitude) &&
      dto.incidentLocation.latitude >= -90 &&
      dto.incidentLocation.latitude <= 90 &&
      dto.incidentLocation.longitude >= -180 &&
      dto.incidentLocation.longitude <= 180
    ) {
      incidentLat = dto.incidentLocation.latitude;
      incidentLng = dto.incidentLocation.longitude;
    } else {
      let gpsFix: {
        latitude: number;
        longitude: number;
        updatedAt?: string;
      } | null = null;

      if (this.redisService) {
        try {
          const client = this.redisService.getClient();
          const raw = await client.get(
            `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driver.id}`,
          );
          if (raw) gpsFix = JSON.parse(raw);
        } catch (err: any) {
          this.logger.warn(
            `Failed to read driver GPS fix from Redis for breakdown: ${err?.message}`,
          );
        }
      }

      if (
        gpsFix &&
        typeof gpsFix.latitude === 'number' &&
        typeof gpsFix.longitude === 'number' &&
        !Number.isNaN(gpsFix.latitude) &&
        !Number.isNaN(gpsFix.longitude) &&
        gpsFix.latitude >= -90 &&
        gpsFix.latitude <= 90 &&
        gpsFix.longitude >= -180 &&
        gpsFix.longitude <= 180
      ) {
        // Enforce GPS freshness (<= 30s TTL)
        if (gpsFix.updatedAt) {
          const ageMs = Date.now() - new Date(gpsFix.updatedAt).getTime();
          if (ageMs > 30000) {
            throw new BadRequestException({
              errorCode: 'INCIDENT_LOCATION_UNAVAILABLE',
              message:
                'Driver GPS telemetry in Redis is stale (> 30s). Valid incident location required.',
            });
          }
        }
        incidentLat = gpsFix.latitude;
        incidentLng = gpsFix.longitude;
      } else {
        throw new BadRequestException({
          errorCode: 'INCIDENT_LOCATION_UNAVAILABLE',
          message:
            'Incident location could not be determined. Request payload missing coordinates and driver GPS telemetry is unavailable.',
        });
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await verifyIdempotencyClaim(tx, claim);

      // Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          ride_group_id: string;
        }>
      >`
        SELECT id, status, active_driver_id, ride_group_id
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.active_driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'DRIVER_NOT_ASSIGNED_TO_TRIP',
          message: 'Caller is not the assigned driver for this trip.',
        });
      }

      // Idempotency: if trip is already INTERRUPTED, return existing incident
      if (trip.status === 'INTERRUPTED') {
        const existingIncident = await tx.tripIncident.findFirst({
          where: { tripId, status: 'REPORTED' },
          orderBy: { reportedAt: 'desc' },
        });

        if (existingIncident) {
          const breakdownResult = {
            incidentId: existingIncident.id,
            tripId: trip.id,
            status: 'INTERRUPTED',
            incidentLocation: { latitude: incidentLat, longitude: incidentLng },
            onboardManifestSnapshot: existingIncident.onboardManifestSnapshot,
            message: 'Trip is already interrupted',
          };
          const responsePayload = {
            success: true,
            data: breakdownResult,
          };
          await fenceAndCompleteIdempotentTransaction(
            tx,
            claim,
            responsePayload,
            HttpStatus.OK,
          );
          return {
            breakdownResult,
            boardedCount:
              (existingIncident.onboardManifestSnapshot as any)
                ?.boardedPassengerCount ?? 0,
            alreadyInterrupted: true,
          };
        }
      }

      if (trip.status !== 'IN_PROGRESS') {
        throw new BadRequestException({
          errorCode: 'INVALID_TRIP_STATUS_FOR_BREAKDOWN',
          message: `Cannot report breakdown on trip in status '${trip.status}'. Trip must be 'IN_PROGRESS'.`,
        });
      }

      // Query currently BOARDED passengers
      const onboardPassengerRows = await tx.$queryRaw<
        Array<{
          trip_passenger_id: string;
          booking_id: string;
          passenger_id: string;
          status: string;
          final_ride_fare_paise: number;
          dest_lat: number;
          dest_lng: number;
          sequence_order: number | null;
        }>
      >`
        SELECT tp.id AS trip_passenger_id, tp.booking_id, tp.passenger_id, tp.status,
               tp.final_ride_fare_paise,
               ST_Y(b.destination_location::geometry) AS dest_lat,
               ST_X(b.destination_location::geometry) AS dest_lng,
               gm.dropoff_sequence_order AS sequence_order
        FROM trip_passengers tp
        JOIN bookings b ON b.id = tp.booking_id
        LEFT JOIN group_members gm ON gm.booking_id = tp.booking_id AND gm.is_active_member = true
        WHERE tp.trip_id = ${tripId}::uuid AND tp.status = 'BOARDED'
        FOR UPDATE OF tp;
      `;

      if (!onboardPassengerRows || onboardPassengerRows.length === 0) {
        throw new BadRequestException({
          errorCode: 'NO_BOARDED_PASSENGERS',
          message:
            'Cannot report vehicle breakdown on a trip with zero onboard passengers.',
        });
      }

      const now = new Date();
      const manifestSnapshot = {
        incidentReportedAt: now.toISOString(),
        boardedPassengerCount: onboardPassengerRows.length,
        passengers: onboardPassengerRows.map((p) => ({
          tripPassengerId: p.trip_passenger_id,
          bookingId: p.booking_id,
          passengerId: p.passenger_id,
          status: p.status,
          allocatedFarePaise: Number(p.final_ride_fare_paise),
          destinationLocation: {
            latitude: Number(p.dest_lat),
            longitude: Number(p.dest_lng),
          },
          dropoffSequenceOrder: p.sequence_order ? Number(p.sequence_order) : 1,
        })),
      };

      // 1. Transition trip to INTERRUPTED
      await tx.trip.update({
        where: { id: tripId },
        data: { status: 'INTERRUPTED' },
      });

      // 2. Status history
      await tx.tripStatusHistory.create({
        data: {
          tripId,
          previousStatus: 'IN_PROGRESS',
          newStatus: 'INTERRUPTED',
          reason: dto.reason || 'Vehicle mechanical breakdown reported',
        },
      });

      // 3. Insert immutable TripIncident snapshot
      const [incident] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO trip_incidents (
          id, trip_id, original_driver_id, incident_type,
          incident_location, onboard_manifest_snapshot, status, reported_at
        ) VALUES (
          gen_random_uuid(), ${tripId}::uuid, ${driver.id}::uuid,
          ${dto.incidentType || 'MECHANICAL_BREAKDOWN'},
          ST_SetSRID(ST_MakePoint(${incidentLng}, ${incidentLat}), 4326),
          ${JSON.stringify(manifestSnapshot)}::jsonb,
          'REPORTED',
          ${now}
        ) RETURNING id;
      `;

      // 4. Outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'TRIP_INTERRUPTED',
          aggregateType: 'TRIP',
          aggregateId: tripId,
          payload: {
            tripId,
            incidentId: incident.id,
            originalDriverId: driver.id,
            boardedPassengerCount: onboardPassengerRows.length,
            incidentLocation: { latitude: incidentLat, longitude: incidentLng },
            reason: dto.reason,
          },
        },
      });

      const breakdownResult = {
        incidentId: incident.id,
        tripId,
        status: 'INTERRUPTED',
        incidentLocation: { latitude: incidentLat, longitude: incidentLng },
        onboardManifestSnapshot: manifestSnapshot,
      };

      const responsePayload = {
        success: true,
        message: 'Vehicle breakdown reported; trip transitioned to INTERRUPTED',
        data: breakdownResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return {
        breakdownResult,
        boardedCount: onboardPassengerRows.length,
        alreadyInterrupted: false,
      };
    });

    if (result.alreadyInterrupted) {
      return result.breakdownResult;
    }

    // 5. Outside transaction: Search & rank eligible replacement drivers with failure recovery
    try {
      let rankedCandidates: Array<{
        driverId: string;
        driverName: string;
        vehicleCapacity: number;
        location: { latitude: number; longitude: number };
        etaSeconds: number;
        distanceMeters: number;
      }> = [];

      try {
        rankedCandidates = await this.findEligibleReplacementDrivers(
          tripId,
          { latitude: incidentLat, longitude: incidentLng },
          result.boardedCount,
          driver.id,
        );
      } catch (err: any) {
        this.logger.error(
          `OSRM road ETA ranking failed after retries for trip ${tripId}: ${err?.message}. Following documented abort behavior.`,
        );
        await this.abortInterruptedTrip(
          tripId,
          'OSRM_SERVICE_UNAVAILABLE_AFTER_RETRIES',
        );
        return {
          ...result.breakdownResult,
          status: 'ABORTED',
          replacementCandidates: [],
          reason: 'OSRM_SERVICE_UNAVAILABLE_AFTER_RETRIES',
        };
      }

      if (rankedCandidates.length > 0) {
        // Initiate sequential 1-to-1 dispatch to Candidate #1 with 20s timeout
        const offer = await this.dispatchSingleReplacementOffer(
          tripId,
          result.breakdownResult.incidentId,
          rankedCandidates[0],
          1,
        );

        return {
          ...result.breakdownResult,
          replacementCandidates: rankedCandidates,
          activeOffer: offer,
        };
      } else {
        // 0 candidates found: Fail closed / immediately abort per ADR-024
        this.logger.warn(
          `No eligible replacement drivers found for interrupted trip ${tripId}. Aborting trip.`,
        );
        await this.abortInterruptedTrip(
          tripId,
          'NO_REPLACEMENT_DRIVERS_AVAILABLE',
        );
        return {
          ...result.breakdownResult,
          status: 'ABORTED',
          replacementCandidates: [],
        };
      }
    } catch (dispatchErr: any) {
      this.logger.error(
        `Critical failure during initial replacement dispatch for trip ${tripId}: ${dispatchErr?.message}. Recovering via documented abort.`,
      );
      await this.abortInterruptedTrip(
        tripId,
        `DISPATCH_INITIALIZATION_FAILED: ${dispatchErr?.message || 'UNKNOWN'}`,
      ).catch((abortErr: any) => {
        this.logger.error(`Secondary failure while aborting after dispatch error: ${abortErr?.message}`);
      });

      return {
        ...result.breakdownResult,
        status: 'ABORTED',
        replacementCandidates: [],
        reason: 'DISPATCH_INITIALIZATION_FAILED',
      };
    }
  }

  /**
   * Helper to fetch road route strictly via OSRM with documented retries.
   * If OSRM remains unavailable after retries, returns null (no straight-line / geodesic fallback).
   * Edge Case 4: 5s retry backoff, max 3 retries.
   */
  async calculateRoadEtaWithRetries(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    maxRetries = 3,
  ): Promise<{ durationSec: number; distanceMeters: number } | null> {
    if (!this.routingService) {
      return null;
    }

    const isTestOrDemo =
      process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
    const retryDelayMs = isTestOrDemo ? 10 : 5000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        this.logger.warn(
          `OSRM road ETA retry attempt ${attempt}/${maxRetries} after backoff (${retryDelayMs}ms)...`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }

      try {
        const route = await this.routingService.getRoute(origin, destination);
        // Strictly road network: reject fallback or non-OSRM source
        if (route && !route.isFallback && route.source === 'OSRM') {
          return {
            durationSec: route.durationSec,
            distanceMeters: route.distanceMeters,
          };
        }
        this.logger.warn(
          `OSRM route attempt ${attempt + 1}/${maxRetries + 1} returned non-OSRM or fallback (source=${route?.source}, isFallback=${route?.isFallback})`,
        );
      } catch (err: any) {
        this.logger.warn(
          `OSRM route attempt ${attempt + 1}/${maxRetries + 1} threw error: ${err?.message}`,
        );
      }
    }

    return null;
  }

  /**
   * Search and rank eligible replacement drivers strictly by OSRM road ETA.
   * Straight-line Euclidean/geodesic fallback is strictly rejected.
   * If OSRM is down after retries, throws ServiceUnavailableException to trigger abort.
   */
  async findEligibleReplacementDrivers(
    _tripId: string,
    incidentLocation: { latitude: number; longitude: number },
    minCapacity: number,
    excludeDriverIds?: string | string[],
  ): Promise<
    Array<{
      driverId: string;
      driverName: string;
      vehicleCapacity: number;
      location: { latitude: number; longitude: number };
      etaSeconds: number;
      distanceMeters: number;
    }>
  > {
    const excludeList = Array.isArray(excludeDriverIds)
      ? excludeDriverIds
      : excludeDriverIds
        ? [excludeDriverIds]
        : [];

    const candidates = await this.prisma.driverProfile.findMany({
      where: {
        verificationStatus: 'APPROVED',
        isOnline: true,
        operationalStatus: 'AVAILABLE',
        ...(excludeList.length > 0 ? { id: { notIn: excludeList } } : {}),
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
        replacementAssignments: {
          none: {
            status: 'ASSIGNED',
          },
        },
      },
      include: {
        user: { select: { fullName: true } },
        vehicles: {
          where: { isActive: true },
          select: { passengerCapacity: true },
        },
      },
    });

    if (candidates.length === 0) return [];

    const ranked: Array<{
      driverId: string;
      driverName: string;
      vehicleCapacity: number;
      location: { latitude: number; longitude: number };
      etaSeconds: number;
      distanceMeters: number;
    }> = [];

    for (const cand of candidates) {
      if (!this.redisService) {
        this.logger.debug(
          `Skipping candidate ${cand.id}: Redis service not available for GPS telemetry`,
        );
        continue;
      }

      let candLoc: { latitude: number; longitude: number } | null = null;
      try {
        const client = this.redisService.getClient();
        const raw = await client.get(
          `${CACHE_KEYS.DRIVER_GPS_PREFIX}${cand.id}`,
        );
        if (!raw) {
          this.logger.debug(
            `Driver ${cand.id} skipped: missing GPS fix in Redis`,
          );
          continue;
        }

        const parsed = JSON.parse(raw);
        if (
          typeof parsed.latitude !== 'number' ||
          typeof parsed.longitude !== 'number' ||
          Number.isNaN(parsed.latitude) ||
          Number.isNaN(parsed.longitude) ||
          parsed.latitude < -90 ||
          parsed.latitude > 90 ||
          parsed.longitude < -180 ||
          parsed.longitude > 180
        ) {
          this.logger.warn(
            `Driver ${cand.id} skipped: invalid coordinates in GPS fix`,
          );
          continue;
        }

        if (parsed.updatedAt) {
          const ageMs = Date.now() - new Date(parsed.updatedAt).getTime();
          if (ageMs > 30000) {
            this.logger.warn(
              `Driver ${cand.id} skipped: stale GPS fix (${ageMs}ms old)`,
            );
            continue;
          }
        }

        candLoc = {
          latitude: parsed.latitude,
          longitude: parsed.longitude,
        };
      } catch (err: any) {
        this.logger.warn(
          `Driver ${cand.id} skipped: failed to read GPS fix: ${err?.message}`,
        );
        continue;
      }

      if (!candLoc) {
        continue;
      }

      const maxCap = Math.max(
        ...cand.vehicles.map((v) => v.passengerCapacity),
        0,
      );

      // Strict OSRM road ETA calculation with retries (no geodesic fallback)
      const roadRoute = await this.calculateRoadEtaWithRetries(
        candLoc,
        incidentLocation,
      );

      if (!roadRoute) {
        // OSRM failed after 3 retries: fail closed per Edge Case 4
        this.logger.warn(
          `OSRM road ETA calculation failed after retries for driver ${cand.id}. Aborting replacement ranking.`,
        );
        throw new ServiceUnavailableException({
          errorCode: 'ROUTING_UNAVAILABLE',
          message:
            'OSRM routing service unavailable after retries; straight-line fallback rejected.',
        });
      }

      ranked.push({
        driverId: cand.id,
        driverName: cand.user?.fullName || 'Driver',
        vehicleCapacity: maxCap,
        location: candLoc,
        etaSeconds: roadRoute.durationSec,
        distanceMeters: roadRoute.distanceMeters,
      });
    }

    ranked.sort((a, b) => a.etaSeconds - b.etaSeconds);
    return ranked;
  }

  /**
   * Dispatches a single replacement offer to one driver with a 20-second timeout.
   * Strict 1-to-1 dispatch per docs/FAILURE_HANDLING_AND_RECOVERY.md.
   */
  async dispatchSingleReplacementOffer(
    tripId: string,
    incidentId: string,
    candidate: {
      driverId: string;
      driverName: string;
      etaSeconds: number;
      distanceMeters?: number;
    },
    attemptNumber: number,
  ) {
    const expiresAt = new Date(Date.now() + 20000); // 20s timeout per spec

    const dispatchTxResult = await this.prisma.$transaction(async (tx) => {
      // 1. Lock trip row
      const trips = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >`
        SELECT id, status FROM trips WHERE id = ${tripId}::uuid FOR UPDATE;
      `;

      if (!trips || trips.length === 0 || trips[0].status !== 'INTERRUPTED') {
        this.logger.warn(
          `Cannot dispatch replacement offer: trip ${tripId} is not in status INTERRUPTED (current: ${trips?.[0]?.status})`,
        );
        return null;
      }

      // 2. Lock incident row
      const incidents = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >`
        SELECT id, status
        FROM trip_incidents
        WHERE id = ${incidentId}::uuid AND status = 'REPORTED'
        FOR UPDATE;
      `;

      if (!incidents || incidents.length === 0) {
        this.logger.warn(
          `Cannot dispatch replacement offer: incident ${incidentId} is not in status REPORTED`,
        );
        return null;
      }

      // 3. Ensure no active attempt already exists
      const existingActive = await tx.replacementDispatchAttempt.findFirst({
        where: { tripIncidentId: incidentId, status: 'ACTIVE' },
      });

      if (existingActive) {
        this.logger.warn(
          `Cannot dispatch replacement offer: an ACTIVE attempt (${existingActive.id}) already exists for incident ${incidentId}`,
        );
        return null;
      }

      const attempt = await tx.replacementDispatchAttempt.create({
        data: {
          tripIncidentId: incidentId,
          attemptNumber,
          status: 'ACTIVE',
        },
      });

      // Record outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'REPLACEMENT_OFFER_DISPATCHED',
          aggregateType: 'TRIP_INCIDENT',
          aggregateId: incidentId,
          payload: {
            tripId,
            incidentId,
            attemptId: attempt.id,
            attemptNumber,
            driverId: candidate.driverId,
            driverName: candidate.driverName,
            etaSeconds: candidate.etaSeconds,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });

      return attempt;
    });

    if (!dispatchTxResult) {
      return null;
    }

    // Schedule 20s timeout in BullMQ if queue is available
    if (this.dispatchQueue) {
      try {
        await this.dispatchQueue.add(
          'replacement-offer-timeout',
          {
            tripId,
            incidentId,
            attemptId: dispatchTxResult.id,
            attemptNumber,
            driverId: candidate.driverId,
          },
          {
            delay: 20000,
            jobId: `replacement-timeout-${dispatchTxResult.id}`,
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to schedule BullMQ timeout for replacement offer: ${err?.message}`,
        );
      }
    }

    return {
      attemptId: dispatchTxResult.id,
      attemptNumber,
      driverId: candidate.driverId,
      etaSeconds: candidate.etaSeconds,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Replacement driver explicitly declines the transfer offer (Edge Case 1).
   * Marks attempt REJECTED, excludes driver, and cascades immediately to next ranked driver.
   */
  async rejectReplacementOffer(
    replacementDriverUserId: string,
    tripId: string,
    attemptId?: string,
    claim?: IdempotencyClaimContext,
  ) {
    const driver = await this.getVerifiedDriverProfile(replacementDriverUserId);

    const rejectResult = await this.prisma.$transaction(async (tx) => {
      await verifyIdempotencyClaim(tx, claim);

      const trips = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >`
        SELECT id, status FROM trips WHERE id = ${tripId}::uuid FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];
      if (trip.status !== 'INTERRUPTED') {
        throw new BadRequestException({
          errorCode: 'TRIP_NOT_INTERRUPTED',
          message: `Trip must be in status 'INTERRUPTED' to reject replacement (current: '${trip.status}').`,
        });
      }

      // 2. Lock active incident row with SELECT ... FOR UPDATE
      const incidents = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >`
        SELECT id, status
        FROM trip_incidents
        WHERE trip_id = ${tripId}::uuid AND status = 'REPORTED'
        ORDER BY reported_at DESC
        LIMIT 1
        FOR UPDATE;
      `;

      if (!incidents || incidents.length === 0) {
        throw new BadRequestException({
          errorCode: 'NO_ACTIVE_INCIDENT',
          message: 'No active breakdown incident found for this trip.',
        });
      }

      const incident = incidents[0];

      // 3. Find and validate active attempt inside transaction
      let attempt: {
        id: string;
        tripIncidentId: string;
        attemptNumber: number;
        status: string;
      } | null = null;

      if (attemptId) {
        attempt = await tx.replacementDispatchAttempt.findUnique({
          where: { id: attemptId },
        });

        if (!attempt || attempt.tripIncidentId !== incident.id) {
          throw new NotFoundException({
            errorCode: 'ATTEMPT_NOT_FOUND',
            message: `Replacement dispatch attempt with ID ${attemptId} not found for this incident.`,
          });
        }

        if (attempt.status !== 'ACTIVE') {
          throw new BadRequestException({
            errorCode: 'ATTEMPT_NOT_ACTIVE',
            message: `Replacement attempt ${attemptId} is not ACTIVE (current status: '${attempt.status}').`,
          });
        }
      } else {
        attempt = await tx.replacementDispatchAttempt.findFirst({
          where: {
            tripIncidentId: incident.id,
            status: 'ACTIVE',
          },
          orderBy: { attemptNumber: 'desc' },
        });

        if (!attempt) {
          throw new BadRequestException({
            errorCode: 'NO_ACTIVE_REPLACEMENT_OFFER',
            message: 'No active replacement offer found for this trip.',
          });
        }
      }

      // 4. Validate caller ownership
      const outboxEvents = await tx.outboxEvent.findMany({
        where: {
          aggregateId: incident.id,
          eventType: 'REPLACEMENT_OFFER_DISPATCHED',
        },
        orderBy: { createdAt: 'desc' },
      });

      const matchingEvent = outboxEvents.find((evt) => {
        const p =
          typeof evt.payload === 'string'
            ? JSON.parse(evt.payload)
            : (evt.payload as any);
        return p?.attemptId === attempt!.id;
      });

      if (matchingEvent) {
        const dispatchPayload =
          typeof matchingEvent.payload === 'string'
            ? JSON.parse(matchingEvent.payload)
            : (matchingEvent.payload as any);

        if (dispatchPayload.driverId !== driver.id) {
          throw new ForbiddenException({
            errorCode: 'OFFER_NOT_ASSIGNED_TO_DRIVER',
            message:
              'Calling driver was not offered this replacement dispatch attempt.',
          });
        }
      }

      // 5. Update attempt to REJECTED
      await tx.replacementDispatchAttempt.update({
        where: { id: attempt.id },
        data: { status: 'REJECTED' },
      });

      // 6. Record outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'REPLACEMENT_OFFER_REJECTED',
          aggregateType: 'TRIP_INCIDENT',
          aggregateId: incident.id,
          payload: {
            tripId,
            incidentId: incident.id,
            attemptId: attempt.id,
            attemptNumber: attempt.attemptNumber,
            driverId: driver.id,
            rejectedAt: new Date().toISOString(),
          },
        },
      });

      const responsePayload = {
        success: true,
        data: {
          tripId,
          incidentId: incident.id,
          driverId: driver.id,
          status: 'REJECTED',
        },
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return {
        tripId,
        incidentId: incident.id,
        driverId: driver.id,
        status: 'REJECTED',
      };
    });

    if (this.redisService) {
      try {
        const client = this.redisService.getClient();
        await client.sadd(
          `replacement:excluded:${rejectResult.incidentId}`,
          driver.id,
        );
        await client.expire(
          `replacement:excluded:${rejectResult.incidentId}`,
          3600,
        );
      } catch {}
    }

    // Cascade to next candidate outside transaction
    const cascadeResult = await this.cascadeToNextReplacementDriver(
      tripId,
      rejectResult.incidentId,
    );

    return {
      ...rejectResult,
      cascade: cascadeResult,
    };
  }

  /**
   * BullMQ timeout handler: 20s elapsed with no response from replacement driver (Edge Case 2).
   * Marks attempt EXPIRED, excludes driver, and cascades to next candidate driver.
   */
  async handleReplacementTimeout(payload: {
    tripId: string;
    incidentId: string;
    attemptId: string;
    attemptNumber: number;
    driverId: string;
  }) {
    const { tripId, incidentId, attemptId, driverId } = payload;

    const timeoutResult = await this.prisma.$transaction(async (tx) => {
      // 1. Lock trip row
      const trips = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >`
        SELECT id, status FROM trips WHERE id = ${tripId}::uuid FOR UPDATE;
      `;

      if (!trips || trips.length === 0 || trips[0].status !== 'INTERRUPTED') {
        return { shouldCascade: false, reason: 'TRIP_NOT_INTERRUPTED' };
      }

      // 2. Lock active incident row
      const incidents = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >`
        SELECT id, status
        FROM trip_incidents
        WHERE id = ${incidentId}::uuid AND status = 'REPORTED'
        FOR UPDATE;
      `;

      if (!incidents || incidents.length === 0) {
        return { shouldCascade: false, reason: 'INCIDENT_NOT_ACTIVE' };
      }

      const attempt = await tx.replacementDispatchAttempt.findUnique({
        where: { id: attemptId },
      });

      if (!attempt || attempt.status !== 'ACTIVE') {
        return {
          shouldCascade: false,
          reason: `ATTEMPT_NOT_ACTIVE (${attempt?.status})`,
        };
      }

      await tx.replacementDispatchAttempt.update({
        where: { id: attemptId },
        data: { status: 'EXPIRED' },
      });

      await tx.outboxEvent.create({
        data: {
          eventType: 'REPLACEMENT_OFFER_EXPIRED',
          aggregateType: 'TRIP_INCIDENT',
          aggregateId: incidentId,
          payload: {
            tripId,
            incidentId,
            attemptId,
            driverId,
            expiredAt: new Date().toISOString(),
          },
        },
      });

      return { shouldCascade: true, incidentId, driverId };
    });

    if (!timeoutResult.shouldCascade) {
      return { cascaded: false, reason: timeoutResult.reason };
    }

    if (this.redisService && timeoutResult.driverId) {
      try {
        const client = this.redisService.getClient();
        await client.sadd(
          `replacement:excluded:${incidentId}`,
          timeoutResult.driverId,
        );
        await client.expire(`replacement:excluded:${incidentId}`, 3600);
      } catch {}
    }

    return this.cascadeToNextReplacementDriver(tripId, incidentId);
  }

  /**
   * Cascades replacement offer to the next ranked eligible driver.
   * If all candidates are exhausted, aborts the interrupted trip with ₹0 fares (docs/FAILURE_HANDLING_AND_RECOVERY.md).
   */
  async cascadeToNextReplacementDriver(tripId: string, incidentId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, status: true },
    });

    if (!trip || trip.status !== 'INTERRUPTED') {
      return { cascaded: false, reason: `Trip is in status ${trip?.status}` };
    }

    const incident = await this.prisma.tripIncident.findUnique({
      where: { id: incidentId },
    });

    if (!incident || incident.status !== 'REPORTED') {
      return {
        cascaded: false,
        reason: `Incident is in status ${incident?.status}`,
      };
    }

    // Ensure no active replacement offer is already pending
    const existingActive =
      await this.prisma.replacementDispatchAttempt.findFirst({
        where: { tripIncidentId: incidentId, status: 'ACTIVE' },
      });

    if (existingActive) {
      return {
        cascaded: false,
        reason: `ACTIVE_OFFER_ALREADY_EXISTS (${existingActive.id})`,
      };
    }

    // Excluded drivers: original driver + drivers previously offered
    const excludedDriverIds = new Set<string>();
    excludedDriverIds.add(incident.originalDriverId);

    const pastEvents = await this.prisma.outboxEvent.findMany({
      where: {
        aggregateId: incidentId,
        eventType: {
          in: [
            'REPLACEMENT_OFFER_DISPATCHED',
            'REPLACEMENT_OFFER_REJECTED',
            'REPLACEMENT_OFFER_EXPIRED',
          ],
        },
      },
      select: { payload: true },
    });

    for (const ev of pastEvents) {
      const p = ev.payload as any;
      if (p?.driverId) excludedDriverIds.add(p.driverId);
    }

    if (this.redisService) {
      try {
        const client = this.redisService.getClient();
        const redisExcluded = await client.smembers(
          `replacement:excluded:${incidentId}`,
        );
        for (const id of redisExcluded) {
          excludedDriverIds.add(id);
        }
      } catch {}
    }

    const snapshot =
      typeof incident.onboardManifestSnapshot === 'string'
        ? JSON.parse(incident.onboardManifestSnapshot)
        : (incident.onboardManifestSnapshot as any);
    const boardedCount = snapshot?.boardedPassengerCount ?? 1;

    const locRows = await this.prisma.$queryRaw<
      Array<{ lat: number; lng: number }>
    >`
      SELECT ST_Y(incident_location::geometry) AS lat, ST_X(incident_location::geometry) AS lng
      FROM trip_incidents
      WHERE id = ${incidentId}::uuid
    `;
    const incidentLoc =
      locRows.length > 0 && locRows[0].lat != null && locRows[0].lng != null
        ? {
            latitude: Number(locRows[0].lat),
            longitude: Number(locRows[0].lng),
          }
        : null;

    if (!incidentLoc) {
      this.logger.error(
        `Incident location unavailable for trip ${tripId} during replacement cascade. Aborting trip.`,
      );
      await this.abortInterruptedTrip(
        tripId,
        'INCIDENT_LOCATION_UNAVAILABLE',
      );
      return {
        cascaded: false,
        aborted: true,
        reason: 'INCIDENT_LOCATION_UNAVAILABLE',
      };
    }

    let rankedCandidates: Array<{
      driverId: string;
      driverName: string;
      vehicleCapacity: number;
      location: { latitude: number; longitude: number };
      etaSeconds: number;
      distanceMeters: number;
    }> = [];

    try {
      rankedCandidates = await this.findEligibleReplacementDrivers(
        tripId,
        incidentLoc,
        boardedCount,
        Array.from(excludedDriverIds),
      );
    } catch (err: any) {
      this.logger.error(
        `OSRM road ETA ranking failed after retries during replacement cascade: ${err?.message}`,
      );
      await this.abortInterruptedTrip(
        tripId,
        'OSRM_SERVICE_UNAVAILABLE_AFTER_RETRIES',
      );
      return {
        cascaded: false,
        aborted: true,
        reason: 'OSRM_SERVICE_UNAVAILABLE_AFTER_RETRIES',
      };
    }

    if (rankedCandidates.length === 0) {
      this.logger.warn(
        `All replacement driver candidates exhausted for trip ${tripId}. Aborting trip.`,
      );
      const currentTrip = await this.prisma.trip.findUnique({
        where: { id: tripId },
        select: { status: true },
      });
      if (currentTrip?.status === 'INTERRUPTED') {
        await this.abortInterruptedTrip(
          tripId,
          'ALL_REPLACEMENT_OFFERS_EXHAUSTED',
        );
        return {
          cascaded: false,
          aborted: true,
          reason: 'ALL_REPLACEMENT_OFFERS_EXHAUSTED',
        };
      }
      return {
        cascaded: false,
        aborted: false,
        reason: `Trip is in status '${currentTrip?.status}', skipping abort`,
      };
    }

    const nextCandidate = rankedCandidates[0];
    const attemptCount = await this.prisma.replacementDispatchAttempt.count({
      where: { tripIncidentId: incidentId },
    });
    const nextAttemptNumber = attemptCount + 1;

    const dispatchResult = await this.dispatchSingleReplacementOffer(
      tripId,
      incidentId,
      nextCandidate,
      nextAttemptNumber,
    );

    if (!dispatchResult) {
      return {
        cascaded: false,
        aborted: false,
        reason: 'ACTIVE_OFFER_ALREADY_EXISTS_OR_TRIP_NOT_ELIGIBLE',
      };
    }

    return {
      cascaded: true,
      aborted: false,
      nextDriverId: nextCandidate.driverId,
      attemptNumber: nextAttemptNumber,
      dispatchResult,
    };
  }

  /**
   * Replacement driver accepts handover for an interrupted trip.
   * - Validates caller owns the currently ACTIVE replacement dispatch attempt.
   * - Validates attemptId when provided.
   * - Verifies attempt, incident, expiry, and driver inside the transaction before reserving.
   * - Atomically reserves replacement driver (operationalStatus = RESERVED).
   * - Resumes trip to IN_PROGRESS.
   * - Records ReplacementDriverAssignment and marks incident RESOLVED.
   * - Applies automatic 10% compensation discount (ADR-023) to all passengers onboard at breakdown.
   * - Emits trip.resumed outbox event.
   */
  async acceptReplacementTrip(
    replacementDriverUserId: string,
    tripId: string,
    attemptId?: string,
    claim?: IdempotencyClaimContext,
  ) {
    const replacementDriver = await this.getVerifiedDriverProfile(
      replacementDriverUserId,
    );

    return this.prisma.$transaction(async (tx) => {
      await verifyIdempotencyClaim(tx, claim);

      // 1. Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          ride_group_id: string;
        }>
      >`
        SELECT id, status, active_driver_id, ride_group_id
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      // Idempotency: if replacement already accepted by this driver
      if (
        trip.status === 'IN_PROGRESS' &&
        trip.active_driver_id === replacementDriver.id
      ) {
        const acceptResult = {
          tripId: trip.id,
          status: 'IN_PROGRESS',
          activeDriverId: replacementDriver.id,
          message: 'Replacement already accepted for this trip',
        };
        const responsePayload = {
          success: true,
          data: acceptResult,
        };
        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.OK,
        );
        return acceptResult;
      }

      if (trip.status !== 'INTERRUPTED') {
        throw new BadRequestException({
          errorCode: 'TRIP_NOT_INTERRUPTED',
          message: `Trip must be in status 'INTERRUPTED' to accept replacement (current: '${trip.status}').`,
        });
      }

      // 2. Lock active incident row with SELECT ... FOR UPDATE
      const incidents = await tx.$queryRaw<
        Array<{
          id: string;
          original_driver_id: string;
          onboard_manifest_snapshot: any;
          status: string;
        }>
      >`
        SELECT id, original_driver_id, onboard_manifest_snapshot, status
        FROM trip_incidents
        WHERE trip_id = ${tripId}::uuid AND status = 'REPORTED'
        ORDER BY reported_at DESC
        LIMIT 1
        FOR UPDATE;
      `;

      if (!incidents || incidents.length === 0) {
        throw new BadRequestException({
          errorCode: 'NO_ACTIVE_INCIDENT',
          message: 'No active breakdown incident found for this trip.',
        });
      }

      const incident = incidents[0];

      if (incident.original_driver_id === replacementDriver.id) {
        throw new BadRequestException({
          errorCode: 'ORIGINAL_DRIVER_CANNOT_REPLACE',
          message:
            'The original broken-down driver cannot accept the replacement handover.',
        });
      }

      // 3. Find and validate the replacement dispatch attempt inside transaction
      let attempt: {
        id: string;
        tripIncidentId: string;
        attemptNumber: number;
        status: string;
      } | null = null;

      if (attemptId) {
        attempt = await tx.replacementDispatchAttempt.findUnique({
          where: { id: attemptId },
        });

        if (!attempt || attempt.tripIncidentId !== incident.id) {
          throw new NotFoundException({
            errorCode: 'ATTEMPT_NOT_FOUND',
            message: `Replacement dispatch attempt with ID ${attemptId} not found for this incident.`,
          });
        }

        if (attempt.status !== 'ACTIVE') {
          throw new BadRequestException({
            errorCode: 'ATTEMPT_NOT_ACTIVE',
            message: `Replacement attempt ${attemptId} is not ACTIVE (current status: '${attempt.status}').`,
          });
        }
      } else {
        attempt = await tx.replacementDispatchAttempt.findFirst({
          where: {
            tripIncidentId: incident.id,
            status: 'ACTIVE',
          },
          orderBy: { attemptNumber: 'desc' },
        });

        if (!attempt) {
          throw new BadRequestException({
            errorCode: 'NO_ACTIVE_REPLACEMENT_OFFER',
            message: 'No active replacement offer found for this trip.',
          });
        }
      }

      // 4. Validate caller ownership and offer expiry inside transaction
      const outboxEvents = await tx.outboxEvent.findMany({
        where: {
          aggregateId: incident.id,
          eventType: 'REPLACEMENT_OFFER_DISPATCHED',
        },
        orderBy: { createdAt: 'desc' },
      });

      const matchingEvent = outboxEvents.find((evt) => {
        const p =
          typeof evt.payload === 'string'
            ? JSON.parse(evt.payload)
            : (evt.payload as any);
        return p?.attemptId === attempt!.id;
      });

      if (!matchingEvent) {
        throw new BadRequestException({
          errorCode: 'INVALID_REPLACEMENT_OFFER',
          message: 'Dispatch offer metadata could not be verified for this attempt.',
        });
      }

      const dispatchPayload =
        typeof matchingEvent.payload === 'string'
          ? JSON.parse(matchingEvent.payload)
          : (matchingEvent.payload as any);

      if (dispatchPayload.driverId !== replacementDriver.id) {
        throw new ForbiddenException({
          errorCode: 'OFFER_NOT_ASSIGNED_TO_DRIVER',
          message:
            'Calling driver was not offered this replacement dispatch attempt.',
        });
      }

      if (dispatchPayload.expiresAt) {
        const expiresAt = new Date(dispatchPayload.expiresAt);
        if (Date.now() > expiresAt.getTime()) {
          throw new BadRequestException({
            errorCode: 'REPLACEMENT_OFFER_EXPIRED',
            message: 'Replacement offer has expired.',
          });
        }
      }

      // Check capacity
      const snapshot =
        typeof incident.onboard_manifest_snapshot === 'string'
          ? JSON.parse(incident.onboard_manifest_snapshot)
          : incident.onboard_manifest_snapshot;
      const boardedCount = snapshot?.boardedPassengerCount ?? 1;

      const vehicle = await tx.vehicle.findFirst({
        where: {
          driverProfileId: replacementDriver.id,
          isActive: true,
          passengerCapacity: { gte: boardedCount },
        },
      });

      if (!vehicle) {
        throw new BadRequestException({
          errorCode: 'INSUFFICIENT_VEHICLE_CAPACITY',
          message: `Replacement driver vehicle capacity is insufficient for ${boardedCount} onboard passengers.`,
        });
      }

      // 5. Atomically reserve replacement driver
      const reserveResult = await tx.$executeRaw`
        UPDATE driver_profiles
        SET operational_status = 'RESERVED'
        WHERE id = ${replacementDriver.id}::uuid AND operational_status = 'AVAILABLE';
      `;

      if (reserveResult === 0) {
        throw new ConflictException({
          errorCode: 'DRIVER_NOT_AVAILABLE',
          message:
            'Replacement driver is no longer available or already reserved.',
        });
      }

      const now = new Date();

      // Ensure only one replacement assignment can ever be created for this incident
      const existingAssignment =
        await tx.replacementDriverAssignment.findFirst({
          where: {
            tripIncidentId: incident.id,
            status: 'ASSIGNED',
          },
        });

      if (existingAssignment) {
        throw new ConflictException({
          errorCode: 'REPLACEMENT_ALREADY_ASSIGNED',
          message:
            'A replacement driver has already been assigned to this breakdown incident.',
        });
      }

      // 6. Record replacement driver assignment
      await tx.replacementDriverAssignment.create({
        data: {
          tripIncidentId: incident.id,
          replacementDriverId: replacementDriver.id,
          status: 'ASSIGNED',
          assignedAt: now,
          handoverCompletedAt: now,
        },
      });

      // 7. Update active replacement attempt to ACCEPTED
      await tx.replacementDispatchAttempt.update({
        where: { id: attempt.id },
        data: { status: 'ACCEPTED' },
      });

      // 8. Update incident status to RESOLVED
      await tx.tripIncident.update({
        where: { id: incident.id },
        data: { status: 'RESOLVED' },
      });

      // 9. Update trip activeDriverId and status to IN_PROGRESS
      await tx.trip.update({
        where: { id: tripId },
        data: {
          activeDriverId: replacementDriver.id,
          status: 'IN_PROGRESS',
        },
      });

      // 10. Release original driver profile
      await tx.$executeRaw`
        UPDATE driver_profiles
        SET operational_status = 'AVAILABLE'
        WHERE id = ${incident.original_driver_id}::uuid;
      `;

      // 11. Apply 10% compensation discount (ADR-023) to remaining onboard passengers
      const onboardPassengers = await tx.tripPassenger.findMany({
        where: {
          tripId,
          status: 'BOARDED',
        },
      });

      const discountedPassengers: Array<{
        tripPassengerId: string;
        bookingId: string;
        originalFarePaise: number;
        discountPaise: number;
        finalFarePaise: number;
      }> = [];

      for (const tp of onboardPassengers) {
        const originalFare = tp.finalRideFarePaise;
        const discountPaise = Math.round(originalFare * 0.1);
        const finalFarePaise = Math.max(0, originalFare - discountPaise);

        await tx.tripPassenger.update({
          where: { id: tp.id },
          data: { finalRideFarePaise: finalFarePaise },
        });

        await tx.booking.update({
          where: { id: tp.bookingId },
          data: { finalAllocatedFarePaise: finalFarePaise },
        });

        await tx.fareAdjustment.create({
          data: {
            tripPassengerId: tp.id,
            adjustmentType: 'BREAKDOWN_COMPENSATION',
            discountPercentage: 10,
            adjustmentAmountPaise: discountPaise,
            justification:
              '10% compensation discount for mid-trip breakdown and replacement',
            appliedAt: now,
          },
        });

        discountedPassengers.push({
          tripPassengerId: tp.id,
          bookingId: tp.bookingId,
          originalFarePaise: originalFare,
          discountPaise,
          finalFarePaise,
        });
      }

      // 12. Trip status history
      await tx.tripStatusHistory.create({
        data: {
          tripId,
          previousStatus: 'INTERRUPTED',
          newStatus: 'IN_PROGRESS',
          reason:
            'Trip resumed by replacement driver with 10% discount applied',
        },
      });

      // 13. Outbox event (trip.resumed domain event)
      await tx.outboxEvent.create({
        data: {
          eventType: 'TRIP_RESUMED',
          aggregateType: 'TRIP',
          aggregateId: tripId,
          payload: {
            tripId,
            incidentId: incident.id,
            replacementDriverId: replacementDriver.id,
            discountPercentage: 10,
            discountedPassengersCount: discountedPassengers.length,
          },
        },
      });

      const acceptResult = {
        tripId,
        status: 'IN_PROGRESS',
        activeDriverId: replacementDriver.id,
        incidentId: incident.id,
        discountPercentage: 10,
        discountedPassengers,
      };

      const responsePayload = {
        success: true,
        message:
          'Replacement accepted; trip resumed with 10% passenger discount',
        data: acceptResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return acceptResult;
    });
  }

  /**
   * Aborts an interrupted trip when replacement driver dispatch fails or is unavailable.
   * - Transitions trip to ABORTED.
   * - Sets all onboard passenger fares to ₹0.00 (ADR-024).
   * - Records full refund records in refund_records.
   * - Closes any ACTIVE replacement dispatch attempts and releases reserved replacement drivers.
   * - Releases original driver and dissolves ride group.
   * - Emits TRIP_ABORTED outbox event.
   */
  async abortInterruptedTrip(
    tripId: string,
    reason?: string,
    claim?: IdempotencyClaimContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await verifyIdempotencyClaim(tx, claim);

      // 1. Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          ride_group_id: string;
          driver_assignment_id: string;
        }>
      >`
        SELECT id, status, active_driver_id, ride_group_id, driver_assignment_id
        FROM trips
        WHERE id = ${tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.status === 'ABORTED') {
        const abortResult = {
          tripId,
          status: 'ABORTED',
          affectedPassengersCount: 0,
          refundedPassengers: [],
          message: 'Trip was already aborted',
        };
        const responsePayload = {
          success: true,
          data: abortResult,
        };
        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.OK,
        );
        return abortResult;
      }

      if (trip.status !== 'INTERRUPTED') {
        throw new BadRequestException({
          errorCode: 'CANNOT_ABORT_TRIP',
          message: `Cannot abort trip in status '${trip.status}'. Trip must be 'INTERRUPTED'.`,
        });
      }

      const now = new Date();

      // 2. Update trip status to ABORTED
      await tx.trip.update({
        where: { id: tripId },
        data: { status: 'ABORTED' },
      });

      // 3. Update any open incidents to ABORTED
      await tx.tripIncident.updateMany({
        where: { tripId, status: 'REPORTED' },
        data: { status: 'ABORTED' },
      });

      // 3b. Expire any ACTIVE replacement dispatch attempts
      await tx.replacementDispatchAttempt.updateMany({
        where: {
          incident: { tripId },
          status: 'ACTIVE',
        },
        data: { status: 'EXPIRED' },
      });

      // 3c. Cancel any active replacement driver assignments and release reserved replacement drivers
      const replacementAssignments =
        await tx.replacementDriverAssignment.findMany({
          where: { incident: { tripId }, status: 'ASSIGNED' },
        });

      for (const repAssign of replacementAssignments) {
        await tx.replacementDriverAssignment.update({
          where: { id: repAssign.id },
          data: { status: 'CANCELLED' },
        });

        await tx.$executeRaw`
          UPDATE driver_profiles
          SET operational_status = 'AVAILABLE'
          WHERE id = ${repAssign.replacementDriverId}::uuid AND operational_status = 'RESERVED';
        `;
      }

      // 4. Update trip_passengers who were BOARDED: set fare to 0 and record refund audit
      const onboardPassengers = await tx.tripPassenger.findMany({
        where: {
          tripId,
          status: 'BOARDED',
        },
      });

      const refundedPassengers: Array<{
        tripPassengerId: string;
        bookingId: string;
        waivedFarePaise: number;
      }> = [];

      for (const tp of onboardPassengers) {
        const originalFare = tp.finalRideFarePaise;

        // Set fare to 0 and cancel passenger journey
        await tx.tripPassenger.update({
          where: { id: tp.id },
          data: {
            finalRideFarePaise: 0,
            status: 'CANCELLED',
          },
        });

        await tx.booking.update({
          where: { id: tp.bookingId },
          data: {
            finalAllocatedFarePaise: 0,
            status: 'CANCELLED',
          },
        });

        // Audit refund record
        await tx.refundRecord.create({
          data: {
            tripPassengerId: tp.id,
            refundAmountPaise: originalFare,
            status: 'COMPLETED',
            reason:
              reason ||
              'Trip aborted due to unrecoverable vehicle breakdown; 100% fare waiver (₹0 fare)',
            issuedAt: now,
          },
        });

        refundedPassengers.push({
          tripPassengerId: tp.id,
          bookingId: tp.bookingId,
          waivedFarePaise: originalFare,
        });
      }

      // 5. Release driver assignment and operational status
      if (trip.driver_assignment_id) {
        await tx.driverAssignment.update({
          where: { id: trip.driver_assignment_id },
          data: { status: 'RELEASED' },
        });
      }

      await tx.$executeRaw`
        UPDATE driver_profiles
        SET operational_status = 'AVAILABLE'
        WHERE id = ${trip.active_driver_id}::uuid;
      `;

      const incidents = await tx.tripIncident.findMany({
        where: { tripId },
        select: { originalDriverId: true },
      });
      for (const inc of incidents) {
        await tx.$executeRaw`
          UPDATE driver_profiles
          SET operational_status = 'AVAILABLE'
          WHERE id = ${inc.originalDriverId}::uuid AND operational_status = 'RESERVED';
        `;
      }

      // 6. Dissolve ride group
      await tx.rideGroup.update({
        where: { id: trip.ride_group_id },
        data: { status: 'DISSOLVED' },
      });

      await tx.groupMember.updateMany({
        where: { rideGroupId: trip.ride_group_id },
        data: { isActiveMember: false },
      });

      // 7. Record trip status history
      await tx.tripStatusHistory.create({
        data: {
          tripId,
          previousStatus: trip.status,
          newStatus: 'ABORTED',
          reason:
            reason ||
            'Vehicle breakdown replacement unavailable; trip aborted',
        },
      });

      // 8. Outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'TRIP_ABORTED',
          aggregateType: 'TRIP',
          aggregateId: tripId,
          payload: {
            tripId,
            reason: reason || 'REPLACEMENT_UNAVAILABLE',
            refundedCount: refundedPassengers.length,
          },
        },
      });

      const abortResult = {
        tripId,
        status: 'ABORTED',
        affectedPassengersCount: refundedPassengers.length,
        refundedPassengers,
      };

      const responsePayload = {
        success: true,
        message:
          'Trip aborted; onboard passenger fares set to ₹0.00 with refund audited',
        data: abortResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return abortResult;
    });
  }

  /**
   * Retrieve active or latest incident details for a trip.
   */
  async getTripIncident(tripId: string) {
    const incident = await this.prisma.tripIncident.findFirst({
      where: { tripId },
      orderBy: { reportedAt: 'desc' },
      include: {
        replacementAssignments: {
          include: {
            replacementDriver: {
              include: { user: { select: { fullName: true } } },
            },
          },
        },
        replacementAttempts: true,
      },
    });

    if (!incident) {
      throw new NotFoundException({
        errorCode: 'INCIDENT_NOT_FOUND',
        message: `No incident record found for trip ${tripId}.`,
      });
    }

    return incident;
  }
}
