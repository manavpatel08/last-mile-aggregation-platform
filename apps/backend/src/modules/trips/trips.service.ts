import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';
import { hashBoardingOtp } from '../../common/utils/otp.util.js';
import { VerifyBoardingDto } from './dto/verify-boarding.dto.js';
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

    return this.prisma.$transaction(async (tx) => {
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

      // Lock trip passenger row with SELECT ... FOR UPDATE
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

        return noShowResult;
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
      await tx.cancellationFee.create({
        data: {
          passengerId,
          originalBookingId: passenger.booking_id,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

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

      return noShowResult;
    });
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
}
