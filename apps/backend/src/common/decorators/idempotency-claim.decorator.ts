import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { IdempotencyClaimContext } from '../interceptors/idempotency.interceptor.js';

export const CurrentIdempotencyClaim = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IdempotencyClaimContext | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return (request as unknown as { idempotencyClaim?: IdempotencyClaimContext })
      .idempotencyClaim;
  },
);
