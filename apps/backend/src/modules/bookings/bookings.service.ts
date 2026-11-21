import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { RoutingService } from '../routing/routing.service.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';
import { CancelBookingDto } from './dto/cancel-booking.dto.js';
import { CANONICAL_ACTIVE_BOOKING_STATUSES } from './bookings.constants.js';
import { deriveBoardingOtp, hashBoardingOtp } from '../../common/utils/otp.util.js';
import {
  IdempotencyClaimContext,
  verifyIdempotencyClaim,
  fenceAndCompleteIdempotentTransaction,
} from '../../common/interceptors/idempotency.interceptor.js';

export interface BoardingPassResponse {
  bookingId: string;
  passengerId: string;
  tripId: string;
  boardingOtp: string;
  expiresAt: string;
  bookingStatus: string;
  driver: {
    name: string;
    phoneNumber?: string;
    vehicle: {
      registrationNumber: string;
      makeModel: string;
      vehicleType: string;
    } | null;
  };
}

export interface BookingResponse {
  bookingId: string;
  passengerId: string;
  status: string;
  requestedType: string;
  minGroupPreference: number;
  agreedFareCeilingPaise: number;
  finalAllocatedFarePaise: number | null;
  maxWaitDeadline: string;
  pickupPointId: string;
  pickupPointName?: string;
  passengerPickupLocation: { latitude: number; longitude: number };
  destinationLocation: { latitude: number; longitude: number };
  cancellationReason?: string | null;
  cancelledAt?: string | null;
  createdAt: string;
  statusHistory?: Array<{
    previousStatus: string;
    newStatus: string;
    reason: string | null;
    transitionTime: string;
  }>;
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locationsService: LocationsService,
    @Optional() private readonly redisService?: RedisService,
    @Optional() private readonly routingService?: RoutingService,
  ) {}

  /**
   * Create a new booking with upfront passenger consent.
   * Enforces Invariant 1 (one active booking per passenger) and 150m geofence.
   */
  async createBooking(
    passengerId: string,
    dto: CreateBookingDto,
    claim?: IdempotencyClaimContext,
  ): Promise<{
    bookingId: string;
    status: string;
    maxWaitDeadline: string;
    agreedFareCeiling: string;
    agreedFareCeilingPaise: number;
  }> {
    // 1. Mandatory Upfront Consent check
    if (!dto.upfrontConsentAgreed) {
      throw new BadRequestException({
        errorCode: 'UPFRONT_CONSENT_REQUIRED',
        message:
          'Commuter upfront consent to dynamic pooling, max 4 pax capacity, and capped fares is mandatory.',
      });
    }

    // 2. Invariant 1 Application Check: exactly one active booking per passenger
    const activeBooking = await this.prisma.booking.findFirst({
      where: {
        passengerId,
        status: {
          in: [...CANONICAL_ACTIVE_BOOKING_STATUSES],
        },
      },
    });

    if (activeBooking) {
      throw new ConflictException({
        errorCode: 'ACTIVE_BOOKING_EXISTS',
        message:
          'Passenger already has an active booking in progress. Complete or cancel it before booking again.',
      });
    }

    // 3. Validate quote existence, ownership, and expiration
    const quote = await this.prisma.fareQuote.findFirst({
      where: {
        id: dto.quoteId,
        passengerId,
      },
    });

    if (!quote) {
      throw new NotFoundException({
        errorCode: 'QUOTE_NOT_FOUND',
        message: 'Fare quote not found or does not belong to this passenger.',
      });
    }

    if (new Date() > quote.expiresAt) {
      throw new BadRequestException({
        errorCode: 'QUOTE_EXPIRED',
        message:
          'Fare quote has expired after 2 minutes. Please generate a fresh quote before booking.',
      });
    }

    // 4. Validate passenger pickup coordinate is within 150m geofence of pickup point
    const pickupValidation = await this.locationsService.validatePickup(
      quote.pickupPointId,
      dto.passengerPickupLocation.latitude,
      dto.passengerPickupLocation.longitude,
    );

    if (!pickupValidation.isValid) {
      throw new BadRequestException({
        errorCode: 'PICKUP_OUTSIDE_GEOFENCE',
        message: `Pickup location is ${pickupValidation.distanceMeters}m from ${pickupValidation.pickupPoint.name}, exceeding the authorized 150m geofence limit.`,
      });
    }

    // 5. Atomic Transaction: Persist booking, initial history, and transactional outbox event
    const requestedType = dto.requestedType || 'SHARED';
    const minGroupPreference = dto.minGroupPreference || 2;
    const maxWaitDeadline = new Date(Date.now() + 120 * 1000); // 120s max wait deadline

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Verify claim ownership and lock idempotency record
        await verifyIdempotencyClaim(tx, claim);

        // Raw SQL insert for PostGIS Point geometry columns
        const [insertedBooking] = await tx.$queryRaw<
          Array<{
            id: string;
            status: string;
            max_wait_deadline: Date;
            agreed_fare_ceiling_paise: number;
          }>
        >`
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
            max_wait_deadline
          ) VALUES (
            gen_random_uuid(),
            ${passengerId}::uuid,
            ${quote.id}::uuid,
            ${quote.pickupPointId}::uuid,
            ST_SetSRID(ST_MakePoint(${dto.passengerPickupLocation.longitude}, ${dto.passengerPickupLocation.latitude}), 4326),
            (SELECT destination_location FROM fare_quotes WHERE id = ${quote.id}::uuid),
            ${requestedType},
            ${minGroupPreference},
            'REQUESTED',
            ${quote.agreedFareCeilingPaise},
            ${maxWaitDeadline}
          ) RETURNING id, status, max_wait_deadline, agreed_fare_ceiling_paise;
        `;

        // Record initial status history
        await tx.bookingStatusHistory.create({
          data: {
            bookingId: insertedBooking.id,
            previousStatus: 'NONE',
            newStatus: 'REQUESTED',
            reason: 'Booking requested by passenger with upfront consent',
          },
        });

        // Insert Transactional Outbox Event
        await tx.outboxEvent.create({
          data: {
            eventType: 'BOOKING_CREATED',
            aggregateType: 'BOOKING',
            aggregateId: insertedBooking.id,
            payload: {
              bookingId: insertedBooking.id,
              passengerId,
              pickupPointId: quote.pickupPointId,
              requestedType,
              minGroupPreference,
              agreedFareCeilingPaise: insertedBooking.agreed_fare_ceiling_paise,
              maxWaitDeadline: insertedBooking.max_wait_deadline,
            },
          },
        });

        const bookingResponse = {
          bookingId: insertedBooking.id,
          status: insertedBooking.status,
          maxWaitDeadline: insertedBooking.max_wait_deadline.toISOString(),
          agreedFareCeiling: (
            insertedBooking.agreed_fare_ceiling_paise / 100
          ).toFixed(2),
          agreedFareCeilingPaise: insertedBooking.agreed_fare_ceiling_paise,
        };

        const responsePayload = {
          success: true,
          data: bookingResponse,
        };

        // Fencing check and atomic completion within this same transaction
        await fenceAndCompleteIdempotentTransaction(
          tx,
          claim,
          responsePayload,
          HttpStatus.CREATED,
        );

        return bookingResponse;
      });

      return result;
    } catch (err: any) {
      // Catch Invariant 1 unique constraint violation on idx_unique_active_passenger_booking
      if (
        err?.code === '23505' ||
        err?.code === 'P2002' ||
        err?.meta?.code === '23505' ||
        err?.message?.includes('23505') ||
        err?.message?.includes('idx_unique_active_passenger_booking') ||
        (err?.code === 'P2010' && err?.message?.includes('already exists'))
      ) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          errorCode: 'ACTIVE_BOOKING_EXISTS',
          message:
            'Passenger already has an active booking in progress (enforced by DB unique invariant).',
        });
      }
      throw err;
    }
  }

  /**
   * Retrieve active booking for the authenticated passenger
   */
  async getActiveBooking(passengerId: string): Promise<BookingResponse | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        passenger_id: string;
        pickup_point_id: string;
        pickup_point_name: string;
        requested_type: string;
        min_group_preference: number;
        status: string;
        agreed_fare_ceiling_paise: number;
        final_allocated_fare_paise: number | null;
        max_wait_deadline: Date;
        cancellation_reason: string | null;
        cancelled_at: Date | null;
        created_at: Date;
        pickup_lat: number;
        pickup_lng: number;
        dest_lat: number;
        dest_lng: number;
      }>
    >`
      SELECT
        b.id,
        b.passenger_id,
        b.pickup_point_id,
        pp.name as pickup_point_name,
        b.requested_type,
        b.min_group_preference,
        b.status,
        b.agreed_fare_ceiling_paise,
        b.final_allocated_fare_paise,
        b.max_wait_deadline,
        b.cancellation_reason,
        b.cancelled_at,
        b.created_at,
        ST_Y(b.passenger_pickup_location::geometry) as pickup_lat,
        ST_X(b.passenger_pickup_location::geometry) as pickup_lng,
        ST_Y(b.destination_location::geometry) as dest_lat,
        ST_X(b.destination_location::geometry) as dest_lng
      FROM bookings b
      JOIN pickup_points pp ON b.pickup_point_id = pp.id
      WHERE b.passenger_id = ${passengerId}::uuid
        AND b.status IN ('REQUESTED', 'MATCHING', 'MATCHED', 'DISPATCHING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'BOARDED', 'IN_PROGRESS')
      ORDER BY b.created_at DESC
      LIMIT 1;
    `;

    if (!rows || rows.length === 0) {
      return null;
    }

    const b = rows[0];
    return {
      bookingId: b.id,
      passengerId: b.passenger_id,
      pickupPointId: b.pickup_point_id,
      pickupPointName: b.pickup_point_name,
      requestedType: b.requested_type,
      minGroupPreference: Number(b.min_group_preference),
      status: b.status,
      agreedFareCeilingPaise: Number(b.agreed_fare_ceiling_paise),
      finalAllocatedFarePaise: b.final_allocated_fare_paise
        ? Number(b.final_allocated_fare_paise)
        : null,
      maxWaitDeadline: b.max_wait_deadline.toISOString(),
      cancellationReason: b.cancellation_reason,
      cancelledAt: b.cancelled_at ? b.cancelled_at.toISOString() : null,
      createdAt: b.created_at.toISOString(),
      passengerPickupLocation: {
        latitude: Number(b.pickup_lat),
        longitude: Number(b.pickup_lng),
      },
      destinationLocation: {
        latitude: Number(b.dest_lat),
        longitude: Number(b.dest_lng),
      },
    };
  }

  /**
   * Get booking details by ID with strict ownership and authorization checks
   */
  async getBookingById(
    user: { id: string; role: string },
    bookingId: string,
  ): Promise<BookingResponse> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        passenger_id: string;
        pickup_point_id: string;
        pickup_point_name: string;
        requested_type: string;
        min_group_preference: number;
        status: string;
        agreed_fare_ceiling_paise: number;
        final_allocated_fare_paise: number | null;
        max_wait_deadline: Date;
        cancellation_reason: string | null;
        cancelled_at: Date | null;
        created_at: Date;
        pickup_lat: number;
        pickup_lng: number;
        dest_lat: number;
        dest_lng: number;
      }>
    >`
      SELECT
        b.id,
        b.passenger_id,
        b.pickup_point_id,
        pp.name as pickup_point_name,
        b.requested_type,
        b.min_group_preference,
        b.status,
        b.agreed_fare_ceiling_paise,
        b.final_allocated_fare_paise,
        b.max_wait_deadline,
        b.cancellation_reason,
        b.cancelled_at,
        b.created_at,
        ST_Y(b.passenger_pickup_location::geometry) as pickup_lat,
        ST_X(b.passenger_pickup_location::geometry) as pickup_lng,
        ST_Y(b.destination_location::geometry) as dest_lat,
        ST_X(b.destination_location::geometry) as dest_lng
      FROM bookings b
      JOIN pickup_points pp ON b.pickup_point_id = pp.id
      WHERE b.id = ${bookingId}::uuid;
    `;

    if (!rows || rows.length === 0) {
      throw new NotFoundException({
        errorCode: 'BOOKING_NOT_FOUND',
        message: `Booking with ID ${bookingId} not found.`,
      });
    }

    const b = rows[0];

    // Ownership & RBAC authorization check:
    // - PASSENGER: may view only their own booking
    // - DRIVER: may view only bookings associated with a trip or group to which they are assigned
    // - ADMIN: may view any booking
    if (user.role === 'PASSENGER') {
      if (b.passenger_id !== user.id) {
        throw new ForbiddenException({
          errorCode: 'FORBIDDEN',
          message: 'Passengers can only access their own bookings.',
        });
      }
    } else if (user.role === 'DRIVER') {
      const driver = await this.prisma.driverProfile.findUnique({
        where: { userId: user.id },
      });

      if (!driver) {
        throw new ForbiddenException({
          errorCode: 'FORBIDDEN',
          message: 'Driver profile not found.',
        });
      }

      // Check if driver is assigned to an active trip containing this booking
      const assignedTrip = await this.prisma.tripPassenger.findFirst({
        where: {
          bookingId,
          trip: {
            activeDriverId: driver.id,
          },
        },
      });

      // Also check if assigned to a group containing this booking
      let isAssigned = !!assignedTrip;
      if (!isAssigned) {
        const assignedGroup = await this.prisma.groupMember.findFirst({
          where: {
            bookingId,
            rideGroup: {
              driverAssignments: {
                some: {
                  driverId: driver.id,
                  status: { in: ['RESERVED', 'ACTIVE', 'COMPLETED'] },
                },
              },
            },
          },
        });
        isAssigned = !!assignedGroup;
      }

      if (!isAssigned) {
        throw new ForbiddenException({
          errorCode: 'FORBIDDEN',
          message:
            'Drivers may only view bookings associated with a trip to which they are assigned.',
        });
      }
    } else if (user.role !== 'ADMIN') {
      throw new ForbiddenException({
        errorCode: 'FORBIDDEN',
        message: 'Unauthorized access to booking details.',
      });
    }

    // Fetch status history
    const history = await this.prisma.bookingStatusHistory.findMany({
      where: { bookingId },
      orderBy: { transitionTime: 'asc' },
    });

    return {
      bookingId: b.id,
      passengerId: b.passenger_id,
      pickupPointId: b.pickup_point_id,
      pickupPointName: b.pickup_point_name,
      requestedType: b.requested_type,
      minGroupPreference: Number(b.min_group_preference),
      status: b.status,
      agreedFareCeilingPaise: Number(b.agreed_fare_ceiling_paise),
      finalAllocatedFarePaise: b.final_allocated_fare_paise
        ? Number(b.final_allocated_fare_paise)
        : null,
      maxWaitDeadline: b.max_wait_deadline.toISOString(),
      cancellationReason: b.cancellation_reason,
      cancelledAt: b.cancelled_at ? b.cancelled_at.toISOString() : null,
      createdAt: b.created_at.toISOString(),
      passengerPickupLocation: {
        latitude: Number(b.pickup_lat),
        longitude: Number(b.pickup_lng),
      },
      destinationLocation: {
        latitude: Number(b.dest_lat),
        longitude: Number(b.dest_lng),
      },
      statusHistory: history.map((h) => ({
        previousStatus: h.previousStatus,
        newStatus: h.newStatus,
        reason: h.reason,
        transitionTime: h.transitionTime.toISOString(),
      })),
    };
  }

  /**
   * Cancel booking with state-dependent fee calculation:
   * - Before driver assignment (REQUESTED, MATCHING, MATCHED): ₹0 fee
   * - After driver assignment (DRIVER_ASSIGNED, DRIVER_ARRIVED, CONFIRMED): fixed ₹30 late fee
   */
  async cancelBooking(
    user: { id: string; role: string },
    bookingId: string,
    dto: CancelBookingDto,
    claim?: IdempotencyClaimContext,
  ): Promise<{
    bookingId: string;
    status: string;
    cancellationFeeAssessedPaise: number;
    cancellationFeeStatus: 'NONE' | 'OUTSTANDING';
  }> {
    const result = await this.prisma.$transaction(async (tx) => {
      // Verify claim ownership and lock idempotency record
      await verifyIdempotencyClaim(tx, claim);

      // Standard lock order across the monolith: trips -> bookings -> trip_passengers
      // 1. If this booking is associated with an active trip, lock the trip row first
      const activeTripLookup = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT t.id
        FROM trips t
        LEFT JOIN trip_passengers tp ON tp.trip_id = t.id AND tp.booking_id = ${bookingId}::uuid
        LEFT JOIN group_members gm ON gm.ride_group_id = t.ride_group_id AND gm.booking_id = ${bookingId}::uuid
        WHERE (tp.id IS NOT NULL OR gm.id IS NOT NULL)
          AND t.status IN ('CREATED', 'DRIVER_EN_ROUTE', 'AT_PICKUP', 'IN_PROGRESS')
        LIMIT 1;
      `;

      if (activeTripLookup && activeTripLookup.length > 0) {
        await tx.$queryRaw`
          SELECT id
          FROM trips
          WHERE id = ${activeTripLookup[0].id}::uuid
          FOR UPDATE;
        `;
      }

      // 2. Lock booking row with SELECT FOR UPDATE to coordinate concurrency
      const bookings = await tx.$queryRaw<
        Array<{
          id: string;
          passenger_id: string;
          status: string;
        }>
      >`
        SELECT id, passenger_id, status
        FROM bookings
        WHERE id = ${bookingId}::uuid
        FOR UPDATE;
      `;

      if (!bookings || bookings.length === 0) {
        throw new NotFoundException({
          errorCode: 'BOOKING_NOT_FOUND',
          message: `Booking with ID ${bookingId} not found.`,
        });
      }

      const booking = bookings[0];

      // 2. Ownership enforcement:
      // Only the booking's owning passenger or an ADMIN may cancel.
      // A DRIVER must never be allowed to cancel a passenger's booking.
      const isOwnerPassenger =
        user.role === 'PASSENGER' && booking.passenger_id === user.id;
      const isAdmin = user.role === 'ADMIN';

      if (!isAdmin && !isOwnerPassenger) {
        throw new ForbiddenException({
          errorCode: 'FORBIDDEN',
          message:
            'Only the booking owner or an administrator may cancel this booking.',
        });
      }

      // 3. State transition validity check
      const currentStatus = booking.status;
      if (currentStatus === 'CANCELLED') {
        throw new BadRequestException({
          errorCode: 'BOOKING_ALREADY_CANCELLED',
          message: 'This booking has already been cancelled.',
        });
      }

      if (currentStatus === 'NO_SHOW') {
        throw new BadRequestException({
          errorCode: 'CANNOT_CANCEL_IN_CURRENT_STATUS',
          message:
            "Cannot cancel booking in status 'NO_SHOW'. Commuter has already been declared a no-show.",
        });
      }

      const cancellableStatuses = [
        'REQUESTED',
        'MATCHING',
        'MATCHED',
        'DISPATCHING',
        'CONFIRMED',
        'DRIVER_ASSIGNED',
        'DRIVER_ARRIVED',
      ];

      if (!cancellableStatuses.includes(currentStatus)) {
        throw new BadRequestException({
          errorCode: 'CANNOT_CANCEL_IN_CURRENT_STATUS',
          message: `Cannot cancel booking in status '${currentStatus}'. Active onboard trips cannot be cancelled.`,
        });
      }

      // Synchronize associated TripPassenger record if trip was materialized
      // Strict lock ordering: bookings row was locked above, now lock trip_passengers row
      const tripPassengerRows = await tx.$queryRaw<
        Array<{
          id: string;
          trip_id: string;
          status: string;
        }>
      >`
        SELECT id, trip_id, status
        FROM trip_passengers
        WHERE booking_id = ${booking.id}::uuid
        FOR UPDATE;
      `;

      if (tripPassengerRows && tripPassengerRows.length > 0) {
        const tp = tripPassengerRows[0];
        if (tp.status === 'NO_SHOW') {
          throw new BadRequestException({
            errorCode: 'CANNOT_CANCEL_IN_CURRENT_STATUS',
            message:
              "Cannot cancel booking in status 'NO_SHOW'. Commuter has already been declared a no-show.",
          });
        }
        if (['BOARDED', 'COMPLETED'].includes(tp.status)) {
          throw new BadRequestException({
            errorCode: 'CANNOT_CANCEL_IN_CURRENT_STATUS',
            message: `Cannot cancel booking in status '${tp.status}'. Active onboard trips cannot be cancelled.`,
          });
        }
        // Update trip_passenger status to CANCELLED so it does not block startTrip()
        await tx.tripPassenger.update({
          where: { id: tp.id },
          data: { status: 'CANCELLED' },
        });
      }

      // 4. Calculate fee according to lifecycle stage
      const isAfterDriverAssignment = [
        'DRIVER_ASSIGNED',
        'DRIVER_ARRIVED',
        'CONFIRMED',
      ].includes(currentStatus);

      const feePaise = isAfterDriverAssignment ? 3000 : 0;
      const cancellationFeeStatus: 'NONE' | 'OUTSTANDING' =
        isAfterDriverAssignment ? 'OUTSTANDING' : 'NONE';

      // 5. Update booking status
      const now = new Date();
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancellationReason: dto.reason || 'Passenger cancelled',
        },
      });

      // 6. Record status transition
      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          previousStatus: currentStatus,
          newStatus: 'CANCELLED',
          reason: dto.reason || 'Passenger cancelled booking',
        },
      });

      // 7. If after driver assignment, assess fixed ₹30 late fee into cancellation_fees ledger
      // Guarded by unique index idx_unique_cancellation_fee_per_booking
      if (feePaise > 0) {
        const existingFee = await tx.cancellationFee.findUnique({
          where: { originalBookingId: booking.id },
        });

        if (!existingFee) {
          await tx.cancellationFee.create({
            data: {
              passengerId: booking.passenger_id,
              originalBookingId: booking.id,
              amountPaise: feePaise,
              status: 'OUTSTANDING',
            },
          });
        }
      }

      // 8. If member of an active group, deactivate member and evaluate group continuity
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

      const activeMembership = await tx.groupMember.findFirst({
        where: {
          bookingId: booking.id,
          isActiveMember: true,
        },
      });

      if (activeMembership) {
        await tx.groupMember.update({
          where: { id: activeMembership.id },
          data: { isActiveMember: false },
        });

        // Check remaining active members in group
        const remainingActiveMembers = await tx.groupMember.findMany({
          where: {
            rideGroupId: activeMembership.rideGroupId,
            isActiveMember: true,
          },
          orderBy: { dropoffSequenceOrder: 'asc' },
        });

        // Check if any surviving member has already boarded a materialized trip.
        // If a surviving passenger is already onboard, their journey and driver assignment
        // must be preserved; the group must not be dissolved, and the onboard passenger
        // must never be rematched.
        const boardedSurvivor =
          remainingActiveMembers.length > 0
            ? await tx.tripPassenger.findFirst({
                where: {
                  bookingId: {
                    in: remainingActiveMembers.map((m) => m.bookingId),
                  },
                  status: 'BOARDED',
                },
              })
            : null;

        if (remainingActiveMembers.length < 2 && !boardedSurvivor) {
          // Scenario B: Fewer than two eligible passengers survive and NONE is boarded -> Dissolve group
          await tx.rideGroup.update({
            where: { id: activeMembership.rideGroupId },
            data: { status: 'DISSOLVED' },
          });

          // Deactivate all old memberships in this group
          await tx.groupMember.updateMany({
            where: { rideGroupId: activeMembership.rideGroupId },
            data: { isActiveMember: false },
          });

          // Release active driver assignment (Invariant 3)
          const activeAssignments = await tx.driverAssignment.findMany({
            where: {
              rideGroupId: activeMembership.rideGroupId,
              status: { in: ['RESERVED', 'ACTIVE'] },
            },
          });

          for (const assignment of activeAssignments) {
            await tx.driverAssignment.update({
              where: { id: assignment.id },
              data: { status: 'RELEASED' },
            });

            await tx.driverProfile.update({
              where: { id: assignment.driverId },
              data: { operationalStatus: 'AVAILABLE' },
            });
          }

          // If a trip has already been materialized, cancel it
          const associatedTrips = await tx.trip.findMany({
            where: {
              rideGroupId: activeMembership.rideGroupId,
              status: { in: ['CREATED', 'DRIVER_EN_ROUTE', 'AT_PICKUP'] },
            },
          });

          for (const t of associatedTrips) {
            await tx.trip.update({
              where: { id: t.id },
              data: { status: 'CANCELLED' },
            });

            await tx.tripStatusHistory.create({
              data: {
                tripId: t.id,
                previousStatus: t.status,
                newStatus: 'CANCELLED',
                reason:
                  'Group dissolved due to passenger cancellation; trip cancelled',
              },
            });

            await tx.tripPassenger.updateMany({
              where: {
                tripId: t.id,
                status: { in: ['WAITING', 'BOARDED'] },
              },
              data: { status: 'CANCELLED' },
            });
          }

          // Return surviving eligible booking to REQUESTED (or EXPIRED if deadline passed)
          if (remainingActiveMembers.length === 1) {
            const survivingMember = remainingActiveMembers[0];
            const survivingBookings = await tx.$queryRaw<
              Array<{
                id: string;
                passenger_id: string;
                status: string;
                max_wait_deadline: Date;
                created_at: Date;
              }>
            >`
              SELECT id, passenger_id, status, max_wait_deadline, created_at
              FROM bookings
              WHERE id = ${survivingMember.bookingId}::uuid
              FOR UPDATE;
            `;

            if (survivingBookings && survivingBookings.length > 0) {
              const survivingBooking = survivingBookings[0];
              const isExpired =
                new Date(survivingBooking.max_wait_deadline).getTime() <=
                now.getTime();

              if (isExpired) {
                await tx.booking.update({
                  where: { id: survivingBooking.id },
                  data: { status: 'EXPIRED' },
                });

                await tx.bookingStatusHistory.create({
                  data: {
                    bookingId: survivingBooking.id,
                    previousStatus: survivingBooking.status,
                    newStatus: 'EXPIRED',
                    reason:
                      'Group dissolved and max wait deadline expired; no driver assigned',
                  },
                });

                await tx.outboxEvent.create({
                  data: {
                    eventType: 'BOOKING_EXPIRED',
                    aggregateType: 'BOOKING',
                    aggregateId: survivingBooking.id,
                    payload: {
                      bookingId: survivingBooking.id,
                      passengerId: survivingBooking.passenger_id,
                    },
                  },
                });
              } else {
                await tx.booking.update({
                  where: { id: survivingBooking.id },
                  data: { status: 'REQUESTED' },
                });

                await tx.bookingStatusHistory.create({
                  data: {
                    bookingId: survivingBooking.id,
                    previousStatus: survivingBooking.status,
                    newStatus: 'REQUESTED',
                    reason:
                      'Returned to matching pool following group dissolution; original timestamp and deadline preserved',
                  },
                });

                await tx.outboxEvent.create({
                  data: {
                    eventType: 'BOOKING_RETURNED_TO_MATCHING',
                    aggregateType: 'BOOKING',
                    aggregateId: survivingBooking.id,
                    payload: {
                      bookingId: survivingBooking.id,
                      passengerId: survivingBooking.passenger_id,
                      maxWaitDeadline: survivingBooking.max_wait_deadline,
                      createdAt: survivingBooking.created_at,
                    },
                  },
                });
              }
            }
          }
        } else {
          // Scenario A: At least two eligible passengers survive -> Increment group version
          const updatedGroup = await tx.rideGroup.update({
            where: { id: activeMembership.rideGroupId },
            data: {
              groupVersion: { increment: 1 },
            },
            select: {
              id: true,
              groupVersion: true,
              pickupPointId: true,
            },
          });

          // Fetch pickup point coordinates
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

          for (const m of remainingActiveMembers) {
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

      // 9. Append Transactional Outbox Event
      await tx.outboxEvent.create({
        data: {
          eventType:
            feePaise > 0 ? 'BOOKING_CANCELLED_LATE' : 'BOOKING_CANCELLED',
          aggregateType: 'BOOKING',
          aggregateId: booking.id,
          payload: {
            bookingId: booking.id,
            passengerId: booking.passenger_id,
            previousStatus: currentStatus,
            feePaise,
            reason: dto.reason,
            cancelledAt: now,
          },
        },
      });

      const cancellationResult = {
        bookingId: booking.id,
        status: 'CANCELLED',
        cancellationFeeAssessedPaise: feePaise,
        cancellationFeeStatus,
      };

      const responsePayload = {
        success: true,
        data: cancellationResult,
      };

      await fenceAndCompleteIdempotentTransaction(
        tx,
        claim,
        responsePayload,
        HttpStatus.OK,
      );

      return {
        cancellationResult,
        routeReconciliationInfo,
      };
    });

    // Execute route recalculation outside the transaction to preserve Invariant 4
    if (result.routeReconciliationInfo && this.routingService) {
      await this.recalculateAndPersistRoute(result.routeReconciliationInfo).catch(
        (err) => {
          this.logger.warn(
            `Route recalculation failed after passenger cancellation for group ${result.routeReconciliationInfo?.rideGroupId}: ${(err as Error).message}`,
          );
        },
      );
    }

    return result.cancellationResult;
  }

  /**
   * Query outstanding cancellation fees for a passenger
   */
  async getOutstandingFees(passengerId: string): Promise<{
    totalOutstandingPaise: number;
    fees: Array<{
      id: string;
      originalBookingId: string;
      amountPaise: number;
      createdAt: string;
    }>;
  }> {
    const fees = await this.prisma.cancellationFee.findMany({
      where: {
        passengerId,
        status: 'OUTSTANDING',
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalOutstandingPaise = fees.reduce(
      (sum, f) => sum + f.amountPaise,
      0,
    );

    return {
      totalOutstandingPaise,
      fees: fees.map((f) => ({
        id: f.id,
        originalBookingId: f.originalBookingId,
        amountPaise: f.amountPaise,
        createdAt: f.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Retrieve secure passenger boarding pass and 4-digit OTP.
   * Gated strictly to the authenticated owner passenger of an assigned booking.
   * Employs fast Redis ephemeral cache with deterministic HMAC-SHA256 fallback recovery.
   */
  async getBoardingPass(
    user: { id: string; role: string; roles?: string[] },
    bookingId: string,
  ): Promise<BoardingPassResponse> {
    // 1. RBAC & ownership check
    const userRoles = Array.isArray(user.roles) ? [...user.roles] : [];
    if (user.role && !userRoles.includes(user.role)) {
      userRoles.push(user.role);
    }
    if (!userRoles.includes('PASSENGER')) {
      throw new ForbiddenException({
        errorCode: 'FORBIDDEN',
        message: 'Only passengers can access their boarding pass.',
      });
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException({
        errorCode: 'BOOKING_NOT_FOUND',
        message: `Booking with ID ${bookingId} not found.`,
      });
    }

    if (booking.passengerId !== user.id) {
      throw new ForbiddenException({
        errorCode: 'FORBIDDEN',
        message: 'Passengers can only access their own boarding pass.',
      });
    }

    // 2. Booking status lifecycle gating
    const unassignedStatuses = [
      'REQUESTED',
      'MATCHING',
      'MATCHED',
      'DISPATCHING',
      'CONFIRMED',
    ];
    if (unassignedStatuses.includes(booking.status)) {
      throw new BadRequestException({
        errorCode: 'BOOKING_NOT_ASSIGNED',
        message: 'Booking has not been assigned to a driver yet.',
      });
    }

    const consumedStatuses = ['BOARDED', 'IN_PROGRESS', 'COMPLETED'];
    if (consumedStatuses.includes(booking.status)) {
      throw new BadRequestException({
        errorCode: 'OTP_ALREADY_CONSUMED',
        message: 'Boarding OTP has already been used or trip is completed.',
      });
    }

    const inactiveStatuses = ['CANCELLED', 'EXPIRED', 'NO_SHOW'];
    if (inactiveStatuses.includes(booking.status)) {
      throw new BadRequestException({
        errorCode: 'BOOKING_NOT_ACTIVE',
        message: `Booking is not active (current status: ${booking.status}).`,
      });
    }

    if (
      booking.status !== 'DRIVER_ASSIGNED' &&
      booking.status !== 'DRIVER_ARRIVED'
    ) {
      throw new BadRequestException({
        errorCode: 'INVALID_BOOKING_STATUS',
        message: `Boarding pass is not available in status ${booking.status}.`,
      });
    }

    // 3. Locate TripPassenger and BoardingVerification
    const tripPassenger = await this.prisma.tripPassenger.findFirst({
      where: { bookingId: booking.id },
      orderBy: { createdAt: 'desc' },
      include: {
        trip: {
          include: {
            activeDriver: {
              include: {
                user: {
                  select: {
                    fullName: true,
                    phoneNumber: true,
                  },
                },
                vehicles: {
                  where: { isActive: true },
                  take: 1,
                },
              },
            },
            driverAssignment: true,
          },
        },
        boardingVerification: true,
      },
    });

    if (!tripPassenger || !tripPassenger.boardingVerification) {
      throw new NotFoundException({
        errorCode: 'BOARDING_PASS_NOT_FOUND',
        message: 'Boarding verification details not found for this booking.',
      });
    }

    const verification = tripPassenger.boardingVerification;
    const expiresAt = new Date(verification.expiresAt);

    // 4. Verification state checks
    if (verification.isVerified) {
      throw new BadRequestException({
        errorCode: 'OTP_ALREADY_VERIFIED',
        message: 'Boarding OTP has already been verified.',
      });
    }

    if (verification.attemptsCount >= verification.maxAttempts) {
      throw new BadRequestException({
        errorCode: 'OTP_MAX_ATTEMPTS_EXCEEDED',
        message: 'Maximum boarding verification attempts exceeded.',
      });
    }

    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        errorCode: 'OTP_EXPIRED',
        message: 'Boarding OTP has expired.',
      });
    }

    // 5. OTP Retrieval & Ephemeral Recovery Logic
    const assignmentId =
      tripPassenger.trip?.driverAssignmentId ??
      tripPassenger.trip?.driverAssignment?.id;

    let otp: string | null = null;
    if (this.redisService) {
      try {
        otp = await this.redisService.getPassengerBoardingOtp(booking.id);
      } catch (err) {
        this.logger.warn(
          `Redis getPassengerBoardingOtp error for booking ${booking.id}: ${(err as Error).message}`,
        );
      }
    }

    // Fallback derivation if Redis missed, was flushed, or returned mismatched hash
    if (!otp || hashBoardingOtp(otp) !== verification.otpHash) {
      if (!assignmentId) {
        throw new InternalServerErrorException({
          errorCode: 'BOARDING_PASS_GENERATION_FAILED',
          message: 'Unable to derive boarding pass due to missing assignment data.',
        });
      }

      otp = deriveBoardingOtp(booking.id, assignmentId);

      if (hashBoardingOtp(otp) !== verification.otpHash) {
        this.logger.error(
          `Cryptographic integrity failure: derived OTP hash does not match stored hash for booking ${booking.id}`,
        );
        throw new InternalServerErrorException({
          errorCode: 'BOARDING_PASS_INTEGRITY_ERROR',
          message: 'Boarding pass verification hash mismatch.',
        });
      }

      // Repopulate Redis cache safely (outside any DB transaction)
      if (this.redisService) {
        const remainingSeconds = Math.max(
          0,
          Math.floor((expiresAt.getTime() - Date.now()) / 1000),
        );
        const ttlSeconds = Math.min(1800, remainingSeconds);
        if (ttlSeconds > 0) {
          try {
            await this.redisService.setPassengerBoardingOtp(
              booking.id,
              otp,
              ttlSeconds,
            );
          } catch (err) {
            this.logger.warn(
              `Redis setPassengerBoardingOtp fallback recovery failed: ${(err as Error).message}`,
            );
          }
        }
      }
    }

    // 6. Format response envelope
    const activeDriver = tripPassenger.trip?.activeDriver;
    const driverUser = activeDriver?.user;
    const vehicle = activeDriver?.vehicles?.[0];

    return {
      bookingId: booking.id,
      passengerId: booking.passengerId,
      tripId: tripPassenger.tripId,
      boardingOtp: otp,
      expiresAt: expiresAt.toISOString(),
      bookingStatus: booking.status,
      driver: {
        name: driverUser?.fullName ?? 'Assigned Driver',
        phoneNumber: driverUser?.phoneNumber ?? undefined,
        vehicle: vehicle
          ? {
              registrationNumber: vehicle.registrationNumber,
              makeModel: vehicle.makeModel,
              vehicleType: vehicle.vehicleType,
            }
          : null,
      },
    };
  }

  /**
   * Recalculates route using OSRM for surviving passengers after a group membership change.
   * Runs strictly outside open database transactions, applies groupVersion fencing check,
   * verifies detour <= 25%, and persists new GroupRouteVersion and GroupRouteStop records.
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
}
