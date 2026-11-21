-- Migration: 20261122000000_stage8_payment_ledger_invariants
-- Stage 8: Payments, Cancellations & Financial Invariants

-- Step 1: Replace redundant partial unique cancellation fee index with global unique index on original_booking_id
DROP INDEX IF EXISTS "idx_unique_collected_booking_fee";

CREATE UNIQUE INDEX "idx_unique_cancellation_fee_per_booking"
ON "cancellation_fees" ("original_booking_id");

-- Step 2: Enforce exactly one cash collection per passenger journey
CREATE UNIQUE INDEX "idx_unique_cash_collection_trip_passenger"
ON "cash_collections" ("trip_passenger_id");
