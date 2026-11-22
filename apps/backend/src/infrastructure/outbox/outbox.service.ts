import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { DispatchService } from '../../modules/dispatch/dispatch.service.js';
import { RealtimeService } from '../../modules/realtime/realtime.service.js';
import {
  GroupFormedPayload,
  DispatchOfferCreatedPayload,
  DispatchOfferRejectedPayload,
  DispatchOfferExpiredPayload,
  OutboxClaimedRow,
  OutboxProcessingSummary,
  SUPPORTED_OUTBOX_EVENT_TYPES,
} from './outbox.interfaces.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_OUTBOX_RETRIES = 5;
export const STALE_PROCESSING_INTERVAL_SEC = 30;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatchService: DispatchService,
    @Optional()
    @Inject(forwardRef(() => RealtimeService))
    private readonly realtimeService?: RealtimeService,
  ) {}

  /**
   * Returns list of supported outbox event types that have implemented consumers.
   */
  getSupportedEventTypes(): readonly string[] {
    return SUPPORTED_OUTBOX_EVENT_TYPES;
  }

  /**
   * Validates the payload of a GROUP_FORMED domain event.
   * Ensures rideGroupId, pickupPointId, and groupVersion are present and structurally valid.
   */
  validateGroupFormedPayload(
    payload: unknown,
    aggregateId: string,
  ): { valid: boolean; error?: string; data?: GroupFormedPayload } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { valid: false, error: 'GROUP_FORMED payload must be a non-null object' };
    }

    const p = payload as Record<string, unknown>;

    if (typeof p.rideGroupId !== 'string' || !UUID_REGEX.test(p.rideGroupId)) {
      return { valid: false, error: 'GROUP_FORMED payload missing valid rideGroupId UUID' };
    }

    if (p.rideGroupId !== aggregateId) {
      return {
        valid: false,
        error: `GROUP_FORMED payload rideGroupId (${p.rideGroupId}) does not match aggregateId (${aggregateId})`,
      };
    }

    if (
      typeof p.pickupPointId !== 'string' ||
      !UUID_REGEX.test(p.pickupPointId)
    ) {
      return { valid: false, error: 'GROUP_FORMED payload missing valid pickupPointId UUID' };
    }

    if (
      typeof p.groupVersion !== 'number' ||
      !Number.isInteger(p.groupVersion) ||
      p.groupVersion < 1
    ) {
      return { valid: false, error: 'GROUP_FORMED payload missing valid positive integer groupVersion' };
    }

    return {
      valid: true,
      data: {
        rideGroupId: p.rideGroupId,
        pickupPointId: p.pickupPointId,
        groupVersion: p.groupVersion,
        status: typeof p.status === 'string' ? p.status : undefined,
        memberBookingIds: Array.isArray(p.memberBookingIds)
          ? (p.memberBookingIds as string[])
          : undefined,
        totalSharedFarePaise:
          typeof p.totalSharedFarePaise === 'number'
            ? p.totalSharedFarePaise
            : undefined,
        totalRouteDistanceMeters:
          typeof p.totalRouteDistanceMeters === 'number'
            ? p.totalRouteDistanceMeters
            : undefined,
        totalRouteDurationSec:
          typeof p.totalRouteDurationSec === 'number'
            ? p.totalRouteDurationSec
            : undefined,
      },
    };
  }

  /**
   * Validates the payload of a DISPATCH_OFFER_CREATED domain event.
   * Ensures offerId is present and structurally valid.
   */
  validateDispatchOfferCreatedPayload(
    payload: unknown,
    aggregateId: string,
  ): { valid: boolean; error?: string; data?: DispatchOfferCreatedPayload } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        valid: false,
        error: 'DISPATCH_OFFER_CREATED payload must be a non-null object',
      };
    }

    const p = payload as Record<string, unknown>;

    if (typeof p.offerId !== 'string' || !UUID_REGEX.test(p.offerId)) {
      return {
        valid: false,
        error: 'DISPATCH_OFFER_CREATED payload missing valid offerId UUID',
      };
    }

    if (p.offerId !== aggregateId) {
      return {
        valid: false,
        error: `DISPATCH_OFFER_CREATED payload offerId (${p.offerId}) does not match aggregateId (${aggregateId})`,
      };
    }

    return {
      valid: true,
      data: {
        offerId: p.offerId,
        rideGroupId: typeof p.rideGroupId === 'string' ? p.rideGroupId : undefined,
        driverId: typeof p.driverId === 'string' ? p.driverId : undefined,
        groupVersion: typeof p.groupVersion === 'number' ? p.groupVersion : undefined,
        dispatchAttemptId:
          typeof p.dispatchAttemptId === 'string' ? p.dispatchAttemptId : undefined,
        expiresAt: typeof p.expiresAt === 'string' ? p.expiresAt : undefined,
      },
    };
  }

  /**
   * Validates the payload of a DISPATCH_OFFER_REJECTED domain event.
   */
  validateDispatchOfferRejectedPayload(
    payload: unknown,
    aggregateId: string,
  ): { valid: boolean; error?: string; data?: DispatchOfferRejectedPayload } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        valid: false,
        error: 'DISPATCH_OFFER_REJECTED payload must be a non-null object',
      };
    }

    const p = payload as Record<string, unknown>;

    if (typeof p.offerId !== 'string' || !UUID_REGEX.test(p.offerId)) {
      return {
        valid: false,
        error: 'DISPATCH_OFFER_REJECTED payload missing valid offerId UUID',
      };
    }

    if (p.offerId !== aggregateId) {
      return {
        valid: false,
        error: `DISPATCH_OFFER_REJECTED payload offerId (${p.offerId}) does not match aggregateId (${aggregateId})`,
      };
    }

    if (typeof p.rideGroupId !== 'string' || !UUID_REGEX.test(p.rideGroupId)) {
      return {
        valid: false,
        error: 'DISPATCH_OFFER_REJECTED payload missing valid rideGroupId UUID',
      };
    }

    if (
      typeof p.dispatchAttemptId !== 'string' ||
      !UUID_REGEX.test(p.dispatchAttemptId)
    ) {
      return {
        valid: false,
        error:
          'DISPATCH_OFFER_REJECTED payload missing valid dispatchAttemptId UUID',
      };
    }

    if (
      typeof p.groupVersion !== 'number' ||
      !Number.isInteger(p.groupVersion) ||
      p.groupVersion < 1
    ) {
      return {
        valid: false,
        error:
          'DISPATCH_OFFER_REJECTED payload missing valid positive groupVersion',
      };
    }

    return {
      valid: true,
      data: {
        offerId: p.offerId,
        rideGroupId: p.rideGroupId,
        driverId: typeof p.driverId === 'string' ? p.driverId : '',
        groupVersion: p.groupVersion,
        dispatchAttemptId: p.dispatchAttemptId,
        reason: typeof p.reason === 'string' ? p.reason : null,
        rejectedAt: typeof p.rejectedAt === 'string' ? p.rejectedAt : undefined,
      },
    };
  }

  /**
   * Validates the payload of a DISPATCH_OFFER_EXPIRED domain event.
   */
  validateDispatchOfferExpiredPayload(
    payload: unknown,
    aggregateId: string,
  ): { valid: boolean; error?: string; data?: DispatchOfferExpiredPayload } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        valid: false,
        error: 'DISPATCH_OFFER_EXPIRED payload must be a non-null object',
      };
    }

    const p = payload as Record<string, unknown>;

    if (typeof p.offerId !== 'string' || !UUID_REGEX.test(p.offerId)) {
      return {
        valid: false,
        error: 'DISPATCH_OFFER_EXPIRED payload missing valid offerId UUID',
      };
    }

    if (p.offerId !== aggregateId) {
      return {
        valid: false,
        error: `DISPATCH_OFFER_EXPIRED payload offerId (${p.offerId}) does not match aggregateId (${aggregateId})`,
      };
    }

    if (typeof p.rideGroupId !== 'string' || !UUID_REGEX.test(p.rideGroupId)) {
      return {
        valid: false,
        error: 'DISPATCH_OFFER_EXPIRED payload missing valid rideGroupId UUID',
      };
    }

    if (
      typeof p.dispatchAttemptId !== 'string' ||
      !UUID_REGEX.test(p.dispatchAttemptId)
    ) {
      return {
        valid: false,
        error:
          'DISPATCH_OFFER_EXPIRED payload missing valid dispatchAttemptId UUID',
      };
    }

    if (
      typeof p.groupVersion !== 'number' ||
      !Number.isInteger(p.groupVersion) ||
      p.groupVersion < 1
    ) {
      return {
        valid: false,
        error:
          'DISPATCH_OFFER_EXPIRED payload missing valid positive groupVersion',
      };
    }

    return {
      valid: true,
      data: {
        offerId: p.offerId,
        rideGroupId: p.rideGroupId,
        driverId: typeof p.driverId === 'string' ? p.driverId : '',
        groupVersion: p.groupVersion,
        dispatchAttemptId: p.dispatchAttemptId,
        expiredAt: typeof p.expiredAt === 'string' ? p.expiredAt : undefined,
      },
    };
  }

  /**
   * Polls and processes pending outbox events using PostgreSQL FOR UPDATE SKIP LOCKED.
   * Complies strictly with AGENTS.md:
   * 1. Short ACID transaction to claim rows with SKIP LOCKED (releases DB locks immediately).
   * 2. Executes domain logic (including OSRM ETA calls) outside open database transactions.
   * 3. Updates event status to PUBLISHED upon verified durable outcome.
   * 4. Crash-safe: automatically reclaims stale PROCESSING events after 30 seconds.
   * 5. Exponential backoff on retries: prevents tight polling loops.
   * 6. Only claims supported implemented event types (GROUP_FORMED, DISPATCH_OFFER_CREATED).
   */
  async processPendingEvents(
    batchSize = 50,
    filter?: { eventType?: string; aggregateId?: string },
  ): Promise<OutboxProcessingSummary> {
    const summary: OutboxProcessingSummary = {
      processedCount: 0,
      publishedCount: 0,
      failedCount: 0,
      retriedCount: 0,
      groupFormedHandledCount: 0,
      dispatchOfferCreatedHandledCount: 0,
    };

    // Step 1: Claim pending or stale PROCESSING rows under a short transaction with SKIP LOCKED
    let claimedRows: OutboxClaimedRow[] = [];
    try {
      claimedRows = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<OutboxClaimedRow[]>`
          SELECT id, event_type, aggregate_type, aggregate_id, payload, retry_count
          FROM outbox_events
          WHERE (
            (status = 'PENDING' AND (retry_count = 0 OR published_at IS NULL OR published_at < NOW() - (INTERVAL '1 second' * POWER(2, LEAST(retry_count, 5)))))
            OR
            (status = 'PROCESSING' AND published_at < NOW() - INTERVAL '30 seconds')
          )
            ${filter?.eventType ? Prisma.sql`AND event_type = ${filter.eventType}` : Prisma.empty}
            ${filter?.aggregateId ? Prisma.sql`AND aggregate_id = ${filter.aggregateId}::uuid` : Prisma.empty}
          ORDER BY
            CASE
              WHEN event_type = 'GROUP_FORMED' THEN 0
              WHEN event_type = 'DISPATCH_OFFER_CREATED' THEN 1
              ELSE 2
            END ASC,
            created_at ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED;
        `;

        if (rows.length === 0) {
          return [];
        }

        const ids = rows.map((r) => r.id);
        await tx.$executeRaw`
          UPDATE outbox_events
          SET status = 'PROCESSING',
              published_at = NOW()
          WHERE id = ANY(${ids}::uuid[]);
        `;

        return rows;
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to claim pending outbox events: ${err?.message}`,
        err?.stack,
      );
      return summary;
    }

    if (claimedRows.length === 0) {
      return summary;
    }

    summary.processedCount = claimedRows.length;

    // Step 2: Process claimed events outside open database transactions
    for (const row of claimedRows) {
      try {
        if (
          row.event_type === 'GROUP_FORMED' &&
          row.aggregate_type === 'RIDE_GROUP'
        ) {
          // Validate GROUP_FORMED payload
          const validation = this.validateGroupFormedPayload(
            row.payload,
            row.aggregate_id,
          );

          if (!validation.valid) {
            this.logger.error(
              `Outbox event ${row.id} rejected: ${validation.error}`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'FAILED',
                lastError: validation.error,
                publishedAt: new Date(),
              },
            });
            summary.failedCount++;
            continue;
          }

          const rideGroupId = validation.data!.rideGroupId;
          const groupVersion = validation.data!.groupVersion;

          // 1. Check if durable dispatch outcome ALREADY exists in PostgreSQL
          // Handles worker crashes after DB commit, duplicate delivery, and post-dispatch offer state changes (ACCEPTED, REJECTED, EXPIRED, WITHDRAWN)
          const existingAssignment =
            await this.prisma.driverAssignment.findFirst({
              where: {
                rideGroupId,
                status: { in: ['RESERVED', 'ACTIVE', 'COMPLETED'] },
              },
            });

          const existingOffer =
            await this.prisma.driverDispatchOffer.findFirst({
              where: {
                rideGroupId,
                groupVersion,
              },
            });

          if (existingAssignment || existingOffer) {
            this.logger.log(
              `Durable dispatch outcome already exists for group ${rideGroupId} (v${groupVersion}): assignment=${existingAssignment?.id ?? 'none'}, offer=${existingOffer?.id ?? 'none'} (status=${existingOffer?.status ?? 'none'}); acknowledging GROUP_FORMED outbox event ${row.id}`,
            );

            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                lastError: null,
              },
            });
            summary.publishedCount++;
            summary.groupFormedHandledCount++;
            continue;
          }

          // Trigger Stage 6 Dispatch Engine
          const dispatchResult =
            await this.dispatchService.initiateDispatchForGroup(rideGroupId);

          if (!dispatchResult.success) {
            if (dispatchResult.reason === 'INVALID_GROUP_STATUS') {
              // Group has already progressed to an assigned or terminal state (e.g. DRIVER_ASSIGNED, CANCELLED)
              await this.prisma.outboxEvent.update({
                where: { id: row.id },
                data: {
                  status: 'PUBLISHED',
                  publishedAt: new Date(),
                  lastError: null,
                },
              });
              summary.publishedCount++;
              summary.groupFormedHandledCount++;
              continue;
            }

            // Retryable dispatch condition (e.g. ROUTING_UNAVAILABLE, FLEET_EXHAUSTED)
            this.logger.warn(
              `Dispatch for group ${rideGroupId} could not complete (${dispatchResult.reason}): ${dispatchResult.message}; leaving outbox event retryable`,
            );

            const nextRetry = row.retry_count + 1;
            const isTerminal = nextRetry >= MAX_OUTBOX_RETRIES;

            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: isTerminal ? 'FAILED' : 'PENDING',
                retryCount: nextRetry,
                lastError: dispatchResult.message || dispatchResult.reason,
                publishedAt: new Date(), // Anchor for exponential backoff
              },
            });

            if (isTerminal) {
              summary.failedCount++;
            } else {
              summary.retriedCount++;
            }
            continue;
          }

          // Dispatch succeeded: verify durable outcome in PostgreSQL
          if (dispatchResult.offerId) {
            const durableOffer =
              await this.prisma.driverDispatchOffer.findUnique({
                where: { id: dispatchResult.offerId },
              });
            if (!durableOffer) {
              throw new Error(
                `Dispatch reported offer ${dispatchResult.offerId} created, but offer not found in database`,
              );
            }
          } else {
            const durableOutcome =
              (await this.prisma.driverDispatchOffer.findFirst({
                where: { rideGroupId, groupVersion },
              })) ??
              (await this.prisma.driverAssignment.findFirst({
                where: {
                  rideGroupId,
                  status: { in: ['RESERVED', 'ACTIVE', 'COMPLETED'] },
                },
              }));

            if (!durableOutcome) {
              throw new Error(
                `Dispatch reported success for group ${rideGroupId}, but neither offer nor assignment found in database`,
              );
            }
          }

          this.logger.log(
            `Automated dispatch initiated for group ${rideGroupId} via outbox event ${row.id}: success=true, offerId=${dispatchResult.offerId ?? 'none'}`,
          );

          // Mark outbox event durably PUBLISHED
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: {
              status: 'PUBLISHED',
              publishedAt: new Date(),
              lastError: null,
            },
          });

          this.realtimeService
            ?.broadcastOutboxEvent(row)
            .catch((err: any) =>
              this.logger.warn(`Failed to broadcast GROUP_FORMED: ${err?.message}`),
            );

          summary.publishedCount++;
          summary.groupFormedHandledCount++;
        } else if (
          row.event_type === 'DISPATCH_OFFER_CREATED' &&
          row.aggregate_type === 'DRIVER_DISPATCH_OFFER'
        ) {
          const validation = this.validateDispatchOfferCreatedPayload(
            row.payload,
            row.aggregate_id,
          );

          if (!validation.valid) {
            this.logger.error(
              `Outbox event ${row.id} rejected: ${validation.error}`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'FAILED',
                lastError: validation.error,
                publishedAt: new Date(),
              },
            });
            summary.failedCount++;
            continue;
          }

          let scheduleResult;
          try {
            scheduleResult =
              await this.dispatchService.scheduleOfferTimeout(
                validation.data!.offerId,
              );
          } catch (err: any) {
            this.logger.warn(
              `Timeout scheduling failed for offer ${validation.data!.offerId}: ${err?.message}; leaving outbox event retryable`,
            );
            const nextRetry = row.retry_count + 1;
            const isTerminal = nextRetry >= MAX_OUTBOX_RETRIES;

            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: isTerminal ? 'FAILED' : 'PENDING',
                retryCount: nextRetry,
                lastError: err?.message || 'QUEUE_NOT_AVAILABLE',
                publishedAt: new Date(),
              },
            });

            if (isTerminal) {
              summary.failedCount++;
            } else {
              summary.retriedCount++;
            }
            continue;
          }

          if (!scheduleResult.scheduled) {
            if (scheduleResult.reason?.startsWith('OFFER_STATUS_')) {
              this.logger.log(
                `Timeout scheduling skipped for terminal offer ${validation.data!.offerId} (${scheduleResult.reason}); marking outbox event PUBLISHED`,
              );
            } else {
              // Unscheduled pending offer: keep event retryable, never mark PUBLISHED
              this.logger.warn(
                `Offer ${validation.data!.offerId} timeout was not scheduled (${scheduleResult.reason}); leaving outbox event retryable`,
              );
              const nextRetry = row.retry_count + 1;
              const isTerminal = nextRetry >= MAX_OUTBOX_RETRIES;

              await this.prisma.outboxEvent.update({
                where: { id: row.id },
                data: {
                  status: isTerminal ? 'FAILED' : 'PENDING',
                  retryCount: nextRetry,
                  lastError: scheduleResult.reason || 'TIMEOUT_NOT_SCHEDULED',
                  publishedAt: new Date(),
                },
              });

              if (isTerminal) {
                summary.failedCount++;
              } else {
                summary.retriedCount++;
              }
              continue;
            }
          }

          this.logger.log(
            `Durable timeout scheduling for offer ${validation.data!.offerId} via outbox event ${row.id}: scheduled=${scheduleResult.scheduled}, reason=${scheduleResult.reason ?? 'ENQUEUED'}`,
          );

          // Mark outbox event durably PUBLISHED
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: {
              status: 'PUBLISHED',
              publishedAt: new Date(),
              lastError: null,
            },
          });

          this.realtimeService
            ?.broadcastOutboxEvent(row)
            .catch((err: any) =>
              this.logger.warn(`Failed to broadcast GROUP_FORMED: ${err?.message}`),
            );

          summary.publishedCount++;
          summary.dispatchOfferCreatedHandledCount =
            (summary.dispatchOfferCreatedHandledCount ?? 0) + 1;
        } else if (
          (row.event_type === 'DISPATCH_OFFER_REJECTED' ||
            row.event_type === 'DISPATCH_OFFER_EXPIRED') &&
          row.aggregate_type === 'DRIVER_DISPATCH_OFFER'
        ) {
          const isRejection = row.event_type === 'DISPATCH_OFFER_REJECTED';
          const validation = isRejection
            ? this.validateDispatchOfferRejectedPayload(
                row.payload,
                row.aggregate_id,
              )
            : this.validateDispatchOfferExpiredPayload(
                row.payload,
                row.aggregate_id,
              );

          if (!validation.valid) {
            this.logger.error(
              `Outbox event ${row.id} rejected: ${validation.error}`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'FAILED',
                lastError: validation.error,
                publishedAt: new Date(),
              },
            });
            summary.failedCount++;
            continue;
          }

          const { offerId, rideGroupId, groupVersion, dispatchAttemptId } =
            validation.data!;

          // 1. Verify offer exists in PostgreSQL and is in expected terminal state
          const offer = await this.prisma.driverDispatchOffer.findUnique({
            where: { id: offerId },
          });

          if (!offer) {
            this.logger.error(
              `Offer ${offerId} referenced by outbox event ${row.id} not found in database`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'FAILED',
                lastError: `Offer ${offerId} not found in database`,
                publishedAt: new Date(),
              },
            });
            summary.failedCount++;
            continue;
          }

          const expectedStatus = isRejection ? 'REJECTED' : 'EXPIRED';
          if (offer.status !== expectedStatus) {
            this.logger.warn(
              `Offer ${offerId} status is '${offer.status}', expected '${expectedStatus}' for outbox event ${row.id}; skipping cascade`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                lastError: null,
              },
            });
            summary.publishedCount++;
            continue;
          }

          // 2. Verify ride group is still relevant for this group version
          const group = await this.prisma.rideGroup.findUnique({
            where: { id: rideGroupId },
          });

          if (!group) {
            this.logger.error(
              `Ride group ${rideGroupId} referenced by outbox event ${row.id} not found`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'FAILED',
                lastError: `Ride group ${rideGroupId} not found`,
                publishedAt: new Date(),
              },
            });
            summary.failedCount++;
            continue;
          }

          if (group.groupVersion !== groupVersion) {
            this.logger.log(
              `Group ${rideGroupId} version changed (${group.groupVersion} vs ${groupVersion}); acknowledging stale cascade event ${row.id}`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                lastError: null,
              },
            });
            summary.publishedCount++;
            continue;
          }

          if (
            ['CANCELLED', 'DISSOLVED', 'COMPLETED'].includes(group.status)
          ) {
            this.logger.log(
              `Group ${rideGroupId} is in terminal status '${group.status}'; acknowledging cascade event ${row.id}`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                lastError: null,
              },
            });
            summary.publishedCount++;
            continue;
          }

          // 3. Check whether a subsequent dispatch outcome already exists
          const activeAssignment =
            await this.prisma.driverAssignment.findFirst({
              where: {
                rideGroupId,
                status: { in: ['RESERVED', 'ACTIVE', 'COMPLETED'] },
              },
            });

          const pendingOffer =
            await this.prisma.driverDispatchOffer.findFirst({
              where: {
                rideGroupId,
                status: 'PENDING',
              },
            });

          const subsequentOfferInAttempt =
            await this.prisma.driverDispatchOffer.findFirst({
              where: {
                dispatchAttemptId,
                id: { not: offerId },
                offeredAt: { gt: offer.offeredAt },
              },
            });

          const attempt = await this.prisma.dispatchAttempt.findUnique({
            where: { id: dispatchAttemptId },
          });

          if (
            activeAssignment ||
            pendingOffer ||
            subsequentOfferInAttempt ||
            attempt?.status === 'EXHAUSTED'
          ) {
            this.logger.log(
              `Subsequent dispatch outcome already exists for group ${rideGroupId} (v${groupVersion}): assignment=${activeAssignment?.id ?? 'none'}, pendingOffer=${pendingOffer?.id ?? 'none'}, subsequentOffer=${subsequentOfferInAttempt?.id ?? 'none'}, attemptStatus=${attempt?.status ?? 'none'}; acknowledging cascade event ${row.id}`,
            );
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                lastError: null,
              },
            });
            summary.publishedCount++;
            if (isRejection) {
              summary.dispatchOfferRejectedHandledCount =
                (summary.dispatchOfferRejectedHandledCount ?? 0) + 1;
            } else {
              summary.dispatchOfferExpiredHandledCount =
                (summary.dispatchOfferExpiredHandledCount ?? 0) + 1;
            }
            continue;
          }

          // 4. Trigger sequential cascade dispatch
          this.logger.log(
            `Triggering durable next-driver cascade dispatch for group ${rideGroupId} via outbox event ${row.id} (${row.event_type})`,
          );

          let dispatchResult;
          try {
            dispatchResult =
              await this.dispatchService.initiateDispatchForGroup(rideGroupId);
          } catch (err: any) {
            this.logger.warn(
              `Cascade dispatch exception for group ${rideGroupId} via outbox event ${row.id}: ${err?.message}; leaving retryable`,
            );
            const nextRetry = row.retry_count + 1;
            const isTerminal = nextRetry >= MAX_OUTBOX_RETRIES;

            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: isTerminal ? 'FAILED' : 'PENDING',
                retryCount: nextRetry,
                lastError: err?.message || 'CASCADE_DISPATCH_FAILED',
                publishedAt: new Date(),
              },
            });

            if (isTerminal) {
              summary.failedCount++;
            } else {
              summary.retriedCount++;
            }
            continue;
          }

          if (!dispatchResult.success) {
            if (dispatchResult.reason === 'INVALID_GROUP_STATUS') {
              await this.prisma.outboxEvent.update({
                where: { id: row.id },
                data: {
                  status: 'PUBLISHED',
                  publishedAt: new Date(),
                  lastError: null,
                },
              });
              summary.publishedCount++;
              continue;
            }

            // Retryable dispatch condition (e.g. ROUTING_UNAVAILABLE, FLEET_EXHAUSTED)
            this.logger.warn(
              `Cascade dispatch for group ${rideGroupId} could not complete (${dispatchResult.reason}): ${dispatchResult.message}; leaving outbox event retryable`,
            );

            const nextRetry = row.retry_count + 1;
            const isTerminal = nextRetry >= MAX_OUTBOX_RETRIES;

            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: isTerminal ? 'FAILED' : 'PENDING',
                retryCount: nextRetry,
                lastError: dispatchResult.message || dispatchResult.reason,
                publishedAt: new Date(),
              },
            });

            if (isTerminal) {
              summary.failedCount++;
            } else {
              summary.retriedCount++;
            }
            continue;
          }

          // Cascade succeeded: mark outbox event PUBLISHED
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: {
              status: 'PUBLISHED',
              publishedAt: new Date(),
              lastError: null,
            },
          });

          this.realtimeService
            ?.broadcastOutboxEvent(row)
            .catch((err: any) =>
              this.logger.warn(`Failed to broadcast ${row.event_type}: ${err?.message}`),
            );

          summary.publishedCount++;
          if (isRejection) {
            summary.dispatchOfferRejectedHandledCount =
              (summary.dispatchOfferRejectedHandledCount ?? 0) + 1;
          } else {
            summary.dispatchOfferExpiredHandledCount =
              (summary.dispatchOfferExpiredHandledCount ?? 0) + 1;
          }
        } else {
          // If RealtimeService can broadcast this domain event, broadcast and mark PUBLISHED
          let broadcastSucceeded = false;
          if (this.realtimeService) {
            try {
              broadcastSucceeded = await this.realtimeService.broadcastOutboxEvent(row);
            } catch (broadcastErr: any) {
              this.logger.warn(
                `Failed to broadcast outbox event ${row.id} (${row.event_type}): ${broadcastErr?.message}`,
              );
            }
          }

          if (broadcastSucceeded) {
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                lastError: null,
              },
            });
            summary.publishedCount++;
          } else {
            // Unsupported or unhandled event type: DO NOT mark PUBLISHED!
            this.logger.debug(
              `Outbox event ${row.id} has unhandled event type '${row.event_type}'; unclaiming to PENDING without acknowledgment`,
            );
            try {
              await this.prisma.outboxEvent.update({
                where: { id: row.id },
                data: {
                  status: 'PENDING',
                  publishedAt: null,
                },
              });
            } catch {
              // Engine may be disconnecting during shutdown
            }
          }
        }
      } catch (err: any) {
        if (err instanceof NotFoundException) {
          this.logger.warn(
            `Outbox event ${row.id} referenced missing entity: ${err?.message}; marking FAILED`,
          );
          try {
            await this.prisma.outboxEvent.update({
              where: { id: row.id },
              data: {
                status: 'FAILED',
                lastError: err?.message,
                publishedAt: new Date(),
              },
            });
          } catch {
            // Engine may be disconnecting during shutdown
          }
          summary.failedCount++;
          continue;
        }

        this.logger.error(
          `Error processing outbox event ${row.id} (${row.event_type}): ${err?.message}`,
          err?.stack,
        );

        const nextRetry = row.retry_count + 1;
        const isTerminal = nextRetry >= MAX_OUTBOX_RETRIES;

        try {
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: {
              status: isTerminal ? 'FAILED' : 'PENDING',
              retryCount: nextRetry,
              lastError: err?.message || 'Unknown processing error',
              publishedAt: new Date(), // Anchor for exponential backoff
            },
          });
        } catch {
          // Engine may be disconnecting during shutdown
        }

        if (isTerminal) {
          summary.failedCount++;
        } else {
          summary.retriedCount++;
        }
      }
    }

    return summary;
  }

  /**
   * On-demand trigger to immediately process pending outbox events.
   * Used for real-time post-commit handoffs and automated E2E test verification.
   */
  async triggerImmediateProcessing(filter?: {
    eventType?: string;
    aggregateId?: string;
  }): Promise<OutboxProcessingSummary> {
    return this.processPendingEvents(50, filter);
  }
}

