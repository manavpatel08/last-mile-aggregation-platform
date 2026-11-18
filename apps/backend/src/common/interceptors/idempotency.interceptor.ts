import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, from } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import * as crypto from 'crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { IDEMPOTENT_METADATA_KEY } from '../decorators/idempotent.decorator.js';

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
    const user = (request as unknown as { user?: { id?: string } }).user;
    if (!user?.id) {
      throw new UnauthorizedException({
        errorCode: 'UNAUTHORIZED',
        message: 'Authentication required for idempotent mutations.',
      });
    }
    const userId = user.id;

    const rawUrl = request.originalUrl || request.url || '';
    let pathname = rawUrl;
    let search = '';
    try {
      const parsed = new URL(rawUrl, 'http://localhost');
      pathname = parsed.pathname;
      search = parsed.search;
    } catch {
      // Fallback to rawUrl if parsing fails
    }
    const cleanPath = pathname.replace(/\/+$/, '') || '/';
    const normalizedPath = `${request.method.toUpperCase()} ${cleanPath}${search}`.slice(
      0,
      255,
    );

    const rawBody = JSON.stringify(request.body ?? {});
    const requestHash = crypto
      .createHash('sha256')
      .update(rawBody)
      .digest('hex');

    // 1. Check if record already exists in PostgreSQL
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { idempotencyKey },
    });

    if (existing) {
      if (existing.userId !== userId) {
        throw new ForbiddenException({
          errorCode: 'IDEMPOTENCY_KEY_MISMATCH',
          message: 'Idempotency key was registered by another user.',
        });
      }

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

      this.logger.log(
        `Returning cached idempotent response for key: ${idempotencyKey} (status ${existing.statusCode})`,
      );
      response.status(existing.statusCode);
      return of(existing.responsePayload);
    }

    // 2. Process mutation and persist response payload atomically
    return next.handle().pipe(
      switchMap(async (data) => {
        const statusCode = response.statusCode || 200;
        try {
          await this.prisma.idempotencyRecord.create({
            data: {
              idempotencyKey,
              userId,
              requestPath: normalizedPath,
              requestHash,
              statusCode,
              responsePayload: data as any,
            },
          });
        } catch (error: any) {
          // If a race condition caused a unique constraint collision, fetch and return the winner's result
          if (error?.code === 'P2002') {
            const winner = await this.prisma.idempotencyRecord.findUnique({
              where: { idempotencyKey },
            });
            if (winner) {
              if (winner.userId !== userId) {
                throw new ForbiddenException({
                  errorCode: 'IDEMPOTENCY_KEY_MISMATCH',
                  message: 'Idempotency key was registered by another user.',
                });
              }
              if (
                winner.requestPath !== normalizedPath ||
                winner.requestHash !== requestHash
              ) {
                throw new ConflictException({
                  errorCode: 'IDEMPOTENCY_CONFLICT',
                  message:
                    'Idempotency key has already been used with different request parameters or endpoint.',
                });
              }
              response.status(winner.statusCode);
              return winner.responsePayload;
            }
          }
          this.logger.error(
            `Failed to persist idempotency record for key: ${idempotencyKey}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
        return data;
      }),
      catchError((err) =>
        from(
          (async () => {
            let winner = await this.prisma.idempotencyRecord.findUnique({
              where: { idempotencyKey },
            });
            if (!winner) {
              // Wait 50ms for winning concurrent transaction to finalize
              await new Promise((resolve) => setTimeout(resolve, 50));
              winner = await this.prisma.idempotencyRecord.findUnique({
                where: { idempotencyKey },
              });
            }
            if (winner) {
              if (winner.userId !== userId) {
                throw new ForbiddenException({
                  errorCode: 'IDEMPOTENCY_KEY_MISMATCH',
                  message: 'Idempotency key was registered by another user.',
                });
              }
              if (
                winner.requestPath !== normalizedPath ||
                winner.requestHash !== requestHash
              ) {
                throw new ConflictException({
                  errorCode: 'IDEMPOTENCY_CONFLICT',
                  message:
                    'Idempotency key has already been used with different request parameters or endpoint.',
                });
              }
              this.logger.log(
                `Resolved concurrent idempotency race for key: ${idempotencyKey}`,
              );
              response.status(winner.statusCode);
              return winner.responsePayload;
            }
            throw err;
          })(),
        ),
      ),
    );
  }
}
