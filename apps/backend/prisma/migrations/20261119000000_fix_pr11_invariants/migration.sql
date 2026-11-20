-- Step 1: Detect and check for any existing duplicate active bookings before altering index
DO $$
DECLARE
    duplicate_count INT;
BEGIN
    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT passenger_id
        FROM bookings
        WHERE status IN ('REQUESTED', 'MATCHING', 'MATCHED', 'DISPATCHING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'BOARDED', 'IN_PROGRESS')
        GROUP BY passenger_id
        HAVING COUNT(*) > 1
    ) duplicates;

    IF duplicate_count > 0 THEN
        RAISE EXCEPTION 'Cannot apply migration: found % passengers with multiple active bookings.', duplicate_count;
    END IF;
END $$;

-- Step 2: Align active-booking partial unique index with canonical booking state machine
DROP INDEX IF EXISTS "idx_unique_active_passenger_booking";
CREATE UNIQUE INDEX "idx_unique_active_passenger_booking" 
ON "bookings" ("passenger_id") 
WHERE status IN ('REQUESTED', 'MATCHING', 'MATCHED', 'DISPATCHING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'BOARDED', 'IN_PROGRESS');

-- Step 3: Replace idx_unique_collected_booking_fee to permit multiple fees collected on one booking,
-- while guaranteeing that an original booking's fee can only be collected once
DROP INDEX IF EXISTS "idx_unique_collected_booking_fee";
CREATE UNIQUE INDEX "idx_unique_collected_booking_fee" 
ON "cancellation_fees" ("original_booking_id") 
WHERE status = 'COLLECTED';

CREATE INDEX "idx_cancellation_fees_collected_booking" 
ON "cancellation_fees" ("collected_booking_id") 
WHERE status = 'COLLECTED';

-- Step 4: Recreate idempotency_records with internal UUID primary key, scoped uniqueness on (user_id, idempotency_key), and status tracking
DROP TABLE IF EXISTS "idempotency_records";

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_path" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'IN_PROGRESS',
    "status_code" INTEGER,
    "response_payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- Unique index scoping idempotency key to user
CREATE UNIQUE INDEX "idx_idempotency_records_user_key" ON "idempotency_records" ("user_id", "idempotency_key");

-- Index for querying user idempotency status
CREATE INDEX "idx_idempotency_records_user_status" ON "idempotency_records" ("user_id", "status");

-- Index for createdAt cleanup
CREATE INDEX "idx_idempotency_created_at" ON "idempotency_records" ("created_at");

-- Foreign key to users table
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
