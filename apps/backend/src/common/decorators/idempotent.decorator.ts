import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_METADATA_KEY = 'IDEMPOTENT_OPERATION';

/**
 * Decorator to enforce mandatory Idempotency-Key validation and caching
 * on state-mutating HTTP endpoints.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_METADATA_KEY, true);
