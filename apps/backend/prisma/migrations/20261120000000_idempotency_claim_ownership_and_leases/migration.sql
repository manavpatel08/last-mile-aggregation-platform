-- Alter request_path from VARCHAR(255) to TEXT to support long paths and query strings without truncation
ALTER TABLE "idempotency_records" ALTER COLUMN "request_path" TYPE TEXT;

-- Add claim ownership, lease expiration, and optimistic concurrency versioning
ALTER TABLE "idempotency_records" ADD COLUMN "owner_token" VARCHAR(255) NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "idempotency_records" ADD COLUMN "locked_until" TIMESTAMPTZ(6);
ALTER TABLE "idempotency_records" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Add index on locked_until for efficient lease expiration lookups
CREATE INDEX "idx_idempotency_locked_until" ON "idempotency_records" ("locked_until");
