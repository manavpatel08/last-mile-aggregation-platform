import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import * as crypto from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';
import {
  StandardRealtimeEvent,
  DriverLocationUpdatePayload,
  DriverLocationBroadcastData,
  DriverGpsStaleData,
} from './realtime.interfaces.js';

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  setServer(server: Server): void {
    this.server = server;
  }

  getServer(): Server | null {
    return this.server;
  }

  /**
   * Helper to construct a standard event envelope.
   */
  createEnvelope<T>(
    event: string,
    entityType: string,
    entityId: string,
    entityVersion: number,
    occurredAt: string,
    data: T,
  ): StandardRealtimeEvent<T> {
    return {
      eventId: crypto.randomUUID(),
      event,
      entityType,
      entityId,
      entityVersion,
      occurredAt,
      data,
    };
  }

  /**
   * Emits an envelope to a specific Socket.IO room.
   */
  emitToRoom<T>(room: string, eventName: string, envelope: StandardRealtimeEvent<T>): void {
    if (!this.server) {
      this.logger.debug(`Socket server not initialized; skipped emit ${eventName} to ${room}`);
      return;
    }
    this.server.to(room).emit(eventName, envelope);
    this.logger.debug(`Broadcast event '${eventName}' (ID: ${envelope.eventId}) to room '${room}'`);
  }

  /**
   * Emits an envelope to a specific user room.
   */
  emitToUser<T>(userId: string, eventName: string, envelope: StandardRealtimeEvent<T>): void {
    this.emitToRoom(`user:${userId}`, eventName, envelope);
  }

  // ============================================================================
  // ROOM AUTHORIZATION CHECKS (ZERO FRONTEND TRUST)
  // ============================================================================

  async canJoinTrip(userId: string, tripId: string, role: string): Promise<boolean> {
    if (role === 'ADMIN') return true;

    // Check if user is the operating driver for this trip
    const driverTrip = await this.prisma.trip.findFirst({
      where: {
        id: tripId,
        activeDriver: { userId },
      },
      select: { id: true },
    });
    if (driverTrip) return true;

    // Check if user is an active/enrolled passenger on this trip (exclude CANCELLED and NO_SHOW)
    const passengerTrip = await this.prisma.tripPassenger.findFirst({
      where: {
        tripId,
        passengerId: userId,
        status: { in: ['WAITING', 'ASSIGNED', 'BOARDED', 'COMPLETED'] },
      },
      select: { id: true },
    });
    return !!passengerTrip;
  }

  async canJoinBooking(userId: string, bookingId: string, role: string): Promise<boolean> {
    if (role === 'ADMIN') return true;

    // Check if user is the booking passenger
    const booking = await this.prisma.booking.findFirst({
      where: {
        id: bookingId,
        passengerId: userId,
      },
      select: { id: true },
    });
    if (booking) return true;

    // Check if user is the assigned driver on the trip containing this booking
    const driverBooking = await this.prisma.tripPassenger.findFirst({
      where: {
        bookingId,
        trip: { activeDriver: { userId } },
      },
      select: { id: true },
    });
    return !!driverBooking;
  }

  async canJoinGroup(userId: string, groupId: string, role: string): Promise<boolean> {
    if (role === 'ADMIN') return true;

    const member = await this.prisma.groupMember.findFirst({
      where: {
        rideGroupId: groupId,
        booking: { passengerId: userId },
        isActiveMember: true,
      },
      select: { id: true },
    });
    return !!member;
  }

  // ============================================================================
  // DRIVER GPS TELEMETRY & THROTTLED POSTGIS SNAPSHOTS
  // ============================================================================

  async ingestDriverLocation(
    userId: string,
    payload: DriverLocationUpdatePayload,
  ): Promise<{
    broadcastData: DriverLocationBroadcastData;
    activeTripId: string | null;
  }> {
    // 1. Fetch verified driver profile
    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        verificationStatus: true,
        operationalStatus: true,
        isOnline: true,
      },
    });

    if (!driver || driver.verificationStatus !== 'APPROVED') {
      throw new Error('DRIVER_NOT_APPROVED');
    }
    if (driver.operationalStatus === 'SUSPENDED') {
      throw new Error('DRIVER_SUSPENDED');
    }

    const { latitude, longitude, heading = null, speed = null } = payload;
    const nowIso = new Date().toISOString();

    // 2. Validate Coordinate & Telemetry Ranges
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new Error('INVALID_COORDINATES');
    }

    if (
      heading !== null &&
      heading !== undefined &&
      (typeof heading !== 'number' || !Number.isFinite(heading) || heading < 0 || heading > 360)
    ) {
      throw new Error('INVALID_HEADING');
    }

    if (
      speed !== null &&
      speed !== undefined &&
      (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0 || speed > 200)
    ) {
      throw new Error('INVALID_SPEED');
    }

    // 3. Check if driver is currently operating an active trip
    let activeTrip: { id: string } | null = null;
    if (payload.tripId) {
      activeTrip = await this.prisma.trip.findFirst({
        where: {
          id: payload.tripId,
          activeDriverId: driver.id,
          status: { in: ['CREATED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'INTERRUPTED'] },
        },
        select: { id: true },
      });
    } else {
      activeTrip = await this.prisma.trip.findFirst({
        where: {
          activeDriverId: driver.id,
          status: { in: ['CREATED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'INTERRUPTED'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
    }

    const activeTripId = activeTrip?.id ?? null;

    // Invariant: If driver has no active trip, driver MUST be online to submit GPS telemetry
    if (!activeTripId && (!driver.isOnline || driver.operationalStatus === 'OFFLINE')) {
      throw new Error('DRIVER_OFFLINE');
    }

    const redis = this.redisService.getClient();
    const redisGpsKey = `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driver.id}`;

    // 4. Out-of-order / Timestamp Protection
    try {
      const existingRaw = await redis.get(redisGpsKey);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw);
        if (existing.updatedAt && new Date(existing.updatedAt).getTime() > new Date(nowIso).getTime()) {
          // Stale out-of-order fix: ignore write
          this.logger.warn(`Stale GPS fix ignored for driver ${driver.id}`);
          return {
            broadcastData: existing,
            activeTripId,
          };
        }
      }
    } catch {}

    const gpsRecord = {
      latitude,
      longitude,
      heading,
      speed,
      updatedAt: nowIso,
    };

    // 5. Store in Redis with strict 30s TTL
    await redis.set(redisGpsKey, JSON.stringify(gpsRecord), 'EX', 30);

    // 6. Throttled Durable PostgreSQL Snapshot (Every 15–30s during active trip)
    if (activeTripId) {
      const throttleKey = `throttle:trip_gps:${activeTripId}`;
      try {
        const hasThrottle = await redis.get(throttleKey);
        if (!hasThrottle) {
          // Set 15s throttle lease
          await redis.set(throttleKey, '1', 'EX', 15);

          // Update PostgreSQL trips.current_vehicle_location using PostGIS ST_SetSRID
          await this.prisma.$executeRaw`
            UPDATE trips
            SET current_vehicle_location = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326),
                updated_at = NOW()
            WHERE id = ${activeTripId}::uuid;
          `;
          this.logger.debug(`Durable PostGIS location snapshot persisted for trip ${activeTripId}`);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to persist PostGIS snapshot for trip ${activeTripId}: ${err?.message}`);
      }
    }

    const broadcastData: DriverLocationBroadcastData = {
      driverId: driver.id,
      tripId: activeTripId,
      latitude,
      longitude,
      heading,
      speed,
      updatedAt: nowIso,
    };

    return { broadcastData, activeTripId };
  }

  /**
   * Evaluates if an active trip's driver GPS is stale (> 10s missing).
   */
  async checkStaleGps(tripId: string): Promise<DriverGpsStaleData | null> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { activeDriverId: true, status: true },
    });

    if (!trip || trip.status !== 'IN_PROGRESS') return null;

    const redis = this.redisService.getClient();
    const rawGps = await redis.get(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${trip.activeDriverId}`);

    if (!rawGps) {
      return {
        driverId: trip.activeDriverId,
        tripId,
        lastReportedAt: null,
        staleDurationSeconds: 30,
        warning: 'Driver GPS fix unavailable or evicted from cache (> 30s)',
      };
    }

    const parsed = JSON.parse(rawGps);
    const ageSeconds = Math.floor((Date.now() - new Date(parsed.updatedAt).getTime()) / 1000);

    if (ageSeconds >= 10) {
      return {
        driverId: trip.activeDriverId,
        tripId,
        lastReportedAt: parsed.updatedAt,
        staleDurationSeconds: ageSeconds,
        warning: `Driver GPS telemetry stale (${ageSeconds}s since last fix)`,
      };
    }

    return null;
  }

  // ============================================================================
  // OUTBOX-TO-SOCKET EVENT TRANSLATION & BROADCAST BRIDGE
  // ============================================================================

  /**
   * Transforms committed PostgreSQL outbox events into canonical realtime events
   * and dispatches them to their target Socket.IO rooms outside DB transactions.
   */
  async broadcastOutboxEvent(outboxEvent: {
    id: string;
    eventType?: string;
    event_type?: string;
    aggregateType?: string;
    aggregate_type?: string;
    aggregateId?: string;
    aggregate_id?: string;
    payload: any;
    createdAt?: Date;
  }): Promise<boolean> {
    const eventType = outboxEvent.eventType || outboxEvent.event_type || '';
    const _aggregateType = outboxEvent.aggregateType || outboxEvent.aggregate_type || '';
    const aggregateId = outboxEvent.aggregateId || outboxEvent.aggregate_id || '';

    const p = typeof outboxEvent.payload === 'string'
      ? JSON.parse(outboxEvent.payload)
      : outboxEvent.payload;

    const occurredAt = outboxEvent.createdAt
      ? outboxEvent.createdAt.toISOString()
      : new Date().toISOString();

    const version = p?.groupVersion ?? p?.attemptNumber ?? p?.entityVersion ?? 1;

    switch (eventType) {
      // 1. Booking Events
      case 'BOOKING_CREATED': {
        const envelope = this.createEnvelope(
          'booking.created',
          'BOOKING',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`passenger:${p.passengerId}`, 'booking.created', envelope);
        this.emitToRoom(`booking:${aggregateId}`, 'booking.created', envelope);
        return true;
      }

      case 'BOOKING_CANCELLED':
      case 'BOOKING_CANCELLED_LATE':
      case 'BOOKING_EXPIRED':
      case 'BOOKING_RETURNED_TO_MATCHING': {
        const envelope = this.createEnvelope(
          'booking.status.updated',
          'BOOKING',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`passenger:${p.passengerId}`, 'booking.status.updated', envelope);
        this.emitToRoom(`booking:${aggregateId}`, 'booking.status.updated', envelope);
        return true;
      }

      // 2. Group Events
      case 'GROUP_FORMED':
      case 'GROUP_ROUTE_UPDATED': {
        const envelope = this.createEnvelope(
          'group.updated',
          'RIDE_GROUP',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`group:${aggregateId}`, 'group.updated', envelope);
        return true;
      }

      case 'DISPATCH_ATTEMPT_EXHAUSTED': {
        const envelope = this.createEnvelope(
          'group.updated',
          'DISPATCH_ATTEMPT',
          aggregateId,
          version,
          occurredAt,
          { ...p, status: 'EXHAUSTED' },
        );
        if (p.rideGroupId) {
          this.emitToRoom(`group:${p.rideGroupId}`, 'group.updated', envelope);
        }
        this.emitToRoom('admin', 'group.updated', envelope);
        return true;
      }

      // 3. Dispatch Offer Events
      case 'DISPATCH_OFFER_CREATED': {
        const envelope = this.createEnvelope(
          'driver.offer.created',
          'DRIVER_DISPATCH_OFFER',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`driver:${p.driverId}`, 'driver.offer.created', envelope);
        return true;
      }

      case 'DISPATCH_OFFER_REJECTED':
      case 'DISPATCH_OFFER_EXPIRED':
      case 'DISPATCH_OFFER_ACCEPTED': {
        const envelope = this.createEnvelope(
          'driver.offer.withdrawn',
          'DRIVER_DISPATCH_OFFER',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`driver:${p.driverId}`, 'driver.offer.withdrawn', envelope);
        return true;
      }

      // 4. Trip Lifecycle Events
      case 'TRIP_CREATED': {
        const envelope = this.createEnvelope(
          'trip.created',
          'TRIP',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${aggregateId}`, 'trip.created', envelope);
        const driverId = p.activeDriverId || p.driverId;
        if (driverId) {
          this.emitToRoom(`driver:${driverId}`, 'trip.created', envelope);
        }
        if (p.rideGroupId) {
          this.emitToRoom(`group:${p.rideGroupId}`, 'trip.created', envelope);
        }
        return true;
      }

      case 'TRIP_DRIVER_ARRIVED': {
        const envelope = this.createEnvelope(
          'driver.arrived',
          'TRIP',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${aggregateId}`, 'driver.arrived', envelope);
        return true;
      }

      case 'PASSENGER_BOARDED': {
        const envelope = this.createEnvelope(
          'passenger.boarded',
          'TRIP_PASSENGER',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${p.tripId}`, 'passenger.boarded', envelope);
        this.emitToRoom(`passenger:${p.passengerId}`, 'passenger.boarded', envelope);
        return true;
      }

      case 'TRIP_STARTED': {
        const envelope = this.createEnvelope(
          'trip.status.updated',
          'TRIP',
          aggregateId,
          version,
          occurredAt,
          { ...p, status: 'IN_PROGRESS' },
        );
        this.emitToRoom(`trip:${aggregateId}`, 'trip.status.updated', envelope);
        return true;
      }

      case 'PASSENGER_DROPPED_OFF': {
        const envelope = this.createEnvelope(
          'passenger.dropped_off',
          'TRIP_PASSENGER',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${p.tripId}`, 'passenger.dropped_off', envelope);
        this.emitToRoom(`passenger:${p.passengerId}`, 'passenger.dropped_off', envelope);
        return true;
      }

      case 'PASSENGER_NO_SHOW': {
        const envelope = this.createEnvelope(
          'passenger.no_show',
          'TRIP_PASSENGER',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${p.tripId}`, 'passenger.no_show', envelope);
        this.emitToRoom(`passenger:${p.passengerId}`, 'passenger.no_show', envelope);
        return true;
      }

      case 'TRIP_COMPLETED': {
        const envelope = this.createEnvelope(
          'trip.completed',
          'TRIP',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${aggregateId}`, 'trip.completed', envelope);
        return true;
      }

      case 'TRIP_CANCELLED': {
        const envelope = this.createEnvelope(
          'trip.cancelled',
          'TRIP',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${aggregateId}`, 'trip.cancelled', envelope);
        return true;
      }

      // 5. Breakdown & Replacement Events
      case 'TRIP_INTERRUPTED': {
        const envelope = this.createEnvelope(
          'trip.interrupted',
          'TRIP',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${aggregateId}`, 'trip.interrupted', envelope);
        this.emitToRoom('admin', 'trip.interrupted', envelope);
        return true;
      }

      case 'REPLACEMENT_OFFER_DISPATCHED': {
        const envelope = this.createEnvelope(
          'driver.offer.created',
          'TRIP_INCIDENT',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`driver:${p.driverId}`, 'driver.offer.created', envelope);
        return true;
      }

      case 'REPLACEMENT_OFFER_REJECTED':
      case 'REPLACEMENT_OFFER_EXPIRED': {
        const envelope = this.createEnvelope(
          'driver.offer.withdrawn',
          'TRIP_INCIDENT',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`driver:${p.driverId}`, 'driver.offer.withdrawn', envelope);
        return true;
      }

      case 'TRIP_RESUMED': {
        const envelope = this.createEnvelope(
          'trip.resumed',
          'TRIP',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${aggregateId}`, 'trip.resumed', envelope);
        this.emitToRoom('admin', 'trip.resumed', envelope);
        return true;
      }

      case 'TRIP_ABORTED': {
        const envelope = this.createEnvelope(
          'trip.aborted',
          'TRIP',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${aggregateId}`, 'trip.aborted', envelope);
        this.emitToRoom('admin', 'trip.aborted', envelope);
        return true;
      }

      // 6. Payment & Fee Events
      case 'CASH_PAYMENT_CONFIRMED': {
        const envelope = this.createEnvelope(
          'payment.confirmed',
          'CASH_COLLECTION',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`trip:${p.tripId}`, 'payment.confirmed', envelope);
        this.emitToRoom(`passenger:${p.passengerId}`, 'payment.confirmed', envelope);
        return true;
      }

      case 'CANCELLATION_FEE_WAIVED': {
        const envelope = this.createEnvelope(
          'fee.waived',
          'CANCELLATION_FEE',
          aggregateId,
          version,
          occurredAt,
          p,
        );
        this.emitToRoom(`passenger:${p.passengerId}`, 'fee.waived', envelope);
        return true;
      }

      default:
        this.logger.debug(`Unhandled outbox eventType '${eventType}' for socket translation`);
        return false;
    }
  }
}
