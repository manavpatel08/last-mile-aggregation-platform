import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { DispatchService } from '../../modules/dispatch/dispatch.service.js';
import {
  GroupFormedPayload,
  DispatchOfferCreatedPayload,
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
            ${filter?.eventType ? Prisma.sql`AND event_type = ${filter.eventType}` : Prisma.sql`AND event_type IN ('GROUP_FORMED', 'DISPATCH_OFFER_CREATED')`}
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

          const scheduleResult =
            await this.dispatchService.scheduleOfferTimeout(
              validation.data!.offerId,
            );

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

          summary.publishedCount++;
          summary.dispatchOfferCreatedHandledCount =
            (summary.dispatchOfferCreatedHandledCount ?? 0) + 1;
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

