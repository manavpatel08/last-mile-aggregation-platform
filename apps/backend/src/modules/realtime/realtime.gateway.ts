import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { SessionService } from '../auth/session.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';
import { RealtimeService } from './realtime.service.js';
import {
  SocketUserContext,
  DriverLocationUpdatePayload,
  RoomSubscriptionAck,
} from './realtime.interfaces.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@WebSocketGateway({
  namespace: '/realtime',
  path: '/socket.io',
  cors: {
    origin: '*',
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 60000,
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly sessionService: SessionService,
    private readonly realtimeService: RealtimeService,
  ) {}

  afterInit(server: Server): void {
    this.realtimeService.setServer(server);
    this.logger.log('Realtime Socket.IO Gateway initialized on namespace /realtime');
  }

  /**
   * Validates short-lived socket ticket upon handshake.
   * Enforces atomic single-use ticket burning via Redis GETDEL.
   * Validates active session and binds authenticated identity to socket.
   */
  async handleConnection(client: Socket): Promise<void> {
    try {
      const ticket =
        client.handshake.auth?.ticket ||
        (typeof client.handshake.query?.ticket === 'string'
          ? client.handshake.query.ticket
          : undefined);

      if (!ticket || typeof ticket !== 'string' || !UUID_REGEX.test(ticket)) {
        this.logger.warn(`Connection rejected for socket ${client.id}: Invalid or missing socket ticket`);
        client.emit('error', {
          code: 'UNAUTHORIZED',
          message: 'Valid socket ticket UUID required in handshake auth',
        });
        client.disconnect(true);
        return;
      }

      // 1. Atomic Single-Use Ticket Consumption via Redis GETDEL
      const redis = this.redisService.getClient();
      const ticketKey = `${CACHE_KEYS.SOCKET_TICKET_PREFIX}${ticket}`;
      const rawContext = await redis.getdel(ticketKey);

      if (!rawContext) {
        this.logger.warn(
          `Connection rejected for socket ${client.id}: Invalid, expired, or burned ticket`,
        );
        client.emit('error', {
          code: 'UNAUTHORIZED',
          message: 'Invalid, expired, or already consumed socket ticket',
        });
        client.disconnect(true);
        return;
      }

      // 2. Parse Context
      let userContext: SocketUserContext;
      try {
        userContext = JSON.parse(rawContext);
      } catch {
        this.logger.error(`Connection rejected: Malformed ticket payload for socket ${client.id}`);
        client.emit('error', {
          code: 'UNAUTHORIZED',
          message: 'Malformed ticket payload',
        });
        client.disconnect(true);
        return;
      }

      // 3. Validate Context and Authoritative Active Session
      if (!userContext || !userContext.userId || !userContext.sessionId || !userContext.role) {
        this.logger.warn(`Connection rejected for socket ${client.id}: Incomplete ticket context`);
        client.emit('error', {
          code: 'UNAUTHORIZED',
          message: 'Incomplete ticket authentication context',
        });
        client.disconnect(true);
        return;
      }

      const isSessionValid = await this.sessionService.validateSession(
        userContext.sessionId,
      );
      if (!isSessionValid) {
        this.logger.warn(
          `Connection rejected for socket ${client.id}: Revoked or expired session ${userContext.sessionId}`,
        );
        client.emit('error', {
          code: 'UNAUTHORIZED',
          message: 'Session has been revoked or expired',
        });
        client.disconnect(true);
        return;
      }

      // 4. Validate Driver Status if applicable
      let driverProfileId: string | null = null;
      if (userContext.role === 'DRIVER') {
        const driverProfile = await this.prisma.driverProfile.findUnique({
          where: { userId: userContext.userId },
          select: { id: true, verificationStatus: true, operationalStatus: true },
        });

        if (driverProfile) {
          driverProfileId = driverProfile.id;
          userContext.driverVerificationStatus = driverProfile.verificationStatus;
        }
      }

      // 5. Attach Authenticated Identity to Socket Data
      const joinedRooms = new Set<string>();
      client.data = {
        user: userContext,
        driverId: driverProfileId,
        joinedRooms,
      };

      // 6. Automatically Join Authoritative Default Rooms
      // User Personal Room
      const userRoom = `user:${userContext.userId}`;
      await client.join(userRoom);
      joinedRooms.add(userRoom);

      // Passenger Room
      if (userContext.role === 'PASSENGER') {
        const passengerRoom = `passenger:${userContext.userId}`;
        await client.join(passengerRoom);
        joinedRooms.add(passengerRoom);
      }

      // Driver Room (Only if APPROVED)
      if (
        userContext.role === 'DRIVER' &&
        userContext.driverVerificationStatus === 'APPROVED' &&
        driverProfileId
      ) {
        const driverRoom = `driver:${driverProfileId}`;
        await client.join(driverRoom);
        joinedRooms.add(driverRoom);
      }

      // Admin Room
      if (userContext.role === 'ADMIN') {
        await client.join('admin');
        joinedRooms.add('admin');
      }

      this.logger.log(
        `Socket authenticated & connected: socketId=${client.id}, userId=${userContext.userId}, role=${userContext.role}`,
      );

      // 7. Emit Connected Acknowledgement
      client.emit('connected', {
        userId: userContext.userId,
        authenticated: true,
        rooms: Array.from(joinedRooms),
      });
    } catch (err: any) {
      this.logger.error(`Handshake connection error: ${err?.message}`, err?.stack);
      client.emit('error', {
        code: 'INTERNAL_ERROR',
        message: 'Socket authentication failed unexpectedly',
      });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const userId = client.data?.user?.userId;
    this.logger.log(
      `Socket disconnected: socketId=${client.id}, userId=${userId ?? 'unauthenticated'}`,
    );
  }

  // ============================================================================
  // ROOM SUBSCRIPTION HANDLERS (ZERO FRONTEND TRUST)
  // ============================================================================

  @SubscribeMessage('subscribe:trip')
  async handleSubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: string },
  ): Promise<RoomSubscriptionAck> {
    const user = client.data?.user as SocketUserContext | undefined;
    if (!user) {
      return { success: false, error: 'UNAUTHORIZED', message: 'Socket unauthenticated' };
    }

    const { tripId } = payload || {};
    if (!tripId || !UUID_REGEX.test(tripId)) {
      return { success: false, error: 'INVALID_INPUT', message: 'Valid tripId UUID required' };
    }

    const allowed = await this.realtimeService.canJoinTrip(user.userId, tripId, user.role);
    if (!allowed) {
      return { success: false, error: 'FORBIDDEN', message: 'Not authorized for trip room' };
    }

    const room = `trip:${tripId}`;
    await client.join(room);
    client.data?.joinedRooms?.add(room);
    this.logger.debug(`Socket ${client.id} joined room ${room}`);
    return { success: true, room };
  }

  @SubscribeMessage('unsubscribe:trip')
  async handleUnsubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: string },
  ): Promise<RoomSubscriptionAck> {
    const { tripId } = payload || {};
    if (tripId) {
      const room = `trip:${tripId}`;
      await client.leave(room);
      client.data?.joinedRooms?.delete(room);
    }
    return { success: true };
  }

  @SubscribeMessage('subscribe:booking')
  async handleSubscribeBooking(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { bookingId: string },
  ): Promise<RoomSubscriptionAck> {
    const user = client.data?.user as SocketUserContext | undefined;
    if (!user) {
      return { success: false, error: 'UNAUTHORIZED', message: 'Socket unauthenticated' };
    }

    const { bookingId } = payload || {};
    if (!bookingId || !UUID_REGEX.test(bookingId)) {
      return { success: false, error: 'INVALID_INPUT', message: 'Valid bookingId UUID required' };
    }

    const allowed = await this.realtimeService.canJoinBooking(user.userId, bookingId, user.role);
    if (!allowed) {
      return { success: false, error: 'FORBIDDEN', message: 'Not authorized for booking room' };
    }

    const room = `booking:${bookingId}`;
    await client.join(room);
    client.data?.joinedRooms?.add(room);
    this.logger.debug(`Socket ${client.id} joined room ${room}`);
    return { success: true, room };
  }

  @SubscribeMessage('unsubscribe:booking')
  async handleUnsubscribeBooking(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { bookingId: string },
  ): Promise<RoomSubscriptionAck> {
    const { bookingId } = payload || {};
    if (bookingId) {
      const room = `booking:${bookingId}`;
      await client.leave(room);
      client.data?.joinedRooms?.delete(room);
    }
    return { success: true };
  }

  @SubscribeMessage('subscribe:group')
  async handleSubscribeGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { groupId: string },
  ): Promise<RoomSubscriptionAck> {
    const user = client.data?.user as SocketUserContext | undefined;
    if (!user) {
      return { success: false, error: 'UNAUTHORIZED', message: 'Socket unauthenticated' };
    }

    const { groupId } = payload || {};
    if (!groupId || !UUID_REGEX.test(groupId)) {
      return { success: false, error: 'INVALID_INPUT', message: 'Valid groupId UUID required' };
    }

    const allowed = await this.realtimeService.canJoinGroup(user.userId, groupId, user.role);
    if (!allowed) {
      return { success: false, error: 'FORBIDDEN', message: 'Not authorized for group room' };
    }

    const room = `group:${groupId}`;
    await client.join(room);
    client.data?.joinedRooms?.add(room);
    this.logger.debug(`Socket ${client.id} joined room ${room}`);
    return { success: true, room };
  }

  @SubscribeMessage('unsubscribe:group')
  async handleUnsubscribeGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { groupId: string },
  ): Promise<RoomSubscriptionAck> {
    const { groupId } = payload || {};
    if (groupId) {
      const room = `group:${groupId}`;
      await client.leave(room);
      client.data?.joinedRooms?.delete(room);
    }
    return { success: true };
  }

  // ============================================================================
  // DRIVER GPS TELEMETRY HANDLER
  // ============================================================================

  @SubscribeMessage('driver.location.update')
  async handleDriverLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: DriverLocationUpdatePayload,
  ): Promise<{ success: boolean; updatedAt?: string; error?: string }> {
    const user = client.data?.user as SocketUserContext | undefined;
    if (!user || user.role !== 'DRIVER' || user.driverVerificationStatus !== 'APPROVED') {
      return { success: false, error: 'FORBIDDEN' };
    }

    try {
      const { broadcastData, activeTripId } = await this.realtimeService.ingestDriverLocation(
        user.userId,
        payload,
      );

      const envelope = this.realtimeService.createEnvelope(
        'driver.location.updated',
        'DRIVER',
        broadcastData.driverId,
        1,
        broadcastData.updatedAt,
        broadcastData,
      );

      // Broadcast to trip room if operating an active trip
      if (activeTripId) {
        this.server.to(`trip:${activeTripId}`).emit('driver.location.updated', envelope);
      }

      // Always broadcast to admin room
      this.server.to('admin').emit('driver.location.updated', envelope);

      return { success: true, updatedAt: broadcastData.updatedAt };
    } catch (err: any) {
      this.logger.warn(`Driver location update rejected for ${user.userId}: ${err?.message}`);
      return { success: false, error: err?.message || 'UPDATE_FAILED' };
    }
  }
}
