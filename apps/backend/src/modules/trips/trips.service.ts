import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { VerifyBoardingDto } from './dto/verify-boarding.dto.js';

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

  constructor(private readonly prisma: PrismaService) {}

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
   * Starts individual 5-minute free waiting timer.
   */
  async reportArrival(driverUserId: string, tripId: string) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
      // Pessimistic lock on trip row using SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_assignment_id: string;
          ride_group_id: string;
        }>
      >`
        SELECT id, status, active_driver_id, driver_assignment_id, ride_group_id
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

      if (!['CREATED', 'DRIVER_EN_ROUTE'].includes(trip.status)) {
        throw new BadRequestException({
          errorCode: 'INVALID_TRIP_STATUS_FOR_ARRIVAL',
          message: `Cannot report arrival for trip in status '${trip.status}'.`,
        });
      }

      const now = new Date();

      // Update trip status to AT_PICKUP
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

      return {
        tripId: updatedTrip.id,
        status: updatedTrip.status,
        driverArrivedAt: updatedTrip.driverArrivedAt?.toISOString(),
      };
    });
  }

  /**
   * Verify passenger boarding via secure 4-digit hashed OTP.
   * Calculates waiting charges: first 5m free, ₹5/started min thereafter.
   */
  async verifyBoarding(
    driverUserId: string,
    tripId: string,
    dto: VerifyBoardingDto,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
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
        }>
      >`
        SELECT id, trip_passenger_id, otp_hash, is_verified, attempts_count, max_attempts
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
        return {
          tripPassengerId: passenger.id,
          passengerStatus: passenger.status,
          waitingChargePaise: passenger.waiting_charge_paise,
          boardedAt: passenger.boarded_at?.toISOString(),
        };
      }

      // Enforce maximum 3 attempts
      if (verification.attempts_count >= verification.max_attempts) {
        throw new BadRequestException({
          errorCode: 'OTP_MAX_ATTEMPTS_EXCEEDED',
          message: 'Maximum OTP verification attempts (3) exceeded.',
        });
      }

      // Compare SHA-256 hash
      const inputHash = crypto
        .createHash('sha256')
        .update(dto.otp)
        .digest('hex');

      if (inputHash !== verification.otp_hash) {
        // Increment attempts count
        await tx.boardingVerification.update({
          where: { id: verification.id },
          data: {
            attemptsCount: { increment: 1 },
          },
        });

        throw new BadRequestException({
          errorCode: 'INVALID_OTP',
          message: 'Invalid boarding OTP provided.',
        });
      }

      // OTP matched: Calculate waiting charges
      const now = new Date();
      let waitingChargePaise = 0;

      if (trip.driver_arrived_at) {
        const arrivalTime = new Date(trip.driver_arrived_at).getTime();
        const elapsedSec = (now.getTime() - arrivalTime) / 1000;
        const elapsedMinutes = Math.max(0, elapsedSec / 60);

        // Schedule: First 5 minutes free (<= 300s). ₹5/started min thereafter.
        if (elapsedMinutes > 5) {
          const startedMinutesOver = Math.ceil(elapsedMinutes - 5);
          waitingChargePaise = Math.min(2500, startedMinutesOver * 500); // 500 paise/min, cap at 5 mins = 2500 paise
        }
      }

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

      return {
        tripPassengerId: updatedPassenger.id,
        passengerStatus: updatedPassenger.status,
        waitingChargePaise,
        boardedAt: updatedPassenger.boardedAt?.toISOString(),
      };
    });
  }

  /**
   * Driver departs pickup hub: transitions vehicle trip from AT_PICKUP to IN_PROGRESS.
   * Requires all active passengers to be BOARDED.
   */
  async startTrip(driverUserId: string, tripId: string) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
      // Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_assignment_id: string;
        }>
      >`
        SELECT id, status, active_driver_id, driver_assignment_id
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

      const now = new Date();

      // Update trip status
      const updatedTrip = await tx.trip.update({
        where: { id: tripId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: now,
        },
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
            driverId: driver.id,
            startedAt: now,
          },
        },
      });

      return {
        tripId: updatedTrip.id,
        status: updatedTrip.status,
        startedAt: updatedTrip.startedAt?.toISOString(),
      };
    });
  }

  /**
   * Complete individual passenger drop-off.
   * Calculates cash to collect: ride fare + waiting charges + outstanding cancellation fee surcharge.
   */
  async completePassenger(
    driverUserId: string,
    tripId: string,
    passengerId: string,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
      // Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
        }>
      >`
        SELECT id, status, active_driver_id
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

      if (passenger.status !== 'BOARDED') {
        throw new BadRequestException({
          errorCode: 'INVALID_PASSENGER_STATUS_FOR_COMPLETION',
          message: `Cannot complete drop-off for passenger in status '${passenger.status}'.`,
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

      // Query outstanding cancellation fee surcharge
      const outstandingFees = await tx.cancellationFee.findMany({
        where: {
          passengerId,
          status: 'OUTSTANDING',
        },
      });

      const outstandingLateFeeSurchargePaise = outstandingFees.reduce(
        (sum, f) => sum + f.amountPaise,
        0,
      );

      const totalCashToCollectPaise =
        passenger.final_ride_fare_paise +
        passenger.waiting_charge_paise +
        outstandingLateFeeSurchargePaise;

      await tx.outboxEvent.create({
        data: {
          eventType: 'PASSENGER_DROPPED_OFF',
          aggregateType: 'TRIP_PASSENGER',
          aggregateId: passenger.id,
          payload: {
            tripId,
            passengerId,
            rideFarePaise: passenger.final_ride_fare_paise,
            waitingChargePaise: passenger.waiting_charge_paise,
            outstandingLateFeeSurchargePaise,
            totalCashToCollectPaise,
          },
        },
      });

      return {
        passengerId,
        rideFarePaise: passenger.final_ride_fare_paise,
        rideFare: (passenger.final_ride_fare_paise / 100).toFixed(2),
        waitingChargePaise: passenger.waiting_charge_paise,
        waitingCharge: (passenger.waiting_charge_paise / 100).toFixed(2),
        outstandingLateFeeSurchargePaise,
        outstandingLateFeeSurcharge: (
          outstandingLateFeeSurchargePaise / 100
        ).toFixed(2),
        totalCashToCollectPaise,
        totalCashToCollect: (totalCashToCollectPaise / 100).toFixed(2),
      };
    });
  }

  /**
   * Driver declares passenger no-show after 10 minutes from driver arrival.
   * Assesses flat ₹30 no-show fee into cancellation_fees ledger. Zero waiting charge.
   */
  async declareNoShow(
    driverUserId: string,
    tripId: string,
    passengerId: string,
  ) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
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

      return {
        passengerId,
        status: 'NO_SHOW',
        penaltyAssessedPaise: 3000,
        penaltyAssessed: '30.00',
      };
    });
  }

  /**
   * Finalize vehicle trip after all drop-offs or no-shows are resolved.
   * Releases driver operational status back to AVAILABLE.
   */
  async completeTrip(driverUserId: string, tripId: string) {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
      // Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
          driver_assignment_id: string;
          ride_group_id: string;
        }>
      >`
        SELECT id, status, active_driver_id, driver_assignment_id, ride_group_id
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

      if (trip.status !== 'IN_PROGRESS') {
        throw new BadRequestException({
          errorCode: 'INVALID_TRIP_STATUS_FOR_COMPLETION',
          message: `Trip must be 'IN_PROGRESS' to complete (current: '${trip.status}').`,
        });
      }

      // Lock driver profile row for atomic operational status release
      await tx.$executeRaw`
        SELECT id FROM driver_profiles WHERE id = ${driver.id}::uuid FOR UPDATE;
      `;

      // Verify all passengers are finalized
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

      // Update trip
      const updatedTrip = await tx.trip.update({
        where: { id: tripId },
        data: {
          status: 'COMPLETED',
          completedAt: now,
        },
      });

      // Update assignment
      await tx.driverAssignment.update({
        where: { id: trip.driver_assignment_id },
        data: {
          status: 'COMPLETED',
          completedAt: now,
        },
      });

      // Update ride group
      await tx.rideGroup.update({
        where: { id: trip.ride_group_id },
        data: { status: 'COMPLETED' },
      });

      // Atomic CAS to release driver operational_status back to AVAILABLE
      await tx.driverProfile.update({
        where: { id: driver.id },
        data: {
          operationalStatus: 'AVAILABLE',
        },
      });

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
            driverId: driver.id,
            completedAt: now,
          },
        },
      });

      return {
        tripId: updatedTrip.id,
        status: updatedTrip.status,
        completedAt: updatedTrip.completedAt?.toISOString(),
      };
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
   * Testing & lifecycle helper: materializes a trip from a ride group,
   * driver assignment, and passenger bookings with 4-digit hashed OTPs.
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
