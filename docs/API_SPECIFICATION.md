# REST and Realtime API Specification

## On-Demand Aggregation Platform for Last-Mile Connectivity Using Shared Micro-Mobility

---

## 1. Global API Conventions

### 1.1 Transport and Addressing
- **Base Protocol:** HTTPS for REST, WSS for WebSockets.
- **REST Base Path:** `/api/v1`
- **Realtime Gateway:** `/realtime` (Socket.IO namespace `/`)
- **Payload Format:** Strict JSON (`application/json; charset=utf-8`).
- **Identifiers:** Canonical UUIDv4 strings.
- **Timestamps:** ISO 8601 UTC strings with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- **Spatial Coordinates:** WGS 84 (SRID 4326) `{ "latitude": float, "longitude": float }`.
- **Monetary Representations:** Stored internally in integer **paise**; REST APIs return formatted rupee decimal strings (e.g., `"45.00"` representing ₹45.00) alongside raw integer paise fields (`4500`).

### 1.2 Authentication and Idempotency Headers
All secured endpoints require an HTTP `Authorization` Bearer token:
```http
Authorization: Bearer <jwt-access-token>
```
Mutating operations sensitive to network retries (booking creation, cancellations, offer acceptances, cash confirmations) enforce the `Idempotency-Key` header:
```http
Idempotency-Key: <unique-uuid-or-client-nonce>
```

### 1.3 Standard Response Envelopes

**Success Envelope (HTTP 200 / 201):**
```json
{
  "success": true,
  "statusCode": 200,
  "message": "Operation completed successfully",
  "data": {},
  "timestamp": "2026-11-17T12:00:00.000Z"
}
```

**Error Envelope (HTTP 4xx / 5xx):**
```json
{
  "success": false,
  "statusCode": 409,
  "errorCode": "BOOKING_ALREADY_ACTIVE",
  "message": "Passenger already has an active booking in progress.",
  "errors": [],
  "timestamp": "2026-11-17T12:00:00.000Z",
  "path": "/api/v1/bookings"
}
```

---

## 2. Standard Error Codes Catalogue

| Error Code | HTTP Status | Meaning & Cause |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing, malformed, or expired JWT access token. |
| `FORBIDDEN` | 403 | Insufficient RBAC role or unapproved driver attempting privileged action. |
| `BOOKING_ALREADY_ACTIVE` | 409 | Passenger already possesses an active booking (`REQUESTED`, `MATCHING`, `DISPATCHING`, `CONFIRMED`, `IN_PROGRESS`). |
| `QUOTE_EXPIRED` | 400 | Fare quote exceeds its 2-minute validity window. |
| `PICKUP_OUTSIDE_GEOFENCE` | 400 | Pickup coordinate is $> 150\text{m}$ from the PDEU zone center. |
| `OUTSIDE_PICKUP_GEOFENCE` | 400 | Driver location exceeds authorized 150m geofence limit of PDEU pickup hub. |
| `MISSING_GPS_FIX` | 400 | No recorded telemetry fix found for driver in Redis cache. |
| `STALE_GPS_FIX` | 400 | Driver GPS fix exceeds 30-second freshness window. |
| `INVALID_GPS_FIX` | 400 | Driver GPS fix contains missing or out-of-bounds coordinates. |
| `DESTINATION_OUTSIDE_SERVICE_AREA`| 400 | Destination coordinate lies outside the Gandhinagar service polygon. |
| `FARE_CEILING_EXCEEDED` | 422 | Calculated shared fare exceeds the passenger's agreed fare ceiling. |
| `OFFER_EXPIRED` | 410 | Driver dispatch offer exceeded its 20-second timeout window. |
| `OFFER_ALREADY_TAKEN` | 409 | Driver or group has already been reserved by a competing concurrent acceptance. |
| `INVALID_GROUP_VERSION` | 409 | Attempting an action on an obsolete group version after a member cancellation. |
| `INVALID_OTP` | 400 | Boarding OTP hash does not match or max attempts exceeded. |
| `NO_SHOW_DEADLINE_NOT_REACHED` | 400 | Driver attempting to declare no-show before the 10-minute waiting window elapses. |
| `TRIP_ALREADY_COMPLETED` | 409 | Mutating a trip that has already been finalized or aborted. |
| `INSUFFICIENT_VEHICLE_CAPACITY` | 422 | Replacement driver vehicle does not possess enough seats for onboard passengers. |
| `SERVICE_UNAVAILABLE` | 503 | Database or local OSRM routing engine unreachable. |

---

## 3. Comprehensive REST Endpoint Specifications

### Area 1: Authentication and Session Security

#### 1.1 Authenticate with Google
- **Method & Path:** `POST /api/v1/auth/google`
- **Auth:** Public
- **Request Body:**
  ```json
  { "idToken": "eyJhbGciOiJSUzI1NiIs..." }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "user": { "id": "uuid", "email": "aarav@pdeu.ac.in", "role": "PASSENGER" },
      "accessToken": "jwt-access-token",
      "refreshToken": "opaque-refresh-token",
      "expiresIn": 900
    }
  }
```
- **Validation:** Verifies Google signature, `aud`, `iss`, and expiration against Google JWKS.
- **Side Effects:** Inserts/updates `users`, `auth_identities`, and `user_sessions`.

#### 1.2 Rotate Refresh Token
- **Method & Path:** `POST /api/v1/auth/refresh`
- **Auth:** Public
- **Request Body:** `{ "refreshToken": "opaque-refresh-token" }`
- **Response (200 OK):** Issues new access token (15m) and rotated refresh token (30d max). Revokes token family on reuse.

#### 1.3 Terminate Session (Logout)
- **Method & Path:** `POST /api/v1/auth/logout`
- **Auth:** Bearer Token
- **Side Effects:** Marks session `revoked_at = NOW()`.

#### 1.4 Terminate All Sessions
- **Method & Path:** `POST /api/v1/auth/logout-all`
- **Auth:** Bearer Token
- **Side Effects:** Revokes all sessions belonging to the user UUID.

#### 1.5 Generate Short-Lived Socket Ticket
- **Method & Path:** `GET /api/v1/auth/socket-ticket`
- **Auth:** Bearer Token
- **Response (200 OK):**
  ```json
  { "success": true, "data": { "ticket": "single-use-uuid", "expiresIn": 60 } }
  ```

---

### Area 2: User and Passenger Profiles

#### 2.1 Get Current User Profile
- **Method & Path:** `GET /api/v1/users/me`
- **Auth:** Bearer Token (Any Role)
- **Response (200 OK):** Returns user details, active role, passenger profile, and outstanding cancellation fees.

#### 2.2 Update Profile Preferences
- **Method & Path:** `PATCH /api/v1/users/me`
- **Auth:** Bearer Token (Any Role)
- **Request Body:** `{ "defaultMinGroupPreference": 3 }`

---

### Area 3: Driver Onboarding and Administration

#### 3.1 Submit Driver Onboarding Application
- **Method & Path:** `POST /api/v1/drivers/onboard`
- **Auth:** Bearer Token (`PASSENGER` upgrading to `DRIVER`)
- **Request Body:**
  ```json
  {
    "licenseNumber": "GJ-01-2023-0012345",
    "vehicle": {
      "registrationNumber": "GJ-01-AA-1234",
      "vehicleType": "E_RICKSHAW",
      "passengerCapacity": 4,
      "makeModel": "Mahindra Treo"
    }
  }
  ```
- **State Transition:** Creates `driver_profiles` with `verification_status = 'PENDING'`.

#### 3.2 Upload Driver Documents
- **Method & Path:** `POST /api/v1/drivers/documents`
- **Auth:** Bearer Token (`DRIVER`)
- **Request Body:** `{ "documentType": "DRIVING_LICENSE", "documentUrl": "/uploads/lic_123.pdf" }`

#### 3.3 Admin: List Pending Drivers
- **Method & Path:** `GET /api/v1/admin/drivers/pending`
- **Auth:** Bearer Token (`ADMIN`)

#### 3.4 Admin: Approve Driver
- **Method & Path:** `POST /api/v1/admin/drivers/:id/approve`
- **Auth:** Bearer Token (`ADMIN`)
- **State Transition:** `verification_status` $\rightarrow$ `'APPROVED'`. Emits `admin.driver.approved`.

#### 3.5 Admin: Reject Driver
- **Method & Path:** `POST /api/v1/admin/drivers/:id/reject`
- **Auth:** Bearer Token (`ADMIN`)
- **Request Body:** `{ "rejectionReason": "Blurry driving license image." }`

---

### Area 4: Vehicle Management

#### 4.1 Register Additional Vehicle
- **Method & Path:** `POST /api/v1/drivers/vehicles`
- **Auth:** Bearer Token (`DRIVER`)

#### 4.2 List Driver Vehicles
- **Method & Path:** `GET /api/v1/drivers/vehicles`
- **Auth:** Bearer Token (`DRIVER`)

---

### Area 5: Service Zones and Pickup Points

#### 5.1 List Authorized Pickup Points
- **Method & Path:** `GET /api/v1/locations/pickup-zones`
- **Auth:** Public / Bearer Token
- **Response (200 OK):** Returns active pickup points with PostGIS coordinates and geofence radii.

#### 5.2 Get Service Region Polygon
- **Method & Path:** `GET /api/v1/locations/service-regions`
- **Auth:** Public / Bearer Token
- **Response (200 OK):** GeoJSON Polygon of Gandhinagar service area.

---

### Area 6: Location Geofence Validation

#### 6.1 Validate Pickup Geofence
- **Method & Path:** `POST /api/v1/locations/validate-pickup`
- **Auth:** Bearer Token
- **Request Body:** `{ "pickupPointId": "uuid", "latitude": 23.1550, "longitude": 72.6668 }`
- **Validation:** Executes PostGIS `ST_DWithin(center_point, ST_MakePoint(lng, lat), radius_meters)`.

#### 6.2 Validate Destination Polygon
- **Method & Path:** `POST /api/v1/locations/validate-destination`
- **Auth:** Bearer Token
- **Validation:** Executes PostGIS `ST_Contains(boundary_polygon, ST_MakePoint(lng, lat))`.

---

### Area 7: Fare Quotes and Ceilings

#### 7.1 Generate Fare Quote
- **Method & Path:** `POST /api/v1/fares/quotes`
- **Auth:** Bearer Token (`PASSENGER`)
- **Request Body:**
  ```json
  {
    "pickupPointId": "uuid",
    "destination": { "latitude": 23.1812, "longitude": 72.6345 }
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "quoteId": "quote-uuid",
      "directDistanceMeters": 4200,
      "directDurationSec": 540,
      "privateEstimatedFare": "62.00",
      "privateEstimatedFarePaise": 6200,
      "sharedEstimatedRange": {
        "minFare": "20.00",
        "maxFare": "62.00"
      },
      "sharedEstimatedRangePaise": {
        "minFarePaise": 2000,
        "maxFarePaise": 6200
      },
      "agreedFareCeiling": "62.00",
      "agreedFareCeilingPaise": 6200,
      "tariffVersion": 1,
      "expiresAt": "2026-11-17T12:02:00.000Z",
      "outstandingLateFeeSurcharge": "30.00",
      "outstandingLateFeeSurchargePaise": 3000,
      "totalCashToCollect": {
        "private": "92.00",
        "sharedRange": {
          "minFare": "50.00",
          "maxFare": "92.00"
        }
      },
      "totalCashToCollectPaise": {
        "privatePaise": 9200,
        "sharedRangePaise": {
          "minFarePaise": 5000,
          "maxFarePaise": 9200
        }
      }
    }
  }
  ```
- **Behavior:** Calls OSRM Table/Route for direct road distance. Returns 2-minute valid quote. Surcharge disclosure separates uncollected late cancellation penalties without inflating the agreed ride fare ceiling.

---

### Area 8: Bookings and Upfront Consent

#### 8.1 Create Booking (Upfront Consent)
- **Method & Path:** `POST /api/v1/bookings`
- **Auth:** Bearer Token (`PASSENGER`)
- **Headers:** `Idempotency-Key: <uuid>` (Mandatory)
- **Request Body:**
  ```json
  {
    "quoteId": "quote-uuid",
    "requestedType": "SHARED",
    "minGroupPreference": 2,
    "passengerPickupLocation": { "latitude": 23.1550, "longitude": 72.6668 },
    "upfrontConsentAgreed": true
  }
  ```
- **Response (201 Created):**
  ```json
  {
    "success": true,
    "data": {
      "bookingId": "booking-uuid",
      "status": "REQUESTED",
      "maxWaitDeadline": "2026-11-17T12:04:00.000Z",
      "agreedFareCeiling": "62.00"
    }
  }
  ```
- **Invariants Enforced:** Exactly one active booking per passenger. Validates 150m geofence and quote expiry. Inserts `outbox_events` (`BOOKING_CREATED`).

#### 8.2 Get Booking Details
- **Method & Path:** `GET /api/v1/bookings/:id`
- **Auth:** Bearer Token (Booking Owner or Assigned Driver)

#### 8.3 Cancel Booking
- **Method & Path:** `POST /api/v1/bookings/:id/cancel`
- **Auth:** Bearer Token (Booking Owner)
- **Headers:** `Idempotency-Key: <uuid>`
- **Request Body:** `{ "reason": "Change of plans" }`
- **Response (200 OK):**
  - *If before driver assignment:* Status $\rightarrow$ `CANCELLED`. Fee assessed = ₹0. Group recalculated.
  - *If after driver assignment:* Status $\rightarrow$ `CANCELLED`. Late fee assessed = ₹30 (inserted into `cancellation_fees`). Driver notified.

#### 8.4 Get Passenger Boarding Pass
- **Method & Path:** `GET /api/v1/bookings/:id/boarding-pass`
- **Auth:** Bearer Token (`PASSENGER`, must match booking owner `passenger_id`)
- **Headers:** `Authorization: Bearer <jwt>`
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "bookingId": "booking-uuid",
      "passengerId": "passenger-uuid",
      "tripId": "trip-uuid",
      "boardingOtp": "4821",
      "expiresAt": "2026-11-21T12:30:00.000Z",
      "bookingStatus": "DRIVER_ASSIGNED",
      "driver": {
        "name": "Ramesh Patel",
        "phoneNumber": "+919876543210",
        "vehicle": {
          "registrationNumber": "GJ01AB1234",
          "makeModel": "Mahindra Treo",
          "vehicleType": "E_RICKSHAW"
        }
      }
    }
  }
  ```
- **Lifecycle & Security Invariants:**
  - Accessible strictly to the authenticated owner passenger (`user.id === booking.passenger_id`). Drivers and unrelated passengers receive `403 FORBIDDEN`.
  - Accessible only while booking status is `DRIVER_ASSIGNED` or `DRIVER_ARRIVED`.
  - Returns `400 BOOKING_NOT_ASSIGNED` if booking is in unassigned status (`REQUESTED`, `MATCHING`, `MATCHED`, `DISPATCHING`, `CONFIRMED`).
  - Returns `400 OTP_ALREADY_CONSUMED` if booking is `BOARDED`, `IN_PROGRESS`, or `COMPLETED`.
  - Returns `400 BOOKING_NOT_ACTIVE` if booking is `CANCELLED`, `EXPIRED`, or `NO_SHOW`.
  - Returns `400 OTP_ALREADY_VERIFIED` if `boardingVerification.isVerified = true`.
  - Returns `400 OTP_EXPIRED` if current time exceeds `expiresAt`.
  - Returns `400 OTP_MAX_ATTEMPTS_EXCEEDED` if `attemptsCount >= maxAttempts`.
  - Plaintext OTP is stored exclusively in ephemeral Redis cache with a 30-minute TTL (or remaining expiry); PostgreSQL stores strictly the SHA-256 hash `otp_hash`.
  - In case of Redis cache miss, eviction, or server restart, the 4-digit OTP is deterministically re-derived using HMAC-SHA256(`bookingId`, `assignmentId`), verified against `otp_hash`, and repopulated into Redis.

---

### Area 9: Matching and Group Status

#### 9.1 Get Booking Group Status
- **Method & Path:** `GET /api/v1/bookings/:id/group`
- **Auth:** Bearer Token (Booking Owner)
- **Response (200 OK):** Returns group version, members count, assigned driver ETA, and allocated fare.

---

### Area 10: Driver Online Availability

#### 10.1 Update Driver Operational Status
- **Method & Path:** `PATCH /api/v1/drivers/status`
- **Auth:** Bearer Token (`DRIVER`, `verification_status = 'APPROVED'`)
- **Request Body:** `{ "isOnline": true }`
- **State Transition:** If true, sets `operational_status = 'AVAILABLE'`; if false and no active trip, sets `'OFFLINE'`.

---

### Area 11: Driver Dispatch Offers and Acceptance

#### 11.1 List Pending Offers for Driver
- **Method & Path:** `GET /api/v1/drivers/offers/pending`
- **Auth:** Bearer Token (`DRIVER`)
- **Response (200 OK):** Returns array of pending dispatch offers for that driver with remaining countdown timers.

#### 11.2 Accept Dispatch Offer (Atomic Reservation)
- **Method & Path:** `POST /api/v1/drivers/offers/:id/accept`
- **Auth:** Bearer Token (`DRIVER`)
- **Headers:** `Idempotency-Key: <uuid>` (Mandatory)
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "assignmentId": "assign-uuid",
      "tripId": "trip-uuid",
      "rideGroupId": "group-uuid",
      "passengerCount": 3,
      "totalEstimatedFare": "114.00",
      "navigationRoute": { "geometry": "GeoJSON...", "stops": [] }
    }
  }
  ```
- **Concurrency & Locking:** Inside a PostgreSQL transaction, executes `SELECT ... FOR UPDATE` on `ride_groups` and conditional CAS on `driver_profiles` (`WHERE operational_status = 'AVAILABLE'`). Sets offer `ACCEPTED`, driver `RESERVED`, marks competing offers `WITHDRAWN`.

#### 11.3 Reject Dispatch Offer
- **Method & Path:** `POST /api/v1/drivers/offers/:id/reject`
- **Auth:** Bearer Token (`DRIVER`)
- **Request Body:** `{ "reason": "Too far from pickup hub" }`
- **State Transition:** Sets offer `REJECTED`. Driver is excluded strictly for that group version. Group cascades immediately to the next ranked driver.

---

### Area 12: Driver GPS Telemetry (REST Fallback)

#### 12.1 Ingest Driver GPS Fix
- **Method & Path:** `POST /api/v1/drivers/location`
- **Auth:** Bearer Token (`DRIVER`)
- **Request Body:**
  ```json
  {
    "latitude": 23.1555,
    "longitude": 72.6670,
    "heading": 180.5,
    "speed": 6.2
  }
  ```
- **Behavior:** Updates Redis cache (TTL 30s) and broadcasts to active trip room.

---

### Area 13: Driver Arrival at Pickup Hub

#### 13.1 Driver Reports Arrival
- **Method & Path:** `POST /api/v1/trips/:id/arrive-pickup`
- **Auth:** Bearer Token (Assigned Driver)
- **Request Body:** None. Frontend-supplied coordinates are strictly forbidden and ignored.
- **Location Verification:** The platform server exclusively reads the driver's authoritative GPS telemetry from Redis (`driver:gps:<driverId>`). Telemetry must be fresh ($\le 30\text{s}$ old) and coordinates must lie within the PostGIS $150\text{m}$ PDEU pickup hub geofence (`ST_DWithin`).
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Driver arrival confirmed",
    "data": {
      "tripId": "uuid",
      "status": "AT_PICKUP",
      "driverArrivedAt": "2026-11-21T22:30:00.000Z"
    }
  }
  ```
- **Error Codes:**
  - `400 MISSING_GPS_FIX`: No GPS telemetry recorded in Redis cache.
  - `400 STALE_GPS_FIX`: GPS fix is older than 30 seconds.
  - `400 INVALID_GPS_FIX`: GPS coordinates corrupted or invalid.
  - `400 OUTSIDE_PICKUP_GEOFENCE`: Driver is further than 150m from PDEU pickup point.
  - `400 INVALID_TRIP_STATUS_FOR_ARRIVAL`: Trip is not in `CREATED` or `DRIVER_EN_ROUTE` status.
  - `403 DRIVER_NOT_ASSIGNED_TO_TRIP`: Authenticated driver is not assigned to this trip.
  - `404 TRIP_NOT_FOUND`: Trip does not exist.
- **State Transition:** Sets trip status `'AT_PICKUP'`, records `driver_arrived_at = NOW()`. Starts individual 5-minute free waiting timer. Transitions associated bookings to `'DRIVER_ARRIVED'`. Emits `TRIP_DRIVER_ARRIVED` outbox event.
- **Idempotency:** Replaying arrival for an already `'AT_PICKUP'` trip returns the original `driver_arrived_at` timestamp without resetting the timer or re-evaluating GPS.

---

### Area 14: Boarding Verification (OTP)

#### 14.1 Verify Passenger Boarding OTP
- **Method & Path:** `POST /api/v1/trips/:id/verify-boarding`
- **Auth:** Bearer Token (Assigned Driver)
- **Request Body:** `{ "passengerId": "uuid", "otp": "4821" }`
- **Response (200 OK):**
  ```json
  { "success": true, "message": "Passenger boarding verified", "data": { "passengerStatus": "BOARDED" } }
  ```
- **Validation:** Matches SHA-256 hash. Enforces 3 maximum attempts. Authoritative for stopping waiting charge timer.

---

### Area 15: Trip Start and Completion

#### 15.1 Start Trip
- **Method & Path:** `POST /api/v1/trips/:id/start`
- **Auth:** Bearer Token (Assigned Driver)
- **Validation:** All non-cancelled passengers must be `BOARDED`. Sets trip status `'IN_PROGRESS'`.

#### 15.2 Finalize Vehicle Trip
- **Method & Path:** `POST /api/v1/trips/:id/complete`
- **Auth:** Bearer Token (Assigned Driver)
- **Validation:** All passenger journeys must be finalized (`COMPLETED` or `NO_SHOW`). Sets trip `'COMPLETED'`, driver `'AVAILABLE'`.

---

### Area 16: Individual Passenger Drop-Off Completion

#### 16.1 Complete Individual Drop-Off
- **Method & Path:** `POST /api/v1/trips/:id/passengers/:passengerId/complete`
- **Auth:** Bearer Token (Assigned Driver)
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "passengerId": "uuid",
      "rideFare": "38.00",
      "waitingCharge": "0.00",
      "totalCashToCollect": "38.00"
    }
  }
  ```
- **State Transition:** Marks `trip_passengers` status `'COMPLETED'`. Computes allocated ride fare and waiting charges for passenger completion (cancellation fee recovery is processed during Stage 8 cash confirmation).

---

### Area 17: Destination Alteration (Private Ride Only)

#### 17.1 Request Private Destination Change
- **Method & Path:** `POST /api/v1/bookings/:id/change-destination`
- **Auth:** Bearer Token (Booking Owner, Private Ride Only)
- **Request Body:** `{ "newDestination": { "latitude": 23.1900, "longitude": 72.6200 } }`
- **Response (200 OK):** Recalculates route and shows updated fare quote.

#### 17.2 Confirm Destination Change
- **Method & Path:** `POST /api/v1/bookings/:id/confirm-destination-change`
- **Auth:** Bearer Token (Booking Owner)
- **State Transition:** Updates destination and fare ceiling.

---

### Area 18: Passenger No-Show Declaration

#### 18.1 Declare Passenger No-Show
- **Method & Path:** `POST /api/v1/trips/:id/passengers/:passengerId/no-show`
- **Auth:** Bearer Token (Assigned Driver)
- **Validation:** Must be $\ge 10\text{ minutes}$ since `driver_arrived_at`.
- **State Transition:** Sets passenger status `'NO_SHOW'`, assesses flat ₹30 fee into `cancellation_fees` as `'OUTSTANDING'`. Charges ₹0 waiting fee.

---

### Area 19: Physical Cash Confirmation

#### 19.1 Confirm Cash Receipt
- **Method & Path:** `POST /api/v1/payments/confirm-cash`
- **Auth:** Bearer Token (Assigned Driver, requires `verification_status = 'APPROVED'`)
- **Headers:** `Idempotency-Key: <uuid>` (Mandatory)
- **Request Body:**
  ```json
  {
    "tripId": "trip-uuid",
    "tripPassengerId": "trip-passenger-uuid",
    "amountCollectedPaise": 6800
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Cash payment confirmed successfully",
    "data": {
      "collectionId": "collection-uuid",
      "tripId": "trip-uuid",
      "tripPassengerId": "trip-passenger-uuid",
      "driverId": "driver-profile-uuid",
      "totalCashCollectedPaise": 6800,
      "totalCashCollected": "68.00",
      "rideFarePaise": 3800,
      "rideFare": "38.00",
      "waitingChargePaise": 0,
      "waitingCharge": "0.00",
      "surchargeFeesPaise": 3000,
      "surchargeFees": "30.00",
      "collectedFeeIds": ["fee-uuid"],
      "paymentStatus": "PAID",
      "confirmedAt": "2026-11-22T02:00:00.000Z",
      "paymentAllocations": [
        {
          "id": "alloc-1-uuid",
          "obligationType": "RIDE_FARE",
          "obligationEntityId": "trip-passenger-uuid",
          "allocatedAmountPaise": 3800,
          "allocatedAmount": "38.00"
        },
        {
          "id": "alloc-2-uuid",
          "obligationType": "CANCELLATION_FEE_SURCHARGE",
          "obligationEntityId": "fee-uuid",
          "allocatedAmountPaise": 3000,
          "allocatedAmount": "30.00"
        }
      ]
    }
  }
  ```
- **State Transition:** Atomically creates `cash_collections` and `payment_allocations`. If outstanding cancellation fees were surcharged, atomically updates fees to `'COLLECTED'` with `collected_booking_id` and `collected_at`. Emits `CASH_PAYMENT_CONFIRMED` outbox event.
- **Constraints & Invariants:**
  - Cash collection permitted only when `trip_passengers.status === 'COMPLETED'`.
  - Amount collected must match authoritative backend total exactly (`final_ride_fare_paise + waiting_charge_paise + surcharge_fees_paise`), else rejected with 400 `INVALID_COLLECTION_AMOUNT`.
  - Enforces database Invariant 7: exactly one cash collection per journey (`idx_unique_cash_collection_trip_passenger`). Subsequent calls for same passenger journey are rejected with 409 Conflict `CASH_ALREADY_COLLECTED`.
  - Supports duplicate request idempotency via `Idempotency-Key` header.

#### 19.2 Retrieve Cash Collection Receipt
- **Method & Path:** `GET /api/v1/payments/receipts/:tripPassengerId` (Alias: `GET /api/v1/payments/cash-receipts/:tripPassengerId`)
- **Auth:** Bearer Token (Approved Driver: either the currently assigned driver of the trip or the historical driver recorded on the cash collection; requires `verification_status = 'APPROVED'`)
- **Path Parameters:**
  - `tripPassengerId` (UUID, required): The UUID of the completed passenger journey (`trip_passengers.id`).
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Cash collection receipt retrieved successfully",
    "data": {
      "collectionId": "collection-uuid",
      "tripId": "trip-uuid",
      "tripPassengerId": "trip-passenger-uuid",
      "driverId": "driver-profile-uuid",
      "totalCashCollectedPaise": 6800,
      "totalCashCollected": "68.00",
      "rideFarePaise": 3800,
      "rideFare": "38.00",
      "waitingChargePaise": 0,
      "waitingCharge": "0.00",
      "surchargeFeesPaise": 3000,
      "surchargeFees": "30.00",
      "collectedFeeIds": ["fee-uuid"],
      "paymentStatus": "PAID",
      "confirmedAt": "2026-11-22T02:00:00.000Z",
      "paymentAllocations": [
        {
          "id": "alloc-1-uuid",
          "obligationType": "RIDE_FARE",
          "obligationEntityId": "trip-passenger-uuid",
          "allocatedAmountPaise": 3800,
          "allocatedAmount": "38.00"
        },
        {
          "id": "alloc-2-uuid",
          "obligationType": "CANCELLATION_FEE_SURCHARGE",
          "obligationEntityId": "fee-uuid",
          "allocatedAmountPaise": 3000,
          "allocatedAmount": "30.00"
        }
      ]
    }
  }
  ```
- **Not-Yet-Collected Response (404 Not Found):**
  Returned when the passenger journey exists and belongs to the authorized driver, but cash collection has not yet been recorded.
  ```json
  {
    "statusCode": 404,
    "errorCode": "CASH_NOT_YET_COLLECTED",
    "message": "Cash collection has not yet been recorded for trip passenger <uuid>."
  }
  ```
- **Error Responses:**
  - `400 Bad Request`: When `tripPassengerId` is not a valid UUID (`Validation failed (uuid is expected)`).
  - `401 Unauthorized`: Missing, expired, or invalid JWT Bearer token.
  - `403 Forbidden`:
    - `DRIVER_PROFILE_NOT_FOUND`: Caller has no driver profile.
    - `DRIVER_NOT_APPROVED`: Driver profile verification status is not `APPROVED`.
    - `DRIVER_NOT_ASSIGNED_TO_TRIP`: Calling driver is neither the currently assigned driver of the trip (`trips.active_driver_id`) nor the historical driver who collected the cash (`cash_collections.driver_id`).
  - `404 Not Found`:
    - `TRIP_PASSENGER_NOT_FOUND`: No passenger journey exists with the given `tripPassengerId`.
- **Behavior & Guarantees:**
  - Strictly read-only: does not create, update, or mutate any payments, allocations, cancellation fees, or outbox events.
  - Dual driver authorization:
    - Receipt retrieval is allowed strictly to:
      1. The currently assigned driver of the trip (`trips.active_driver_id`).
      2. The historical driver recorded as the cash collection's `driver_id` (`cash_collections.driver_id`).
    - When an active driver is replaced or reassigned (e.g. Stage 9 replacement dispatch scenario), the original driver who collected the cash retains access to their receipt, while the replacement driver actively assigned to the trip can also inspect the trip passenger receipt.
    - All other drivers receive `403 DRIVER_NOT_ASSIGNED_TO_TRIP`.
  - Information leakage prevention: Driver authorization checks are enforced before collection existence checks. If an unrelated driver attempts to query a passenger journey where cash has not yet been collected, the endpoint returns `403 DRIVER_NOT_ASSIGNED_TO_TRIP` (never `404 CASH_NOT_YET_COLLECTED`), preventing unauthorized drivers from probing another driver's trip payment progress.
  - Returns the original persisted receipt from PostgreSQL (`cash_collections` and `payment_allocations`), never recalculating or fabricating payment amounts.
  - Repeated retrievals return the identical receipt deterministically.

---

### Area 20: Outstanding Cancellation Fees

#### 20.1 Query Passenger Outstanding Fees
- **Method & Path:** `GET /api/v1/passengers/cancellation-fees/outstanding`
- **Auth:** Bearer Token (`PASSENGER`)

#### 20.2 Admin: Waive Cancellation Fee
- **Method & Path:** `POST /api/v1/admin/cancellation-fees/:id/waive`
- **Auth:** Bearer Token (`ADMIN`)
- **Request Body:**
  ```json
  {
    "waiverReason": "Verified campus medical emergency"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Cancellation fee waived successfully",
    "data": {
      "feeId": "cancellation-fee-uuid",
      "passengerId": "passenger-uuid",
      "originalBookingId": "booking-uuid",
      "amountPaise": 3000,
      "amount": "30.00",
      "status": "WAIVED",
      "waivedByUserId": "admin-uuid",
      "waiverReason": "Verified campus medical emergency",
      "waivedAt": "2026-11-22T02:00:00.000Z"
    }
  }
  ```
- **State Transition:** Atomically sets fee status `'WAIVED'`, records `waived_by_user_id`, `waiver_reason`, and `waived_at` on `cancellation_fees` as authoritative audit record, and emits `CANCELLATION_FEE_WAIVED` outbox event.
- **Constraints & Invariants:**
  - Restricted to authenticated `ADMIN` role.
  - Requires a non-empty `waiverReason` (400 if blank or whitespace-only).
  - Only `OUTSTANDING` cancellation fees can be waived. Attempting to waive an already `COLLECTED` fee is rejected with 400 `FEE_ALREADY_COLLECTED`.
  - Repeated waiver attempts on an already `WAIVED` fee return 200 OK safely without modifying the immutable original waiver audit metadata.

---

### Area 21: Driver Breakdown Reporting

#### 21.1 Report Driver Breakdown
- **Method & Path:** `POST /api/v1/trips/:id/report-breakdown`
- **Auth:** Bearer Token (Assigned Driver or Admin)
- **Request Body:**
  ```json
  {
    "incidentLocation": { "latitude": 23.1650, "longitude": 72.6500 },
    "incidentType": "MECHANICAL_BREAKDOWN",
    "description": "Flat tire; vehicle immobilized"
  }
  ```
- **State Transition:** Sets trip `'INTERRUPTED'`. Captures immutable onboard manifest snapshot in `trip_incidents`. Triggers replacement driver dispatch in BullMQ.

---

### Area 22: Replacement Driver Dispatch

#### 22.1 Replacement Driver Accepts Handover
- **Method & Path:** `POST /api/v1/trips/:id/replacement-offers/:offerId/accept`
- **Auth:** Bearer Token (`DRIVER`)
- **Headers:** `Idempotency-Key: <uuid>`
- **State Transition:** Creates `replacement_driver_assignments`. Updates `active_driver_id`. Applies 10% fare discount to onboard passengers. Trip returns to `'IN_PROGRESS'`. Emits `trip.resumed`.

#### 22.2 Replacement Driver Rejects Handover
- **Method & Path:** `POST /api/v1/trips/:id/replacement-offers/:offerId/reject`
- **Auth:** Bearer Token (`DRIVER`)
- **State Transition:** Cascades offer to next eligible replacement driver.

---

### Area 23: Refunds and Disruptions

#### 23.1 Get Trip Adjustments and Discounts
- **Method & Path:** `GET /api/v1/trips/:id/adjustments`
- **Auth:** Bearer Token (Passenger or Driver on Trip)

#### 23.2 Admin: Issue Emergency Full Refund
- **Method & Path:** `POST /api/v1/admin/refunds`
- **Auth:** Bearer Token (`ADMIN`)

---

### Area 24: Administration and Fleet Operations

#### 24.1 Get Fleet Overview Statistics
- **Method & Path:** `GET /api/v1/admin/stats`
- **Auth:** Bearer Token (`ADMIN`)
- **Response (200 OK):** Active vehicles, online drivers, completed trips, cash collected today.

#### 24.2 List Active Trips
- **Method & Path:** `GET /api/v1/admin/trips/active`
- **Auth:** Bearer Token (`ADMIN`)

#### 24.3 Get Administrative Audit Logs
- **Method & Path:** `GET /api/v1/admin/audit-logs`
- **Auth:** Bearer Token (`ADMIN`)

---

### Area 25: Reconnection and Synchronization

#### 25.1 Reconnection State Synchronization
- **Method & Path:** `POST /api/v1/sync`
- **Auth:** Bearer Token (Any Role)
- **Request Body:**
  ```json
  {
    "lastKnownEntityVersion": 4,
    "activeBookingId": "uuid",
    "activeTripId": "uuid"
  }
  ```
- **Response (200 OK):** Returns authoritative current state of all user entities, reconciling any missed Socket.IO events.

---

*End of REST and Realtime API Specification*
