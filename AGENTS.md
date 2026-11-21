# AI Coding Agent Instructions and Governance Directives

## On-Demand Aggregation Platform for Last-Mile Connectivity Using Shared Micro-Mobility

---

> [!IMPORTANT]
> **MANDATORY READING FOR ALL AI ASSISTANTS AND CODING AGENTS:**
> You must read and strictly adhere to the authoritative architecture specifications located in `docs/` before generating code, scaffolding projects, creating database migrations, or proposing technical modifications. The decisions in `docs/` take absolute precedence over generic coding conventions or outside defaults.

---

## 1. Absolute Architecture Guardrails

1. **Strictly Monolithic (No Microservices):**
   - The backend MUST remain a single **NestJS modular monolith** located in `apps/backend`.
   - Never introduce independent microservices, gRPC service meshes, Kafka/RabbitMQ clusters, or API gateways (Kong/Traefik).
   - Domain modules must communicate via synchronous TypeScript service interfaces in-process, or asynchronously via the **Transactional Outbox** pattern.

2. **PostgreSQL + PostGIS is the Sole Authoritative Truth:**
   - PostgreSQL 16+ is the single source of truth for all bookings, ride groups, driver assignments, financial ledgers, and user accounts.
   - **Redis is strictly an ephemeral cache** for volatile driver GPS fixes (30s TTL) and a broker for BullMQ job queues.
   - Never treat Redis, in-memory Node.js Maps, or Socket.IO state as authoritative. If Redis is flushed (`FLUSHALL`), PostgreSQL must retain 100% data integrity.

3. **Backend Authorization is Absolute (Zero Frontend Trust):**
   - The client application mode selection ("Passenger" or "Driver" in Flutter) is strictly a user interface state, NOT a security boundary.
   - The backend MUST enforce Role-Based Access Control (RBAC) on every endpoint.
   - A user cannot execute driver endpoints unless their `driver_profiles` record exists in PostgreSQL with `verification_status = 'APPROVED'`.
   - Never trust client-asserted fares, pickup locations, driver operational statuses, or booking ownership.

4. **Distributed Concurrency and Locking Guardrails:**
   - **Never use in-memory locks** (e.g., `async-mutex`, Node.js variables) to coordinate concurrency across distributed API or worker instances.
   - Concurrency must be coordinated strictly using PostgreSQL primitives:
     - Explicit pessimistic row locks: `SELECT ... FOR UPDATE`.
     - Outbox queue claiming: `SELECT ... FOR UPDATE SKIP LOCKED`.
     - Atomic conditional compare-and-swap updates: `UPDATE driver_profiles SET operational_status = 'RESERVED' WHERE id = :id AND operational_status = 'AVAILABLE'`.
     - Partial unique indexes enforced by the database engine.
   - **Never hold database transactions open** while awaiting external HTTP calls (OSRM), Socket.IO broadcasts, or user input.

5. **Mandatory Idempotency for All State Mutations:**
   - All state-mutating REST endpoints (booking creation, ride cancellations, driver acceptance, cash confirmation) must accept and enforce an `Idempotency-Key` header verified against `idempotency_records`.
   - All BullMQ background job consumers must be strictly idempotent: they must query the authoritative PostgreSQL row by UUID and verify current state before executing mutations.

---

## 2. Critical Product and Business Rules

### 2.1 The Matching Paradigm (No Passenger Acceptance Voting)
- **DO NOT implement a post-matching passenger group acceptance round.**
- Do not create passenger voting countdowns, unanimous offer acceptance checks, or passenger rejection handlers.
- Passengers give **upfront consent** to automatic grouping, maximum 4-passenger vehicle capacity, capped fares, and a maximum 25% individual detour during the booking flow (`POST /bookings`).
- The matching algorithm forms a feasible group automatically; the group moves **IMMEDIATELY** into driver dispatch.

### 2.2 Removal of Group Fingerprint Exclusion Tables
- **DO NOT create a dedicated `matching_group_attempts` or `group_fingerprint` table in the MVP database.**
- Because passenger acceptance voting has been eliminated, the loop where passengers repeatedly reject the same group is gone.
- Operational traceability is maintained through standard tables: `matching_batches`, `matching_batch_bookings`, `ride_groups`, `group_members`, and `driver_dispatch_offers`.

### 2.3 Driver Dispatch and Multi-Offer Rules
- **Strict 1-to-1 Group Dispatch:** A ride group is offered to **EXACTLY ONE driver at a time** with a 20-second timeout. Never broadcast a group to multiple drivers concurrently.
- **Driver Multi-Offer Receipt:** An active, available driver MAY receive multiple pending dispatch offers for different groups.
- **Atomic Driver Reservation:** The moment a driver accepts an offer, an atomic transaction reserves the driver, assigns the group, marks the accepted offer `ACCEPTED`, withdraws the driver's other pending offers, and marks competing offers for that group `WITHDRAWN`.
- **Driver Rejection / Timeout Invariant:**
  - If a driver explicitly rejects (`POST /drivers/offers/:id/reject`) or times out (20s elapses), **THE PASSENGER GROUP REMAINS INTACT**.
  - Passengers are NOT returned to matching.
  - The rejecting driver is excluded **strictly for the current group version and dispatch attempt**.
  - The group cascades immediately to the next ranked eligible driver.
  - If the group configuration changes (e.g., a member cancels), the group version increments, and the driver becomes eligible again.

### 2.4 Cancellation, Waiting Charges and Fee Recovery Rules
- **Cancellation Before Driver Assignment:** Free cancellation (₹0 fee). The remaining group is recalculated: if $\ge 2$ passengers and detour $\le 25\%$, the group is preserved; otherwise, it is dissolved and compliant members are rematched, **strictly preserving their original booking creation timestamps**.
- **Cancellation After Driver Assignment:** Assesses a **fixed ₹30 late cancellation fee** inserted into `cancellation_fees` as `'OUTSTANDING'`. Exempt driver inactivity $> 5\text{m}$, platform errors, and administrative waivers.
- **Waiting Charges:** First 5 minutes free; ₹5 per started minute thereafter ($W_i = 5 \times \lceil\max(0, T_i - 5)\rceil$) up to 10 minutes. Kept strictly individual; never included in shared group fare.
- **No-Show Policy:** Unboarded after 10 minutes $\rightarrow$ `NO_SHOW`, flat ₹30 penalty. **Zero additional waiting charge.**
- **Cash-Only Recovery on Next Ride:** Surcharge outstanding fees on the passenger's subsequent ride. Collect and mark `COLLECTED` atomically when the driver confirms cash receipt. **A cancellation fee must never be collected twice.**

### 2.5 Driver Breakdown and Mid-Trip Failure Rules
- **Incident Interruption:** Trip marked `'INTERRUPTED'`. Immutable passenger manifest captured in `trip_incidents`.
- **Replacement Search:** Searches available approved drivers ranked by OSRM travel time to incident location.
- **Replacement Resumption:** Trip returns to `'IN_PROGRESS'` (`trip.resumed` is an event, NOT a persistent state). Onboard passengers receive an automatic **10% discount** on final fare.
- **Replacement Failure:** If no driver available, trip marked `'ABORTED'`. Onboard passengers pay **₹0.00**. Full cash refund issued if cash collected. Platform absorbs cost.

### 2.6 Shared Early Drop-Off Policy
- Shared ride passengers cannot alter destination en route.
- Early drop-off is permitted only at an on-route safe point. Driver confirms. Passenger marked `'COMPLETED'`.
- **The original allocated fare remains completely unchanged.** Other passengers' fares and route geometry remain untouched.

### 2.7 Cash Collection & Payment Allocation Rules
- **Physical Cash Only:** Payments are strictly settled in cash between passenger and driver upon drop-off (`COMPLETED`).
- **Authoritative Backend Amount:** Driver-submitted collection amount must strictly match backend calculation (`final_ride_fare_paise + waiting_charge_paise + feeSurchargePaise`). Arbitrary inputs are rejected with 400 `INVALID_COLLECTION_AMOUNT`.
- **Payment Allocations Ledger:** Exact ledger allocations are generated for `RIDE_FARE`, `WAITING_CHARGE`, and `CANCELLATION_FEE_SURCHARGE`. Sum of allocations strictly equals total cash collected.
- **Atomic Surcharge Settlement:** When cash is confirmed, all outstanding cancellation fees for that passenger are marked `COLLECTED` atomically with `collected_booking_id` and `collected_at`.
- **Single Cash Collection per Journey:** Cash collection is permitted only once per completed passenger journey, enforced by database constraint `idx_unique_cash_collection_trip_passenger`.

---

## 3. Database Invariants to Enforce

When generating Prisma migrations or executing raw SQL queries, you must guarantee the following 11 database invariants:

1. **One Active Booking per Passenger:**
   `CREATE UNIQUE INDEX idx_unique_active_passenger_booking ON bookings (passenger_id) WHERE status IN ('REQUESTED', 'MATCHING', 'DISPATCHING', 'CONFIRMED', 'IN_PROGRESS');`
2. **One Active Group Membership per Booking:**
   `CREATE UNIQUE INDEX idx_unique_active_booking_in_group ON group_members (booking_id) WHERE is_active_member = true;`
3. **One Active Assignment per Driver:**
   `CREATE UNIQUE INDEX idx_unique_active_driver_assignment ON driver_assignments (driver_id) WHERE status IN ('RESERVED', 'ACTIVE');`
4. **One Active Assignment per Group:**
   `CREATE UNIQUE INDEX idx_unique_active_group_assignment ON driver_assignments (ride_group_id) WHERE status IN ('RESERVED', 'ACTIVE');`
5. **Single Pending Offer per Group:**
   `CREATE UNIQUE INDEX idx_unique_single_pending_offer_per_group ON driver_dispatch_offers (ride_group_id) WHERE status = 'PENDING';`
6. **Scoped Driver Offer Exclusion:**
   `CREATE UNIQUE INDEX idx_unique_driver_offer_per_group_version ON driver_dispatch_offers (ride_group_id, group_version, dispatch_attempt_id, driver_id);`
7. **Single Cancellation Fee per Booking and Single Cash Collection per Journey:**
   `CREATE UNIQUE INDEX idx_unique_cancellation_fee_per_booking ON cancellation_fees (original_booking_id);`
   `CREATE UNIQUE INDEX idx_unique_cash_collection_trip_passenger ON cash_collections (trip_passenger_id);`
8. **Group Capacity Limits:** A shared group must maintain between 2 and 4 passengers while active for dispatch.
9. **Ownership Protection:** A passenger can never cancel or query another passenger's booking.
10. **Driver Eligibility:** Only administrator-approved (`verification_status = 'APPROVED'`), online (`is_online = true`), unsuspended drivers can receive or accept offers.
11. **PostGIS Geofencing:** Pickup coordinates must fall within 150m of PDEU zone center; drop-off coordinates must reside strictly within the Gandhinagar service region polygon.

---

## 4. Environment and Mobile Development Guardrails

1. **Strict ₹0 Budget Constraint:**
   - Do not integrate paid third-party APIs (Google Directions, Mapbox SDK, Twilio, SendGrid, Stripe, Razorpay).
   - Use local OSRM on OpenStreetMap data, free OSM raster tiles via `flutter_map`, and cash settlement.
2. **Mac Host Machine Safety:**
   - **Do not alter global macOS configuration:** Do not modify the system `PATH`, change system Python `/usr/bin/python3`, modify Homebrew system permissions, or reconfigure global network proxies.
   - Keep all credentials, database passwords, and secrets inside local `.env` files (ignored by Git). Commit `.env.example` placeholders only.
3. **No Premature DevOps / CI/CD:**
   - Do not add GitHub Actions CI/CD workflows, Docker Compose requirements, or Kubernetes manifests to the MVP deliverable.
4. **Mobile Target Priority:**
   - Both Android and iOS are official project targets.
   - Current development priority: VS Code / Antigravity IDE with Xcode and the iOS Simulator as the primary initial development/testing environment, alongside physical iPhone validation. Android Studio and Emulator are configured in Phase 2.
5. **Stage 9 Dependency Lock:**
   - **Do not begin Stage 9 (Breakdown Management & Replacement Dispatch) implementation planning until Stages 1 through 8 have passed all verification gates.**

---

*Adhere to these instructions strictly across all implementation tasks.*
