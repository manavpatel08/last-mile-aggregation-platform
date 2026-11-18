-- PostGIS extension and public schema are pre-installed in lastmile_db

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(255) NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'PASSENGER',
    "phone_number" VARCHAR(20),
    "avatar_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "role_name" VARCHAR(50) NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL DEFAULT 'GOOGLE',
    "provider_sub" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_family_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(255) NOT NULL,
    "device_fingerprint" VARCHAR(255),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passenger_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "default_min_group_preference" INTEGER NOT NULL DEFAULT 2,
    "total_rides_completed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passenger_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "license_number" VARCHAR(100) NOT NULL,
    "verification_status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "operational_status" VARCHAR(50) NOT NULL DEFAULT 'OFFLINE',
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_user_id" UUID,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "driver_profile_id" UUID NOT NULL,
    "document_type" VARCHAR(50) NOT NULL,
    "document_url" TEXT NOT NULL,
    "verification_status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "driver_profile_id" UUID NOT NULL,
    "registration_number" VARCHAR(50) NOT NULL,
    "vehicle_type" VARCHAR(50) NOT NULL DEFAULT 'E_RICKSHAW',
    "passenger_capacity" INTEGER NOT NULL DEFAULT 4,
    "make_model" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_zones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "boundary_polygon" geometry(Polygon, 4326) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_points" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_zone_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "center_point" geometry(Point, 4326) NOT NULL,
    "radius_meters" INTEGER NOT NULL DEFAULT 150,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pickup_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fare_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL,
    "base_fare_paise" INTEGER NOT NULL DEFAULT 2000,
    "per_km_rate_paise" INTEGER NOT NULL DEFAULT 1000,
    "min_fare_paise" INTEGER NOT NULL DEFAULT 2000,
    "waiting_charge_per_min_paise" INTEGER NOT NULL DEFAULT 500,
    "waiting_free_minutes" INTEGER NOT NULL DEFAULT 5,
    "cancellation_fee_paise" INTEGER NOT NULL DEFAULT 3000,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fare_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fare_quotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "passenger_id" UUID NOT NULL,
    "pickup_point_id" UUID NOT NULL,
    "destination_location" geometry(Point, 4326) NOT NULL,
    "direct_distance_meters" INTEGER NOT NULL,
    "direct_duration_sec" INTEGER NOT NULL,
    "private_estimated_fare_paise" INTEGER NOT NULL,
    "shared_min_fare_paise" INTEGER NOT NULL DEFAULT 2000,
    "shared_max_fare_paise" INTEGER NOT NULL,
    "agreed_fare_ceiling_paise" INTEGER NOT NULL,
    "tariff_version" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fare_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "passenger_id" UUID NOT NULL,
    "fare_quote_id" UUID NOT NULL,
    "pickup_point_id" UUID NOT NULL,
    "passenger_pickup_location" geometry(Point, 4326) NOT NULL,
    "destination_location" geometry(Point, 4326) NOT NULL,
    "requested_type" VARCHAR(20) NOT NULL,
    "min_group_preference" INTEGER NOT NULL DEFAULT 2,
    "status" VARCHAR(50) NOT NULL DEFAULT 'REQUESTED',
    "agreed_fare_ceiling_paise" INTEGER NOT NULL,
    "final_allocated_fare_paise" INTEGER,
    "max_wait_deadline" TIMESTAMPTZ(6) NOT NULL,
    "cancellation_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "previous_status" VARCHAR(50) NOT NULL,
    "new_status" VARCHAR(50) NOT NULL,
    "reason" TEXT,
    "transition_time" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matching_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pickup_point_id" UUID NOT NULL,
    "batch_status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "lease_token" VARCHAR(255),
    "lease_expires_at" TIMESTAMPTZ(6),
    "total_eligible_bookings" INTEGER NOT NULL DEFAULT 0,
    "groups_formed_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "matching_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matching_batch_bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matching_batch_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pickup_point_id" UUID NOT NULL,
    "ride_type" VARCHAR(20) NOT NULL DEFAULT 'SHARED',
    "group_version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(50) NOT NULL DEFAULT 'READY_FOR_DISPATCH',
    "total_shared_fare_paise" INTEGER NOT NULL,
    "total_route_distance_meters" INTEGER NOT NULL,
    "total_route_duration_sec" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ride_group_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "dropoff_sequence_order" INTEGER NOT NULL,
    "direct_distance_meters" INTEGER NOT NULL,
    "direct_duration_sec" INTEGER NOT NULL,
    "shared_duration_sec" INTEGER NOT NULL,
    "calculated_detour_percent" DECIMAL(5,2) NOT NULL,
    "allocated_fare_paise" INTEGER NOT NULL,
    "is_active_member" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_route_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ride_group_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "route_geometry" JSONB NOT NULL,
    "total_distance_meters" INTEGER NOT NULL,
    "total_duration_sec" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_route_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_route_stops" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_route_version_id" UUID NOT NULL,
    "group_member_id" UUID NOT NULL,
    "stop_order" INTEGER NOT NULL,
    "stop_location" geometry(Point, 4326) NOT NULL,
    "stop_type" VARCHAR(20) NOT NULL DEFAULT 'DROPOFF',

    CONSTRAINT "group_route_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ride_group_id" UUID NOT NULL,
    "group_version" INTEGER NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_dispatch_offers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispatch_attempt_id" UUID NOT NULL,
    "ride_group_id" UUID NOT NULL,
    "group_version" INTEGER NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "offered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "responded_at" TIMESTAMPTZ(6),

    CONSTRAINT "driver_dispatch_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispatch_attempt_id" UUID NOT NULL,
    "ride_group_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'RESERVED',
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrived_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "driver_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ride_group_id" UUID NOT NULL,
    "driver_assignment_id" UUID NOT NULL,
    "active_driver_id" UUID NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    "current_vehicle_location" geometry(Point, 4326),
    "current_stop_order" INTEGER NOT NULL DEFAULT 0,
    "driver_arrived_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_passengers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'WAITING',
    "final_ride_fare_paise" INTEGER NOT NULL,
    "waiting_charge_paise" INTEGER NOT NULL DEFAULT 0,
    "boarded_at" TIMESTAMPTZ(6),
    "dropped_off_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_passengers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boarding_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_passenger_id" UUID NOT NULL,
    "otp_hash" VARCHAR(255) NOT NULL,
    "attempts_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),

    CONSTRAINT "boarding_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "previous_status" VARCHAR(50) NOT NULL,
    "new_status" VARCHAR(50) NOT NULL,
    "reason" TEXT,
    "transition_time" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "original_driver_id" UUID NOT NULL,
    "incident_type" VARCHAR(50) NOT NULL DEFAULT 'MECHANICAL_BREAKDOWN',
    "incident_location" geometry(Point, 4326) NOT NULL,
    "onboard_manifest_snapshot" JSONB NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'REPORTED',
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replacement_dispatch_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_incident_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replacement_dispatch_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replacement_driver_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_incident_id" UUID NOT NULL,
    "replacement_driver_id" UUID NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'ASSIGNED',
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handover_completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "replacement_driver_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fare_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_passenger_id" UUID NOT NULL,
    "adjustment_type" VARCHAR(50) NOT NULL DEFAULT 'BREAKDOWN_COMPENSATION',
    "discount_percentage" INTEGER NOT NULL DEFAULT 10,
    "adjustment_amount_paise" INTEGER NOT NULL,
    "justification" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fare_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_passenger_id" UUID NOT NULL,
    "refund_amount_paise" INTEGER NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_fees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "passenger_id" UUID NOT NULL,
    "original_booking_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL DEFAULT 3000,
    "status" VARCHAR(50) NOT NULL DEFAULT 'OUTSTANDING',
    "collected_booking_id" UUID,
    "waived_by_user_id" UUID,
    "waiver_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collected_at" TIMESTAMPTZ(6),
    "waived_at" TIMESTAMPTZ(6),

    CONSTRAINT "cancellation_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_collections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "trip_passenger_id" UUID NOT NULL,
    "total_cash_collected_paise" INTEGER NOT NULL,
    "payment_status" VARCHAR(50) NOT NULL DEFAULT 'PAID',
    "confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cash_collection_id" UUID NOT NULL,
    "obligation_type" VARCHAR(50) NOT NULL,
    "obligation_entity_id" UUID NOT NULL,
    "allocated_amount_paise" INTEGER NOT NULL,
    "allocated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(100) NOT NULL,
    "aggregate_type" VARCHAR(100) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "idempotency_key" VARCHAR(255) NOT NULL,
    "user_id" UUID NOT NULL,
    "request_path" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("idempotency_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_sub_key" ON "auth_identities"("provider_sub");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_refresh_token_hash_key" ON "user_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_token_family_id_idx" ON "user_sessions"("user_id", "token_family_id");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_profiles_user_id_key" ON "passenger_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_user_id_key" ON "driver_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_license_number_key" ON "driver_profiles"("license_number");

-- CreateIndex
CREATE INDEX "driver_profiles_verification_status_operational_status_is_o_idx" ON "driver_profiles"("verification_status", "operational_status", "is_online");

-- CreateIndex
CREATE INDEX "driver_documents_driver_profile_id_idx" ON "driver_documents"("driver_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_registration_number_key" ON "vehicles"("registration_number");

-- CreateIndex
CREATE INDEX "vehicles_driver_profile_id_idx" ON "vehicles"("driver_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_zones_name_key" ON "service_zones"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_points_name_key" ON "pickup_points"("name");

-- CreateIndex
CREATE INDEX "pickup_points_service_zone_id_idx" ON "pickup_points"("service_zone_id");

-- CreateIndex
CREATE UNIQUE INDEX "fare_configs_version_key" ON "fare_configs"("version");

-- CreateIndex
CREATE INDEX "fare_quotes_passenger_id_expires_at_idx" ON "fare_quotes"("passenger_id", "expires_at");

-- CreateIndex
CREATE INDEX "bookings_passenger_id_status_idx" ON "bookings"("passenger_id", "status");

-- CreateIndex
CREATE INDEX "bookings_pickup_point_id_status_idx" ON "bookings"("pickup_point_id", "status");

-- CreateIndex
CREATE INDEX "booking_status_history_booking_id_idx" ON "booking_status_history"("booking_id");

-- CreateIndex
CREATE INDEX "matching_batches_pickup_point_id_batch_status_idx" ON "matching_batches"("pickup_point_id", "batch_status");

-- CreateIndex
CREATE UNIQUE INDEX "matching_batch_bookings_batch_id_booking_id_key" ON "matching_batch_bookings"("batch_id", "booking_id");

-- CreateIndex
CREATE INDEX "ride_groups_pickup_point_id_status_idx" ON "ride_groups"("pickup_point_id", "status");

-- CreateIndex
CREATE INDEX "group_members_ride_group_id_booking_id_idx" ON "group_members"("ride_group_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_route_versions_ride_group_id_version_number_key" ON "group_route_versions"("ride_group_id", "version_number");

-- CreateIndex
CREATE INDEX "group_route_stops_group_route_version_id_stop_order_idx" ON "group_route_stops"("group_route_version_id", "stop_order");

-- CreateIndex
CREATE INDEX "dispatch_attempts_ride_group_id_status_idx" ON "dispatch_attempts"("ride_group_id", "status");

-- CreateIndex
CREATE INDEX "driver_dispatch_offers_driver_id_status_idx" ON "driver_dispatch_offers"("driver_id", "status");

-- CreateIndex
CREATE INDEX "driver_dispatch_offers_ride_group_id_status_idx" ON "driver_dispatch_offers"("ride_group_id", "status");

-- CreateIndex
CREATE INDEX "driver_assignments_driver_id_status_idx" ON "driver_assignments"("driver_id", "status");

-- CreateIndex
CREATE INDEX "driver_assignments_ride_group_id_status_idx" ON "driver_assignments"("ride_group_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trips_driver_assignment_id_key" ON "trips"("driver_assignment_id");

-- CreateIndex
CREATE INDEX "trips_ride_group_id_status_idx" ON "trips"("ride_group_id", "status");

-- CreateIndex
CREATE INDEX "trips_active_driver_id_status_idx" ON "trips"("active_driver_id", "status");

-- CreateIndex
CREATE INDEX "trip_passengers_trip_id_status_idx" ON "trip_passengers"("trip_id", "status");

-- CreateIndex
CREATE INDEX "trip_passengers_passenger_id_status_idx" ON "trip_passengers"("passenger_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "boarding_verifications_trip_passenger_id_key" ON "boarding_verifications"("trip_passenger_id");

-- CreateIndex
CREATE INDEX "trip_status_history_trip_id_idx" ON "trip_status_history"("trip_id");

-- CreateIndex
CREATE INDEX "trip_incidents_trip_id_status_idx" ON "trip_incidents"("trip_id", "status");

-- CreateIndex
CREATE INDEX "replacement_dispatch_attempts_trip_incident_id_idx" ON "replacement_dispatch_attempts"("trip_incident_id");

-- CreateIndex
CREATE INDEX "replacement_driver_assignments_trip_incident_id_idx" ON "replacement_driver_assignments"("trip_incident_id");

-- CreateIndex
CREATE INDEX "fare_adjustments_trip_passenger_id_idx" ON "fare_adjustments"("trip_passenger_id");

-- CreateIndex
CREATE INDEX "refund_records_trip_passenger_id_idx" ON "refund_records"("trip_passenger_id");

-- CreateIndex
CREATE INDEX "cancellation_fees_passenger_id_status_idx" ON "cancellation_fees"("passenger_id", "status");

-- CreateIndex
CREATE INDEX "cash_collections_trip_id_driver_id_idx" ON "cash_collections"("trip_id", "driver_id");

-- CreateIndex
CREATE INDEX "payment_allocations_cash_collection_id_idx" ON "payment_allocations"("cash_collection_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passenger_profiles" ADD CONSTRAINT "passenger_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_documents" ADD CONSTRAINT "driver_documents_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_service_zone_id_fkey" FOREIGN KEY ("service_zone_id") REFERENCES "service_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_quotes" ADD CONSTRAINT "fare_quotes_passenger_id_fkey" FOREIGN KEY ("passenger_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_quotes" ADD CONSTRAINT "fare_quotes_pickup_point_id_fkey" FOREIGN KEY ("pickup_point_id") REFERENCES "pickup_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_passenger_id_fkey" FOREIGN KEY ("passenger_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_fare_quote_id_fkey" FOREIGN KEY ("fare_quote_id") REFERENCES "fare_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pickup_point_id_fkey" FOREIGN KEY ("pickup_point_id") REFERENCES "pickup_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_status_history" ADD CONSTRAINT "booking_status_history_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matching_batches" ADD CONSTRAINT "matching_batches_pickup_point_id_fkey" FOREIGN KEY ("pickup_point_id") REFERENCES "pickup_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matching_batch_bookings" ADD CONSTRAINT "matching_batch_bookings_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "matching_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matching_batch_bookings" ADD CONSTRAINT "matching_batch_bookings_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_groups" ADD CONSTRAINT "ride_groups_pickup_point_id_fkey" FOREIGN KEY ("pickup_point_id") REFERENCES "pickup_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_ride_group_id_fkey" FOREIGN KEY ("ride_group_id") REFERENCES "ride_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_route_versions" ADD CONSTRAINT "group_route_versions_ride_group_id_fkey" FOREIGN KEY ("ride_group_id") REFERENCES "ride_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_route_stops" ADD CONSTRAINT "group_route_stops_group_route_version_id_fkey" FOREIGN KEY ("group_route_version_id") REFERENCES "group_route_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_route_stops" ADD CONSTRAINT "group_route_stops_group_member_id_fkey" FOREIGN KEY ("group_member_id") REFERENCES "group_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_attempts" ADD CONSTRAINT "dispatch_attempts_ride_group_id_fkey" FOREIGN KEY ("ride_group_id") REFERENCES "ride_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_dispatch_offers" ADD CONSTRAINT "driver_dispatch_offers_dispatch_attempt_id_fkey" FOREIGN KEY ("dispatch_attempt_id") REFERENCES "dispatch_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_dispatch_offers" ADD CONSTRAINT "driver_dispatch_offers_ride_group_id_fkey" FOREIGN KEY ("ride_group_id") REFERENCES "ride_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_dispatch_offers" ADD CONSTRAINT "driver_dispatch_offers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_dispatch_attempt_id_fkey" FOREIGN KEY ("dispatch_attempt_id") REFERENCES "dispatch_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_ride_group_id_fkey" FOREIGN KEY ("ride_group_id") REFERENCES "ride_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_ride_group_id_fkey" FOREIGN KEY ("ride_group_id") REFERENCES "ride_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_assignment_id_fkey" FOREIGN KEY ("driver_assignment_id") REFERENCES "driver_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_active_driver_id_fkey" FOREIGN KEY ("active_driver_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_passengers" ADD CONSTRAINT "trip_passengers_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_passengers" ADD CONSTRAINT "trip_passengers_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_passengers" ADD CONSTRAINT "trip_passengers_passenger_id_fkey" FOREIGN KEY ("passenger_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boarding_verifications" ADD CONSTRAINT "boarding_verifications_trip_passenger_id_fkey" FOREIGN KEY ("trip_passenger_id") REFERENCES "trip_passengers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_status_history" ADD CONSTRAINT "trip_status_history_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_incidents" ADD CONSTRAINT "trip_incidents_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_incidents" ADD CONSTRAINT "trip_incidents_original_driver_id_fkey" FOREIGN KEY ("original_driver_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_dispatch_attempts" ADD CONSTRAINT "replacement_dispatch_attempts_trip_incident_id_fkey" FOREIGN KEY ("trip_incident_id") REFERENCES "trip_incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_driver_assignments" ADD CONSTRAINT "replacement_driver_assignments_trip_incident_id_fkey" FOREIGN KEY ("trip_incident_id") REFERENCES "trip_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_driver_assignments" ADD CONSTRAINT "replacement_driver_assignments_replacement_driver_id_fkey" FOREIGN KEY ("replacement_driver_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_adjustments" ADD CONSTRAINT "fare_adjustments_trip_passenger_id_fkey" FOREIGN KEY ("trip_passenger_id") REFERENCES "trip_passengers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_records" ADD CONSTRAINT "refund_records_trip_passenger_id_fkey" FOREIGN KEY ("trip_passenger_id") REFERENCES "trip_passengers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_fees" ADD CONSTRAINT "cancellation_fees_passenger_id_fkey" FOREIGN KEY ("passenger_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_fees" ADD CONSTRAINT "cancellation_fees_original_booking_id_fkey" FOREIGN KEY ("original_booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_fees" ADD CONSTRAINT "cancellation_fees_collected_booking_id_fkey" FOREIGN KEY ("collected_booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_fees" ADD CONSTRAINT "cancellation_fees_waived_by_user_id_fkey" FOREIGN KEY ("waived_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_trip_passenger_id_fkey" FOREIGN KEY ("trip_passenger_id") REFERENCES "trip_passengers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_cash_collection_id_fkey" FOREIGN KEY ("cash_collection_id") REFERENCES "cash_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================
-- CRITICAL DATABASE INVARIANTS & INTEGRITY CONSTRAINTS
-- Authoritative reference: docs/DATABASE_DESIGN.md Section 4
-- =============================================================

-- Invariant 1: Exactly One Active Booking per Passenger
CREATE UNIQUE INDEX idx_unique_active_passenger_booking 
ON bookings (passenger_id) 
WHERE status IN ('REQUESTED', 'MATCHING', 'DISPATCHING', 'CONFIRMED', 'IN_PROGRESS');

-- Invariant 2: A Booking Belongs to At Most One Active Group
CREATE UNIQUE INDEX idx_unique_active_booking_in_group 
ON group_members (booking_id) 
WHERE is_active_member = true;

-- Invariant 3: Exactly One Active Assignment per Driver
CREATE UNIQUE INDEX idx_unique_active_driver_assignment 
ON driver_assignments (driver_id) 
WHERE status IN ('RESERVED', 'ACTIVE');

-- Invariant 4: Exactly One Active Assignment per Ride Group
CREATE UNIQUE INDEX idx_unique_active_group_assignment 
ON driver_assignments (ride_group_id) 
WHERE status IN ('RESERVED', 'ACTIVE');

-- Invariant 5: A Group Has At Most ONE Pending Driver Offer at a Time
CREATE UNIQUE INDEX idx_unique_single_pending_offer_per_group 
ON driver_dispatch_offers (ride_group_id) 
WHERE status = 'PENDING';

-- Invariant 6: Scoped Driver Offer Exclusion per Group Version
CREATE UNIQUE INDEX idx_unique_driver_offer_per_group_version 
ON driver_dispatch_offers (ride_group_id, group_version, dispatch_attempt_id, driver_id);

-- Invariant 7: A Cancellation Fee Cannot Be Collected Twice
CREATE UNIQUE INDEX idx_unique_collected_booking_fee 
ON cancellation_fees (collected_booking_id) 
WHERE status = 'COLLECTED';

-- Invariant 8: Spatial GiST Indexing on Geofences and Polygons
CREATE INDEX idx_pickup_points_center_gist ON pickup_points USING GIST (center_point);
CREATE INDEX idx_service_zones_boundary_gist ON service_zones USING GIST (boundary_polygon);
CREATE INDEX idx_bookings_pickup_loc_gist ON bookings USING GIST (passenger_pickup_location);
CREATE INDEX idx_bookings_dest_loc_gist ON bookings USING GIST (destination_location);
CREATE INDEX idx_trips_vehicle_loc_gist ON trips USING GIST (current_vehicle_location);
CREATE INDEX idx_trip_incidents_loc_gist ON trip_incidents USING GIST (incident_location);

-- Invariant 9: Active Outbox Queue Claiming Index
CREATE INDEX idx_outbox_events_pending 
ON outbox_events (created_at) 
WHERE status = 'PENDING';

-- Invariant 10: Single Verified Boarding per Passenger Journey
CREATE UNIQUE INDEX idx_unique_verified_passenger_boarding 
ON boarding_verifications (trip_passenger_id) 
WHERE is_verified = true;

-- Invariant 11: Idempotency Key Expiration Index
CREATE INDEX idx_idempotency_created_at 
ON idempotency_records (created_at);

-- =============================================================
-- DOMAIN CHECK CONSTRAINTS
-- Authoritative reference: docs/DATABASE_DESIGN.md Section 3
-- =============================================================

ALTER TABLE vehicles 
  ADD CONSTRAINT chk_vehicles_passenger_capacity 
  CHECK (passenger_capacity >= 1 AND passenger_capacity <= 8);

ALTER TABLE bookings 
  ADD CONSTRAINT chk_bookings_requested_type 
  CHECK (requested_type IN ('SHARED', 'PRIVATE'));

ALTER TABLE bookings 
  ADD CONSTRAINT chk_bookings_min_group_preference 
  CHECK (min_group_preference IN (2, 3, 4));

ALTER TABLE ride_groups 
  ADD CONSTRAINT chk_ride_groups_ride_type 
  CHECK (ride_type IN ('SHARED', 'PRIVATE'));

ALTER TABLE group_members 
  ADD CONSTRAINT chk_group_members_dropoff_sequence 
  CHECK (dropoff_sequence_order >= 1 AND dropoff_sequence_order <= 4);

ALTER TABLE group_members 
  ADD CONSTRAINT chk_group_members_detour_percent 
  CHECK (calculated_detour_percent <= 25.00);

ALTER TABLE cancellation_fees 
  ADD CONSTRAINT chk_cancellation_fees_amount 
  CHECK (amount_paise > 0);

ALTER TABLE cash_collections 
  ADD CONSTRAINT chk_cash_collections_total 
  CHECK (total_cash_collected_paise >= 0);

ALTER TABLE payment_allocations 
  ADD CONSTRAINT chk_payment_allocations_amount 
  CHECK (allocated_amount_paise > 0);

ALTER TABLE fare_adjustments 
  ADD CONSTRAINT chk_fare_adjustments_amount 
  CHECK (adjustment_amount_paise > 0);

ALTER TABLE refund_records 
  ADD CONSTRAINT chk_refund_records_amount 
  CHECK (refund_amount_paise > 0);
