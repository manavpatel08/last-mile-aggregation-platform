import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, from } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import * as crypto from 'crypto';
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { IDEMPOTENT_METADATA_KEY } from '../decorators/idempotent.decorator.js';
import { canonicalJsonStringify } from '../utils/canonical-json.js';

export interface IdempotencyClaimContext {
  id: string;
  ownerToken: string;
  idempotencyKey: string;
  userId: string;
  requestUrl?: string;
}

/**
 * Verifies that the idempotency claim is still actively owned by this request
 * and acquires an exclusive row-level lock (SELECT ... FOR UPDATE) on the claim record.
 * Throws ConflictException('IDEMPOTENCY_CLAIM_LOST') if the claim has expired,
 * been superseded by another request takeover, or removed.
 */
export async function verifyIdempotencyClaim(
  tx: Prisma.TransactionClient,
  claim: IdempotencyClaimContext | undefined,
): Promise<void> {
  if (!claim) {
    return;
  }

  const claimRows = await tx.$queryRaw<
    Array<{ id: string; status: string; owner_token: string }>
  >`
    SELECT id, status, owner_token
    FROM idempotency_records
    WHERE id = ${claim.id}::uuid
    FOR UPDATE;
  `;

  if (!claimRows || claimRows.length === 0) {
    throw new ConflictException({
      errorCode: 'IDEMPOTENCY_CLAIM_LOST',
      message:
        'The idempotency claim was not found or was removed before transaction execution.',
    });
  }

  const currentClaim = claimRows[0];
  if (
    currentClaim.status !== 'IN_PROGRESS' ||
    currentClaim.owner_token !== claim.ownerToken
  ) {
    throw new ConflictException({
      errorCode: 'IDEMPOTENCY_CLAIM_LOST',
      message:
        'The idempotency claim was superseded or lost before transaction execution.',
    });
  }
}

/**
 * Fences an idempotent database transaction against superseded claims and atomically
 * marks the idempotency record as COMPLETED within the same database transaction.
 *
 * If claim is provided:
 * 1. Pessimistically locks the idempotency record using SELECT ... FOR UPDATE.
 * 2. Conditionally verifies:
 *    - The record exists
 *    - Status is 'IN_PROGRESS'
 *    - The owner_token matches claim.ownerToken exactly (has not been taken over or superseded)
 * 3. If any check fails, throws ConflictException('IDEMPOTENCY_CLAIM_LOST'),
 *    causing the transaction to abort and roll back all business mutations.
 * 4. Atomically updates the record to status = 'COMPLETED', saves response payload and status code,
 *    and clears locked_until.
 */
export async function fenceAndCompleteIdempotentTransaction<T>(
  tx: Prisma.TransactionClient,
  claim: IdempotencyClaimContext | undefined,
  responsePayload: T,
  statusCode: number = 200,
): Promise<void> {
  if (!claim) {
    return;
  }

  // 1. Lock the idempotency record with SELECT ... FOR UPDATE
  const claimRows = await tx.$queryRaw<
    Array<{ id: string; status: string; owner_token: string }>
  >`
    SELECT id, status, owner_token
    FROM idempotency_records
    WHERE id = ${claim.id}::uuid
    FOR UPDATE;
  `;

  if (!claimRows || claimRows.length === 0) {
    throw new ConflictException({
      errorCode: 'IDEMPOTENCY_CLAIM_LOST',
      message:
        'The idempotency claim was not found or was removed before transaction commit.',
    });
  }

  const currentClaim = claimRows[0];

  // 2. Conditionally verify:
  // - Status is 'IN_PROGRESS'
  // - owner_token matches claim.ownerToken exactly (has not been taken over or superseded)
  if (
    currentClaim.status !== 'IN_PROGRESS' ||
    currentClaim.owner_token !== claim.ownerToken
  ) {
    throw new ConflictException({
      errorCode: 'IDEMPOTENCY_CLAIM_LOST',
      message:
        'The idempotency claim was superseded or lost before transaction commit.',
    });
  }

  // 3. Mark idempotency record COMPLETED inside this SAME transaction
  const payloadJson = JSON.stringify(responsePayload);
  const updateResult = await tx.$executeRaw`
    UPDATE idempotency_records
    SET
      status = 'COMPLETED',
      status_code = ${statusCode},
      response_payload = ${payloadJson}::jsonb,
      locked_until = NULL,
      updated_at = NOW()
    WHERE id = ${claim.id}::uuid
      AND owner_token = ${claim.ownerToken}
      AND status = 'IN_PROGRESS';
  `;

  if (updateResult === 0) {
    throw new ConflictException({
      errorCode: 'IDEMPOTENCY_CLAIM_LOST',
      message:
        'Failed to complete idempotency record due to concurrent lease modification.',
    });
  }
}


export const LEASE_DURATION_MS = 30_000; // 30 seconds lease
export const HEARTBEAT_INTERVAL_MS = 5_000; // 5 seconds renewal
export const MAX_WAIT_POLL_MS = 2_500; // 2.5 seconds polling for concurrent in-progress
export const POLL_INTERVAL_MS = 100;
export const MAX_REQUEST_PATH_LENGTH = 4_096;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(
      IDEMPOTENT_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!isIdempotent) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const rawKey = request.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
      throw new BadRequestException({
        errorCode: 'MISSING_IDEMPOTENCY_KEY',
        message: 'An Idempotency-Key header is required for this operation.',
      });
    }

    const idempotencyKey = rawKey.trim();
    if (idempotencyKey.length > 255) {
      throw new BadRequestException({
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header must not exceed 255 characters.',
      });
    }

    const user = (request as unknown as { user?: { id?: string } }).user;
    if (!user?.id) {
      throw new UnauthorizedException({
        errorCode: 'UNAUTHORIZED',
        message: 'Authentication required for idempotent mutations.',
      });
    }
    const userId = user.id;

    // 1. Compute canonical normalized request identity: METHOD + Path + Query without truncation
    const rawUrl = request.originalUrl || request.url || '';
    let pathname = rawUrl;
    let search = '';
    try {
      const parsed = new URL(rawUrl, 'http://localhost');
      pathname = parsed.pathname;
      search = parsed.search;
    } catch {
      // Fallback to rawUrl
    }
    const cleanPath = pathname.replace(/\/+$/, '') || '/';
    const normalizedPath = `${request.method.toUpperCase()} ${cleanPath}${search}`;

    if (normalizedPath.length > MAX_REQUEST_PATH_LENGTH) {
      throw new BadRequestException({
        errorCode: 'URI_TOO_LONG',
        message: `Request identity exceeds maximum supported length (${MAX_REQUEST_PATH_LENGTH} characters).`,
      });
    }

    // 2. Canonical body hash using unambiguous canonical JSON serialization
    const canonicalBody = canonicalJsonStringify(request.body ?? {});
    const requestHash = crypto
      .createHash('sha256')
      .update(canonicalBody)
      .digest('hex');

    // 3. Atomic Database-Backed Claim with Ownership Token and Lease
    const ownerToken = crypto.randomUUID();
    const lockedUntil = new Date(Date.now() + LEASE_DURATION_MS);

    let claimAcquired = false;
    let recordId: string | null = null;

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const created = await this.prisma.idempotencyRecord.create({
          data: {
            userId,
            idempotencyKey,
            requestPath: normalizedPath,
            requestHash,
            status: 'IN_PROGRESS',
            ownerToken,
            lockedUntil,
            version: 1,
          },
        });
        recordId = created.id;
        claimAcquired = true;
        break;
      } catch (err: any) {
        if (err?.code === 'P2002') {
          // Unique constraint collision on (user_id, idempotency_key)
          const existing = await this.prisma.idempotencyRecord.findUnique({
            where: {
              userId_idempotencyKey: { userId, idempotencyKey },
            },
          });

          if (!existing) {
            // Record was cleaned up concurrently by a failed request; retry claiming
            continue;
          }

          // Validate that the request identity matches exactly
          if (
            existing.requestPath !== normalizedPath ||
            existing.requestHash !== requestHash
          ) {
            throw new ConflictException({
              errorCode: 'IDEMPOTENCY_CONFLICT',
              message:
                'Idempotency key has already been used with different request parameters or endpoint.',
            });
          }

          // Case A: Already COMPLETED -> return cached response
          if (existing.status === 'COMPLETED') {
            this.logger.log(
              `Returning cached idempotent response for key: ${idempotencyKey} (status ${existing.statusCode})`,
            );
            response.status(existing.statusCode ?? 200);
            return of(existing.responsePayload);
          }

          // Case B: IN_PROGRESS
          // Check if lease is active
          const isLeaseActive =
            existing.lockedUntil !== null &&
            existing.lockedUntil.getTime() > Date.now();

          if (isLeaseActive) {
            // Safe polling: poll for completion up to MAX_WAIT_POLL_MS
            const startTime = Date.now();
            let completedRecord = null;
            let recordGone = false;

            while (Date.now() - startTime < MAX_WAIT_POLL_MS) {
              await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
              const polled = await this.prisma.idempotencyRecord.findUnique({
                where: {
                  userId_idempotencyKey: { userId, idempotencyKey },
                },
              });

              if (polled && polled.status === 'COMPLETED') {
                completedRecord = polled;
                break;
              }

              if (!polled) {
                // The in-progress request failed and cleaned up its claim
                recordGone = true;
                break;
              }
            }

            if (completedRecord) {
              this.logger.log(
                `Resolved concurrent in-progress idempotency for key: ${idempotencyKey} (status ${completedRecord.statusCode})`,
              );
              response.status(completedRecord.statusCode ?? 200);
              return of(completedRecord.responsePayload);
            }

            if (recordGone) {
              // Retry claiming since the previous claim was cleaned up on failure
              continue;
            }

            // Still in progress and lease remains active -> return retryable conflict
            throw new ConflictException({
              errorCode: 'IDEMPOTENCY_IN_PROGRESS',
              message:
                'A request with this idempotency key is currently in progress. Please retry shortly.',
            });
          }

          // Case C: IN_PROGRESS but lease has EXPIRED (process terminated or abandoned)
          // Atomically take over the expired claim conditional on locked_until <= NOW()
          const newLockedUntil = new Date(Date.now() + LEASE_DURATION_MS);
          const takeoverCount = await this.prisma.$executeRaw`
            UPDATE idempotency_records
            SET
              owner_token = ${ownerToken},
              locked_until = ${newLockedUntil},
              request_path = ${normalizedPath},
              request_hash = ${requestHash},
              version = version + 1,
              updated_at = NOW()
            WHERE id = ${existing.id}::uuid
              AND status = 'IN_PROGRESS'
              AND (locked_until IS NULL OR locked_until <= NOW());
          `;

          if (takeoverCount > 0) {
            this.logger.log(
              `Safely acquired ownership of expired idempotency claim ${existing.id} for key: ${idempotencyKey}`,
            );
            recordId = existing.id;
            claimAcquired = true;
            break;
          }

          // If takeover failed because another request took over or renewed, retry
          continue;
        }

        throw err;
      }
    }

    if (!claimAcquired || !recordId) {
      throw new ConflictException({
        errorCode: 'IDEMPOTENCY_IN_PROGRESS',
        message:
          'A request with this idempotency key is currently in progress. Please retry shortly.',
      });
    }

    // Attach claim context to request so transactional operations can coordinate if needed
    const claimContext: IdempotencyClaimContext = {
      id: recordId,
      ownerToken,
      idempotencyKey,
      userId,
      requestUrl: request.url || request.originalUrl || '',
    };
    (request as unknown as { idempotencyClaim?: IdempotencyClaimContext }).idempotencyClaim =
      claimContext;

    // 4. Start lease renewal heartbeat while request is actively executing
    let heartbeatActive = true;
    const heartbeatTimer = setInterval(async () => {
      if (!heartbeatActive || !recordId) return;
      try {
        const renewedLockedUntil = new Date(Date.now() + LEASE_DURATION_MS);
        await this.prisma.$executeRaw`
          UPDATE idempotency_records
          SET
            locked_until = ${renewedLockedUntil},
            updated_at = NOW()
          WHERE id = ${recordId}::uuid
            AND owner_token = ${ownerToken}
            AND status = 'IN_PROGRESS';
        `;
      } catch (err: any) {
        this.logger.warn(
          `Failed to renew idempotency lease for record ${recordId}: ${err?.message}`,
        );
      }
    }, HEARTBEAT_INTERVAL_MS);

    const stopHeartbeat = () => {
      heartbeatActive = false;
      clearInterval(heartbeatTimer);
    };

    // 5. Primary claim acquired: Execute business operation
    let businessHandlerCompleted = false;

    return next.handle().pipe(
      switchMap(async (data) => {
        businessHandlerCompleted = true;
        stopHeartbeat();

        const statusCode = response.statusCode || 200;

        // Check if the business mutation already persisted the idempotency record inside its own transaction
        const currentRecord = await this.prisma.idempotencyRecord.findUnique({
          where: { id: recordId! },
        });

        if (currentRecord?.status === 'COMPLETED') {
          // Already completed (atomically within business transaction)
          return data;
        }

        // Conditional completion update: MUST match id, ownerToken, and status 'IN_PROGRESS'
        let updateSuccess = false;
        let lastError: any = null;

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const updateResult = await this.prisma.idempotencyRecord.updateMany({
              where: {
                id: recordId!,
                ownerToken,
                status: 'IN_PROGRESS',
              },
              data: {
                status: 'COMPLETED',
                statusCode,
                responsePayload: data as any,
                lockedUntil: null,
              },
            });

            if (updateResult.count === 0) {
              // The claim was superseded because the lease expired and another process acquired it
              this.logger.warn(
                `Idempotency claim ${recordId} was lost or superseded before completion. Owner token was ${ownerToken}.`,
              );
              throw new ConflictException({
                errorCode: 'IDEMPOTENCY_CLAIM_LOST',
                message:
                  'The idempotency claim was superseded by another operation before completion.',
              });
            }

            updateSuccess = true;
            break;
          } catch (err: any) {
            lastError = err;
            if (err instanceof ConflictException) throw err;
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        if (!updateSuccess) {
          this.logger.error(
            `Failed to persist completed idempotency record for key: ${idempotencyKey} after retries`,
            lastError instanceof Error ? lastError.stack : String(lastError),
          );
          throw new InternalServerErrorException({
            errorCode: 'IDEMPOTENCY_PERSISTENCE_FAILED',
            message: 'Failed to persist idempotent operation state.',
          });
        }

        return data;
      }),
      catchError((err) =>
        from(
          (async () => {
            stopHeartbeat();
            // ONLY delete the claim if the business handler did NOT complete!
            // If the business mutation succeeded, we must NOT delete the claim,
            // as doing so would allow duplicate business execution on client retry.
            if (!businessHandlerCompleted && recordId) {
              await this.prisma.idempotencyRecord
                .deleteMany({
                  where: {
                    id: recordId,
                    ownerToken,
                    status: 'IN_PROGRESS',
                  },
                })
                .catch(() => {});
            }
            throw err;
          })(),
        ),
      ),
    );
  }
}
