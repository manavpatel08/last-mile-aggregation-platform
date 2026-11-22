import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';
import { SyncRequestDto } from './dto/sync-request.dto.js';
import {
  SyncResponseDto,
  SyncPassengerState,
  SyncDriverState,
} from './dto/sync-response.dto.js';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Reconciles authoritative state for reconnected clients.
   * PostgreSQL is the absolute source of truth.
   */
  async reconcileState(
    userId: string,
    role: string,
    dto: SyncRequestDto,
  ): Promise<SyncResponseDto> {
    const nowIso = new Date().toISOString();
    let passengerState: SyncPassengerState | null = null;
    let driverState: SyncDriverState | null = null;
    let reconciled = false;

    // 1. Passenger State Assembly
    if (role === 'PASSENGER' || role === 'ADMIN') {
      passengerState = await this.buildPassengerState(userId);

      // Check if client version is out of sync or entities diverged
      if (dto.activeBookingId && (!passengerState.activeBooking || passengerState.activeBooking.id !== dto.activeBookingId)) {
        reconciled = true;
      }
      if (passengerState.activeBooking && dto.lastKnownEntityVersion !== undefined) {
        if (dto.lastKnownEntityVersion !== passengerState.activeBooking.entityVersion) {
          reconciled = true;
        }
      }
      if (dto.activeTripId && (!passengerState.activeTrip || passengerState.activeTrip.id !== dto.activeTripId)) {
        reconciled = true;
      }
    }

    // 2. Driver State Assembly
    if (role === 'DRIVER' || role === 'ADMIN') {
      driverState = await this.buildDriverState(userId);

      if (dto.activeTripId && (!driverState.activeTrip || driverState.activeTrip.id !== dto.activeTripId)) {
        reconciled = true;
      }
      if (driverState.activeTrip && dto.lastKnownEntityVersion !== undefined) {
        if (dto.lastKnownEntityVersion !== driverState.activeTrip.tripVersion) {
          reconciled = true;
        }
      }
    }

    return {
      success: true,
      serverTimestamp: nowIso,
      role,
      reconciled,
      passengerState,
      driverState,
    };
  }

  private async buildPassengerState(userId: string): Promise<SyncPassengerState> {
    // 1. Fetch active booking (Invariant 1)
    const activeBooking = await this.prisma.booking.findFirst({
      where: {
        passengerId: userId,
        status: { in: ['REQUESTED', 'MATCHING', 'DISPATCHING', 'CONFIRMED', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        passengerId: true,
        pickupPointId: true,
        agreedFareCeilingPaise: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    let activeGroup: SyncPassengerState['activeGroup'] = null;
    let activeTrip: SyncPassengerState['activeTrip'] = null;

    if (activeBooking) {
      // 2. Fetch active ride group membership
      const member = await this.prisma.groupMember.findFirst({
        where: {
          bookingId: activeBooking.id,
          isActiveMember: true,
        },
        include: {
          rideGroup: {
            include: {
              members: { where: { isActiveMember: true } },
            },
          },
        },
      });

      if (member?.rideGroup && !['CANCELLED', 'DISSOLVED', 'COMPLETED'].includes(member.rideGroup.status)) {
        activeGroup = {
          id: member.rideGroup.id,
          status: member.rideGroup.status,
          groupVersion: member.rideGroup.groupVersion,
          pickupPointId: member.rideGroup.pickupPointId,
          memberCount: member.rideGroup.members.length,
        };
      }

      // 3. Fetch active trip passenger
      const tripPassenger = await this.prisma.tripPassenger.findFirst({
        where: {
          bookingId: activeBooking.id,
          status: { in: ['ASSIGNED', 'WAITING', 'BOARDED'] },
        },
        include: {
          trip: {
            include: {
              activeDriver: {
                include: {
                  user: { select: { fullName: true } },
                  vehicles: { select: { registrationNumber: true } },
                },
              },
            },
          },
        },
      });

      if (
        tripPassenger?.trip &&
        ['CREATED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'INTERRUPTED'].includes(
          tripPassenger.trip.status,
        )
      ) {
        const trip = tripPassenger.trip;
        const driverLocation = await this.getLatestDriverLocation(
          trip.activeDriverId,
          trip.id,
          trip.updatedAt.toISOString(),
        );

        activeTrip = {
          id: trip.id,
          status: trip.status,
          tripVersion: 1, // Default or computed version
          activeDriverId: trip.activeDriverId,
          driverName: trip.activeDriver?.user?.fullName ?? null,
          vehicleNumber: trip.activeDriver?.vehicles?.[0]?.registrationNumber ?? null,
          driverLocation,
          etaSeconds: null,
          currentStopOrder: trip.currentStopOrder,
          farePaise: tripPassenger.finalRideFarePaise,
        };
      }
    }

    // 4. Fetch outstanding cancellation fees
    const outstandingFees = await this.prisma.cancellationFee.findMany({
      where: {
        passengerId: userId,
        status: 'OUTSTANDING',
      },
      select: {
        id: true,
        amountPaise: true,
        createdAt: true,
        originalBooking: { select: { cancellationReason: true } },
      },
    });

    return {
      activeBooking: activeBooking
        ? {
            id: activeBooking.id,
            status: activeBooking.status,
            passengerId: activeBooking.passengerId,
            pickupPointId: activeBooking.pickupPointId,
            dropoffAddress: null,
            fareQuotePaise: activeBooking.agreedFareCeilingPaise,
            createdAt: activeBooking.createdAt.toISOString(),
            updatedAt: activeBooking.updatedAt.toISOString(),
            entityVersion: 1,
          }
        : null,
      activeGroup,
      activeTrip,
      outstandingCancellationFees: outstandingFees.map((f) => ({
        id: f.id,
        feeAmountPaise: f.amountPaise,
        reason: f.originalBooking?.cancellationReason || 'Late cancellation fee',
        assessedAt: f.createdAt.toISOString(),
      })),
    };
  }

  private async buildDriverState(userId: string): Promise<SyncDriverState> {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        verificationStatus: true,
        operationalStatus: true,
        isOnline: true,
      },
    });

    if (!driver) {
      return {
        driverProfile: {
          id: '',
          verificationStatus: 'NOT_REGISTERED',
          operationalStatus: 'INACTIVE',
          isOnline: false,
        },
        activeOffer: null,
        activeTrip: null,
      };
    }

    // 1. Fetch active pending dispatch offer
    const activeOffer = await this.prisma.driverDispatchOffer.findFirst({
      where: {
        driverId: driver.id,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        rideGroupId: true,
        groupVersion: true,
        expiresAt: true,
        status: true,
      },
    });

    // 2. Fetch active assigned trip
    const activeTrip = await this.prisma.trip.findFirst({
      where: {
        activeDriverId: driver.id,
        status: { in: ['CREATED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'INTERRUPTED'] },
      },
      include: {
        passengers: {
          select: {
            passengerId: true,
            bookingId: true,
            status: true,
          },
        },
      },
    });

    return {
      driverProfile: {
        id: driver.id,
        verificationStatus: driver.verificationStatus,
        operationalStatus: driver.operationalStatus,
        isOnline: driver.isOnline,
      },
      activeOffer: activeOffer
        ? {
            id: activeOffer.id,
            rideGroupId: activeOffer.rideGroupId,
            groupVersion: activeOffer.groupVersion,
            expiresAt: activeOffer.expiresAt.toISOString(),
            status: activeOffer.status,
          }
        : null,
      activeTrip: activeTrip
        ? {
            id: activeTrip.id,
            status: activeTrip.status,
            tripVersion: 1,
            rideGroupId: activeTrip.rideGroupId,
            currentStopOrder: activeTrip.currentStopOrder,
            passengerManifest: activeTrip.passengers.map((p) => ({
              passengerId: p.passengerId,
              bookingId: p.bookingId,
              status: p.status,
            })),
          }
        : null,
    };
  }

  private async getLatestDriverLocation(
    driverId: string,
    tripId: string,
    tripUpdatedAt: string,
  ): Promise<{ latitude: number; longitude: number; updatedAt: string } | null> {
    // 1. Check Redis ephemeral cache first
    try {
      const redis = this.redisService.getClient();
      const rawGps = await redis.get(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${driverId}`);
      if (rawGps) {
        const parsed = JSON.parse(rawGps);
        if (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
          return {
            latitude: parsed.latitude,
            longitude: parsed.longitude,
            updatedAt: parsed.updatedAt || new Date().toISOString(),
          };
        }
      }
    } catch (err: any) {
      this.logger.debug(`Redis GPS lookup failed for driver ${driverId}: ${err?.message}`);
    }

    // 2. Fallback to durable PostGIS snapshot in PostgreSQL
    try {
      const rows: any = await this.prisma.$queryRaw`
        SELECT ST_X(current_vehicle_location::geometry) as longitude,
               ST_Y(current_vehicle_location::geometry) as latitude
        FROM trips
        WHERE id = ${tripId}::uuid
          AND current_vehicle_location IS NOT NULL;
      `;
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        if (typeof row.longitude === 'number' && typeof row.latitude === 'number') {
          return {
            latitude: row.latitude,
            longitude: row.longitude,
            updatedAt: tripUpdatedAt,
          };
        }
      }
    } catch (err: any) {
      this.logger.debug(`PostGIS GPS lookup failed for trip ${tripId}: ${err?.message}`);
    }

    return null;
  }
}
