import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { ConfirmCashDto } from './dto/confirm-cash.dto.js';
import { WaiveCancellationFeeDto } from './dto/waive-cancellation-fee.dto.js';
import {
  IdempotencyClaimContext,
  verifyIdempotencyClaim,
  fenceAndCompleteIdempotentTransaction,
} from '../../common/interceptors/idempotency.interceptor.js';

export interface PaymentAllocationItem {
  id: string;
  obligationType: string;
  obligationEntityId: string;
  allocatedAmountPaise: number;
  allocatedAmount: string;
}

export interface CashConfirmationResult {
  collectionId: string;
  tripId: string;
  tripPassengerId: string;
  driverId: string;
  totalCashCollectedPaise: number;
  totalCashCollected: string;
  rideFarePaise: number;
  rideFare: string;
  waitingChargePaise: number;
  waitingCharge: string;
  surchargeFeesPaise: number;
  surchargeFees: string;
  collectedFeeIds: string[];
  paymentStatus: string;
  confirmedAt: string;
  paymentAllocations: PaymentAllocationItem[];
}

export interface FeeWaiverResult {
  feeId: string;
  passengerId: string;
  originalBookingId: string;
  amountPaise: number;
  amount: string;
  status: string;
  waivedByUserId: string | null;
  waiverReason: string | null;
  waivedAt: string | null;
  alreadyWaived?: boolean;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

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
   * Driver confirms physical cash collection upon passenger drop-off.
   * Atomically records cash collection, creates payment allocations,
   * marks outstanding cancellation fees as COLLECTED, and verifies amount exactness.
   */
  async confirmCash(
    driverUserId: string,
    dto: ConfirmCashDto,
    claim?: IdempotencyClaimContext,
  ): Promise<CashConfirmationResult> {
    const driver = await this.getVerifiedDriverProfile(driverUserId);

    return this.prisma.$transaction(async (tx) => {
      // 1. Verify claim ownership and lock idempotency record
      await verifyIdempotencyClaim(tx, claim);

      // 2. Lock trip row with SELECT ... FOR UPDATE
      const trips = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          active_driver_id: string;
        }>
      >`
        SELECT id, status, active_driver_id
        FROM trips
        WHERE id = ${dto.tripId}::uuid
        FOR UPDATE;
      `;

      if (!trips || trips.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_NOT_FOUND',
          message: `Trip with ID ${dto.tripId} not found.`,
        });
      }

      const trip = trips[0];

      if (trip.active_driver_id !== driver.id) {
        throw new ForbiddenException({
          errorCode: 'DRIVER_NOT_ASSIGNED_TO_TRIP',
          message: 'Calling driver is not assigned to this trip.',
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
          final_ride_fare_paise: number;
          waiting_charge_paise: number;
        }>
      >`
        SELECT id, trip_id, passenger_id, booking_id, status, final_ride_fare_paise, waiting_charge_paise
        FROM trip_passengers
        WHERE id = ${dto.tripPassengerId}::uuid
        FOR UPDATE;
      `;

      if (!passengers || passengers.length === 0) {
        throw new NotFoundException({
          errorCode: 'TRIP_PASSENGER_NOT_FOUND',
          message: `Trip passenger with ID ${dto.tripPassengerId} not found.`,
        });
      }

      const passenger = passengers[0];

      if (passenger.trip_id !== trip.id) {
        throw new BadRequestException({
          errorCode: 'PASSENGER_NOT_ON_TRIP',
          message: 'Trip passenger does not belong to the specified trip.',
        });
      }

      // 4. Validate passenger lifecycle status: cash collection permitted only once drop-off is complete
      if (passenger.status !== 'COMPLETED') {
        throw new BadRequestException({
          errorCode: 'INVALID_PASSENGER_STATUS_FOR_COLLECTION',
          message: `Cash collection is only permitted for completed passenger journeys (current status: '${passenger.status}').`,
        });
      }

      // 5. Check if collection was already recorded for this passenger journey (Invariant 7: single collection per journey)
      const existingCollection = await tx.cashCollection.findUnique({
        where: { tripPassengerId: passenger.id },
      });

      if (existingCollection) {
        throw new ConflictException({
          errorCode: 'CASH_ALREADY_COLLECTED',
          message:
            'Cash collection has already been confirmed for this passenger journey.',
        });
      }

      // 6. Lock and retrieve all outstanding cancellation fees for this passenger
      const outstandingFees = await tx.$queryRaw<
        Array<{
          id: string;
          amount_paise: number;
        }>
      >`
        SELECT id, amount_paise
        FROM cancellation_fees
        WHERE passenger_id = ${passenger.passenger_id}::uuid
          AND status = 'OUTSTANDING'
        ORDER BY created_at ASC
        FOR UPDATE;
      `;

      const feeSurchargePaise = outstandingFees.reduce(
        (sum, f) => sum + f.amount_paise,
        0,
      );

      // 7. Authoritative backend calculation of payable amount
      const expectedTotalPaise =
        passenger.final_ride_fare_paise +
        passenger.waiting_charge_paise +
        feeSurchargePaise;

      // Reject arbitrary driver input if it does not equal the authoritative calculation
      if (dto.amountCollectedPaise !== expectedTotalPaise) {
        throw new BadRequestException({
          errorCode: 'INVALID_COLLECTION_AMOUNT',
          message: `Collected amount (${dto.amountCollectedPaise} paise) does not match expected payable total (${expectedTotalPaise} paise).`,
        });
      }

      // 8. Atomic insertion of CashCollection record
      const now = new Date();
      const cashCollection = await tx.cashCollection.create({
        data: {
          tripId: trip.id,
          driverId: driver.id,
          tripPassengerId: passenger.id,
          totalCashCollectedPaise: expectedTotalPaise,
          paymentStatus: 'PAID',
          confirmedAt: now,
        },
      });

      // 9. Atomic insertion of PaymentAllocation records and update of cancellation_fees
      const allocations: PaymentAllocationItem[] = [];

      // A. Ride fare allocation
      if (passenger.final_ride_fare_paise > 0) {
        const alloc = await tx.paymentAllocation.create({
          data: {
            cashCollectionId: cashCollection.id,
            obligationType: 'RIDE_FARE',
            obligationEntityId: passenger.id,
            allocatedAmountPaise: passenger.final_ride_fare_paise,
            allocatedAt: now,
          },
        });
        allocations.push({
          id: alloc.id,
          obligationType: alloc.obligationType,
          obligationEntityId: alloc.obligationEntityId,
          allocatedAmountPaise: alloc.allocatedAmountPaise,
          allocatedAmount: (alloc.allocatedAmountPaise / 100).toFixed(2),
        });
      }

      // B. Waiting charge allocation (if > 0)
      if (passenger.waiting_charge_paise > 0) {
        const alloc = await tx.paymentAllocation.create({
          data: {
            cashCollectionId: cashCollection.id,
            obligationType: 'WAITING_CHARGE',
            obligationEntityId: passenger.id,
            allocatedAmountPaise: passenger.waiting_charge_paise,
            allocatedAt: now,
          },
        });
        allocations.push({
          id: alloc.id,
          obligationType: alloc.obligationType,
          obligationEntityId: alloc.obligationEntityId,
          allocatedAmountPaise: alloc.allocatedAmountPaise,
          allocatedAmount: (alloc.allocatedAmountPaise / 100).toFixed(2),
        });
      }

      // C. Cancellation fee surcharge allocations and fee status update
      for (const fee of outstandingFees) {
        const alloc = await tx.paymentAllocation.create({
          data: {
            cashCollectionId: cashCollection.id,
            obligationType: 'CANCELLATION_FEE_SURCHARGE',
            obligationEntityId: fee.id,
            allocatedAmountPaise: fee.amount_paise,
            allocatedAt: now,
          },
        });
        allocations.push({
          id: alloc.id,
          obligationType: alloc.obligationType,
          obligationEntityId: alloc.obligationEntityId,
          allocatedAmountPaise: alloc.allocatedAmountPaise,
          allocatedAmount: (alloc.allocatedAmountPaise / 100).toFixed(2),
        });

        // Atomically update cancellation fee to COLLECTED
        await tx.cancellationFee.update({
          where: { id: fee.id },
          data: {
            status: 'COLLECTED',
            collectedBookingId: passenger.booking_id,
            collectedAt: now,
          },
        });
      }

      // 10. Emit Transactional Outbox Event
      await tx.outboxEvent.create({
        data: {
          eventType: 'CASH_PAYMENT_CONFIRMED',
          aggregateType: 'CASH_COLLECTION',
          aggregateId: cashCollection.id,
          payload: {
            cashCollectionId: cashCollection.id,
            tripId: trip.id,
            driverId: driver.id,
            tripPassengerId: passenger.id,
            bookingId: passenger.booking_id,
            passengerId: passenger.passenger_id,
            totalCashCollectedPaise: expectedTotalPaise,
            rideFarePaise: passenger.final_ride_fare_paise,
            waitingChargePaise: passenger.waiting_charge_paise,
            surchargeFeesPaise: feeSurchargePaise,
            collectedFeeIds: outstandingFees.map((f) => f.id),
            confirmedAt: now.toISOString(),
          },
        },
      });

      const collectionResult: CashConfirmationResult = {
        collectionId: cashCollection.id,
        tripId: trip.id,
        tripPassengerId: passenger.id,
        driverId: driver.id,
        totalCashCollectedPaise: expectedTotalPaise,
        totalCashCollected: (expectedTotalPaise / 100).toFixed(2),
        rideFarePaise: passenger.final_ride_fare_paise,
        rideFare: (passenger.final_ride_fare_paise / 100).toFixed(2),
        waitingChargePaise: passenger.waiting_charge_paise,
        waitingCharge: (passenger.waiting_charge_paise / 100).toFixed(2),
        surchargeFeesPaise: feeSurchargePaise,
        surchargeFees: (feeSurchargePaise / 100).toFixed(2),
        collectedFeeIds: outstandingFees.map((f) => f.id),
        paymentStatus: cashCollection.paymentStatus,
        confirmedAt: now.toISOString(),
        paymentAllocations: allocations,
      };

      const responsePayload = {
        success: true,
        message: 'Cash payment confirmed successfully',
        data: collectionResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return collectionResult;
    });
  }

  /**
   * Admin waives an outstanding cancellation fee.
   * Updates fee status to WAIVED, records audit metadata (waived_by, reason, waived_at),
   * keeps existing waiver metadata immutable, and emits CANCELLATION_FEE_WAIVED outbox event.
   */
  async waiveCancellationFee(
    adminUserId: string,
    feeId: string,
    dto: WaiveCancellationFeeDto,
  ): Promise<FeeWaiverResult> {
    const reason = dto.waiverReason?.trim();
    if (!reason) {
      throw new BadRequestException({
        errorCode: 'INVALID_WAIVER_REASON',
        message: 'A non-empty waiver reason is required.',
      });
    }

    const admin = await this.prisma.user.findUnique({
      where: { id: adminUserId },
    });

    if (!admin || admin.role !== 'ADMIN') {
      throw new ForbiddenException({
        errorCode: 'ADMIN_PRIVILEGES_REQUIRED',
        message: 'Only administrators can waive cancellation fees.',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Lock cancellation fee row with SELECT ... FOR UPDATE
      const fees = await tx.$queryRaw<
        Array<{
          id: string;
          passenger_id: string;
          original_booking_id: string;
          amount_paise: number;
          status: string;
          waived_by_user_id: string | null;
          waiver_reason: string | null;
          waived_at: Date | null;
        }>
      >`
        SELECT id, passenger_id, original_booking_id, amount_paise, status,
               waived_by_user_id, waiver_reason, waived_at
        FROM cancellation_fees
        WHERE id = ${feeId}::uuid
        FOR UPDATE;
      `;

      if (!fees || fees.length === 0) {
        throw new NotFoundException({
          errorCode: 'CANCELLATION_FEE_NOT_FOUND',
          message: `Cancellation fee with ID ${feeId} not found.`,
        });
      }

      const fee = fees[0];

      // 2. Safe repeated waiver handling: keep existing waiver metadata immutable
      if (fee.status === 'WAIVED') {
        this.logger.log(
          `Cancellation fee ${feeId} was already waived; returning existing immutable record.`,
        );
        return {
          feeId: fee.id,
          passengerId: fee.passenger_id,
          originalBookingId: fee.original_booking_id,
          amountPaise: fee.amount_paise,
          amount: (fee.amount_paise / 100).toFixed(2),
          status: 'WAIVED',
          waivedByUserId: fee.waived_by_user_id,
          waiverReason: fee.waiver_reason,
          waivedAt: fee.waived_at ? fee.waived_at.toISOString() : null,
          alreadyWaived: true,
        };
      }

      // 3. Rejection of already-settled fees
      if (fee.status === 'COLLECTED') {
        throw new BadRequestException({
          errorCode: 'FEE_ALREADY_COLLECTED',
          message:
            'Cannot waive a cancellation fee that has already been collected.',
        });
      }

      if (fee.status !== 'OUTSTANDING') {
        throw new BadRequestException({
          errorCode: 'INVALID_FEE_STATUS_FOR_WAIVER',
          message: `Only OUTSTANDING cancellation fees can be waived (current status: '${fee.status}').`,
        });
      }

      // 4. Update cancellation fee record
      const now = new Date();
      const updated = await tx.cancellationFee.update({
        where: { id: fee.id },
        data: {
          status: 'WAIVED',
          waivedByUserId: admin.id,
          waiverReason: reason,
          waivedAt: now,
        },
      });

      // 5. Emit Transactional Outbox Event
      await tx.outboxEvent.create({
        data: {
          eventType: 'CANCELLATION_FEE_WAIVED',
          aggregateType: 'CANCELLATION_FEE',
          aggregateId: fee.id,
          payload: {
            feeId: fee.id,
            passengerId: fee.passenger_id,
            originalBookingId: fee.original_booking_id,
            amountPaise: fee.amount_paise,
            waivedByUserId: admin.id,
            waiverReason: reason,
            waivedAt: now.toISOString(),
          },
        },
      });

      return {
        feeId: updated.id,
        passengerId: updated.passengerId,
        originalBookingId: updated.originalBookingId,
        amountPaise: updated.amountPaise,
        amount: (updated.amountPaise / 100).toFixed(2),
        status: updated.status,
        waivedByUserId: updated.waivedByUserId,
        waiverReason: updated.waiverReason,
        waivedAt: updated.waivedAt ? updated.waivedAt.toISOString() : null,
      };
    });
  }
}
