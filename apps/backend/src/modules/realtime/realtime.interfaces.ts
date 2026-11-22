/**
 * ============================================================================
 * STAGE 10A: REALTIME SOCKET GATEWAY INTERFACES & CANONICAL EVENT SCHEMAS
 * ============================================================================
 * Strictly adheres to:
 * - AGENTS.md (PostgreSQL authoritative, zero trust on client-asserted rooms)
 * - docs/REALTIME_SOCKET_DESIGN.md (Target envelope, event catalog, rooms)
 * - docs/API_SPECIFICATION.md (Area 25 Reconnection Synchronization)
 * ============================================================================
 */

import { IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export interface StandardRealtimeEvent<T = any> {
  eventId: string;
  event: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  occurredAt: string;
  data: T;
}

export interface SocketUserContext {
  userId: string;
  role: string;
  roles?: string[];
  driverVerificationStatus: string | null;
  sessionId: string;
}

export interface AuthenticatedSocketData {
  user: SocketUserContext;
  joinedRooms: Set<string>;
}

export class DriverLocationUpdatePayload {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @IsNumber()
  heading?: number | null;

  @IsOptional()
  @IsNumber()
  speed?: number | null;

  @IsOptional()
  @IsUUID()
  tripId?: string | null;
}

export interface DriverLocationBroadcastData {
  driverId: string;
  tripId?: string | null;
  latitude: number;
  longitude: number;
  heading: number | null;
  speed: number | null;
  updatedAt: string;
}

export interface DriverGpsStaleData {
  driverId: string;
  tripId?: string | null;
  lastReportedAt: string | null;
  staleDurationSeconds: number;
  warning: string;
}

export class RoomSubscriptionPayload {
  @IsOptional()
  @IsUUID()
  tripId?: string;

  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;
}

export interface RoomSubscriptionAck {
  success: boolean;
  room?: string;
  error?: string;
  message?: string;
}

/**
 * Mapping from PostgreSQL Outbox Event Type to Canonical Socket.IO Event
 */
export interface OutboxToSocketMapping {
  canonicalEvent: string;
  entityType: string;
  targetRoomType: 'USER' | 'PASSENGER' | 'DRIVER' | 'TRIP' | 'BOOKING' | 'GROUP' | 'ADMIN';
}
