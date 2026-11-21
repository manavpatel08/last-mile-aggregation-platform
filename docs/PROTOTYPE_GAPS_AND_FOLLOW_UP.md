# Prototype Gaps and Production Follow-Up

## Overview

This document records deferred production-level edge cases, retry/recovery limitations, realtime tracking dependencies, remaining lifecycle stages, and temporary demo assumptions for the Flutter Active Trip and Passenger Boarding flow (TASK-013).

---

## 1. Production-Level Edge Cases Not Implemented

1. **Strict PostGIS Geofence Rejection Handling:**
   - In production, `POST /api/v1/trips/:id/arrive-pickup` requires the driver's GPS fix to be within 150m of the PDEU pickup hub (`ST_DWithin`).
   - If the backend rejects arrival with `OUTSIDE_PICKUP_GEOFENCE` or `MISSING_GPS_FIX` (due to Redis GPS key expiration after 30s), the current mobile UI shows an error banner. An automated prompt guiding the driver towards the hub center or requesting a high-accuracy GPS fix is deferred to Phase 2.

2. **OTP Brute-Force Lockout Recovery:**
   - The backend enforces a hard limit of 3 failed verification attempts (`max_attempts = 3`).
   - Upon the 3rd failed attempt (`OTP_MAX_ATTEMPTS_EXCEEDED`), the passenger's OTP verification is permanently locked. In production, this requires an administrative or dispatcher override flow, or manual passenger identification check by phone. The current mobile UI reports the error banner but does not include manual dispatcher override tools.

3. **Passenger No-Show Declaration (10-Minute Timeout):**
   - Under Section 2.4 of `AGENTS.md`, passengers who do not board after 10 minutes at the hub are declared `NO_SHOW` with a flat ₹30 penalty.
   - The UI currently displays the passenger boarding state, but the driver-triggered `POST /api/v1/trips/:id/passengers/:passengerId/no-show` countdown timer and button are deferred to Stage 8.

4. **Concurrent Multi-Passenger Boarding Race Conditions:**
   - When multiple passengers board an e-rickshaw simultaneously, the driver can enter OTPs sequentially. While backend mutations are protected by atomic transactions and idempotency keys, optimistic local state reconciliation does not lock other input fields while one verification is in-flight.

---

## 2. Deferred Retry and Recovery Improvements

1. **Offline Queueing for OTP Verification:**
   - If network connectivity drops while the driver inputs an OTP at the pickup hub, the request fails with a connection error.
   - Offline queueing with background retry (e.g., using Hive or SQLite outbox queue on the device) is deferred to production hardening.

2. **Ambiguous Network Dropout Reconciliation:**
   - If `POST /api/v1/trips/:id/verify-boarding` succeeds on the server but the response times out or drops on the cellular network, the driver may retry.
   - The mobile provider currently reuses the cached idempotency key (`verify_${tripId}_${passengerId}`) so that replaying returns the cached 200 response without incrementing the failure attempt counter. However, an automated background reconciliation query (`GET /api/v1/trips/:id`) on reconnect is deferred.

3. **Boarding Pass In-Memory Expiration Timer:**
   - The passenger boarding pass model contains `expiresAt`. If the pass expires while the screen is open, the passenger must manually tap "Refresh" to trigger fallback re-derivation from the server. An active ticker timer auto-refreshing before expiration is deferred.

---

## 3. Realtime and Live Tracking Dependencies

1. **Socket.IO Room Subscriptions (`trip:<tripId>`):**
   - Current implementation uses REST polling/pull (`GET /bookings/:id/boarding-pass` and `GET /trips/:id`) rather than live WebSocket events.
   - In production, the client must subscribe to the Socket.IO room `trip:<tripId>` to receive:
     - `trip.driver_arrived`: Immediately flips the passenger UI to "Driver Arrived at Hub".
     - `passenger.boarded`: Immediately flips the passenger UI to "Boarded — Ride Starting Soon".
     - `driver.location`: Live map telemetry pin of the approaching e-rickshaw.

2. **Driver Background GPS Fix Pipeline:**
   - The driver arrival verification on the backend requires a fresh ($\le 30\text{s}$) telemetry record in Redis (`driver:gps:<driverId>`).
   - For demo and unit testing, the driver arrival endpoint is tested against mocked or seeded Redis fixes. Continuous background location ingestion (`POST /api/v1/drivers/location`) is not bundled into the boarding screen lifecycle.

---

## 4. Remaining Trip Progression Work (Post-Boarding)

1. **Trip Departure / Start (`POST /api/v1/trips/:id/start`):**
   - Once all non-cancelled passengers in the group have `status = 'BOARDED'`, the driver initiates trip departure.
   - The endpoint `POST /api/v1/trips/:id/start` transitions the trip to `'IN_PROGRESS'`. This button and route transition will be integrated in Stage 8.

2. **Individual Drop-Off Completion (`POST /api/v1/trips/:id/passengers/:passengerId/complete`):**
   - As the shared e-rickshaw drops off each passenger at their destination in Gandhinagar, the driver confirms individual drop-off.
   - This screen and state management are deferred to Stage 8.

3. **Trip Finalization (`POST /api/v1/trips/:id/complete`):**
   - Once all passengers are dropped off or marked no-show, the vehicle trip is finalized and the driver returns to `AVAILABLE`.
   - Deferred to Stage 8.

4. **Cash Settlement and Fee Recovery:**
   - Cash collection and outstanding fee settlement workflows occur at passenger drop-off and trip end.
   - Deferred to Stage 8.

---

## 5. Temporary Demo Assumptions

1. **Single-Device or Simulator Demo Execution:**
   - For demo and local verification purposes, the passenger active trip screen and driver trip manifest screen can be rendered independently or verified via focused widget and provider suites without requiring concurrent physical multi-device GPS movement.
2. **Fixed Hub Geofence Bypass for Mock Environments:**
   - In automated tests, `TripRepository` is mocked or stubbed with pre-configured arrival responses and boarding OTPs (`4821`), avoiding physical movement to PDEU Main Gate.
3. **Isolated Component Architecture:**
   - To prevent merge conflicts with in-flight notification work on `feat/notification-implementation`, active trip boarding components reside exclusively in `apps/mobile/lib/features/trip/` without direct modifications to shared global routes (`app_routes.dart`, `app_router.dart`, `app.dart`). Global routing will be wired during branch consolidation.
