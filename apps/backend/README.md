# Backend — Last-Mile Connectivity Aggregation Platform

Modular monolith backend built with **NestJS 12**, **TypeScript (ESM)**, **PostgreSQL 18 + PostGIS 3.7**, **Prisma ORM (v6.19)**, and **Redis 8 / BullMQ**.

---

## Architecture Overview

The backend is structured as a **single modular monolith** executing as two operational runtime profiles sharing the same codebase:

1. **API Server (`src/main.ts`)**:
   - Handles HTTP REST requests and WebSocket/Socket.IO connections.
   - Global prefix: `/api/v1` (with `/health` exempted at root).
   - Enforces Role-Based Access Control (RBAC), driver approval verification, idempotency headers, rate limiting, and input validation.

2. **Background Worker (`src/worker.main.ts`)**:
   - Executes asynchronous BullMQ queue consumers and scheduled cron workflows.
   - Offloads compute-heavy matching calculations, driver dispatch timeouts (20s), and transactional outbox event publishing.

> [!IMPORTANT]
> The authoritative architecture, database models, and governance rules are defined in `/docs` and the root `/AGENTS.md`. Always consult these documents before modifying business logic or database structures.

---

## Directory Structure

```
apps/backend/
├── prisma/
│   ├── schema.prisma          # Authoritative Prisma schema with PostGIS geometry
│   └── migrations/            # Version-controlled SQL migrations
├── src/
│   ├── common/                # Shared utilities, filters, decorators, guards, constants
│   │   ├── constants/         # App constants, queue names, API prefixes
│   │   ├── decorators/        # @Public(), @Roles(), @RequireDriverApproval(), @CurrentUser()
│   │   ├── filters/           # Global exception filter (standard error envelope)
│   │   └── guards/            # JwtAuthGuard, RolesGuard, DriverApprovalGuard
│   ├── config/                # Environment configuration and class-validator schema
│   │   ├── configuration.ts   # Configuration factory
│   │   └── env.validation.ts  # Environment schema validation
│   ├── infrastructure/        # Core database, cache and queue modules
│   │   ├── prisma/            # PrismaService lifecycle and PostGIS verification
│   │   ├── redis/             # RedisService (ephemeral GPS fix caching & TTL)
│   │   └── queues/            # BullMQ QueueModule, QueueService & TestProcessor
│   ├── modules/               # Domain modules
│   │   ├── auth/              # Google OAuth, JWT tokens, rotating sessions, socket tickets
│   │   ├── users/             # User and passenger profiles (/users/me)
│   │   ├── drivers/           # Driver onboarding, documents, vehicles, admin approvals
│   │   └── health/            # Health checks (/health, /health/ready, /health/live)
│   ├── app.module.ts          # Root NestJS application module
│   ├── main.ts                # API server entry point
│   └── worker.main.ts         # Background worker entry point
├── test/                      # End-to-end (e2e) tests (Vitest)
│   ├── app.e2e-spec.ts        # Health and basic routing e2e tests
│   └── auth-rbac.e2e-spec.ts  # Authentication, session rotation, and RBAC e2e tests
├── .env.example               # Template environment configuration
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

- **Node.js**: `v20.x` or `v24.x`
- **npm**: `v10.x` or higher
- **PostgreSQL**: `18.x` with `PostGIS 3.7` extension enabled
  - Database: `lastmile_db`
  - Application Role: `lastmile_app`
- **Redis**: `8.x` running on localhost (`127.0.0.1:6379`)

---

## Getting Started

### 1. Install Dependencies

```bash
cd apps/backend
npm install
```

### 2. Environment Configuration

Copy the example environment file and configure local credentials:

```bash
cp .env.example .env
```

Ensure the following variables are configured in `.env`:

```env
PORT=3000
NODE_ENV=development
API_PREFIX=api/v1
DATABASE_URL="postgresql://lastmile_app@127.0.0.1:5432/lastmile_db?schema=public"
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
JWT_ACCESS_SECRET="dev-access-secret-minimum-32-chars-long-placeholder!"
JWT_ACCESS_EXPIRY=900
REFRESH_TOKEN_MAX_DAYS=30
GOOGLE_CLIENT_ID_IOS=
GOOGLE_CLIENT_ID_ANDROID=
GOOGLE_CLIENT_ID_WEB=
DEMO_MODE=true
```

> [!WARNING]
> Never commit `.env` containing sensitive credentials to Git. Commit only `.env.example`.

---

## Authentication & Security Architecture

### 1. Google OAuth 2.0 Identity Verification
- Sole external identity provider (eliminates password storage and SMS gateway costs).
- Validates signature against Google's public JWKS, verifying `aud`, `iss`, `exp`, and `sub`.
- Stable Google `sub` claim is mapped to internal users via `auth_identities`.
- Never trusts client-supplied user IDs or roles.

### 2. Token Lifecycle & Rotation
- **Access Token**: Short-lived (15 minutes / 900s) JSON Web Token (JWT) signed with `JWT_ACCESS_SECRET`. Contains `sub`, `email`, `role`, `roles`, `driverVerificationStatus`, and `sessionId`.
- **Refresh Token**: High-entropy 256-bit cryptographically secure opaque token (`crypto.randomBytes(32)`).
- **Zero Plain-Text Token Storage**: The database stores **only the SHA-256 hash** in `user_sessions`.
- **Token Family Rotation**: Each session maintains a `token_family_id`. On each rotation, the current token is burned and a replacement is created in the same family.
- **Automatic Reuse Detection**: If a previously burned refresh token is presented again (replay attack), the backend immediately revokes the **entire token family**, terminating all sessions for that account.

### 3. Role-Based Access Control (RBAC) & Zero Frontend Trust
- System Roles: `PASSENGER` (default), `DRIVER`, `ADMIN`.
- In the mobile app, toggling between Passenger and Driver modes is strictly a UI layout state. The backend enforces RBAC on every endpoint via `RolesGuard`.
- Driver endpoints require both the `DRIVER` role and PostgreSQL verification (`driver_profiles.verification_status = 'APPROVED'`). Unapproved or suspended drivers are strictly blocked by `DriverApprovalGuard`.

### 4. Single-Use Realtime Socket Tickets
- WebSockets cannot securely pass `Authorization: Bearer` headers during handshake upgrades without leaking tokens in logs.
- Clients call `GET /api/v1/auth/socket-ticket` with their JWT access token.
- Returns a single-use UUID ticket cached in Redis with a 60-second TTL (`socket_ticket:<uuid>`).
- Burned immediately upon Socket.IO handshake verification.

---

## API Endpoints Reference

### Authentication Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/v1/auth/google` | `POST` | Public | Exchanges Google ID token for access token and rotating refresh token. |
| `/api/v1/auth/refresh` | `POST` | Public | Rotates refresh token; detects reuse and revokes token family on replay. |
| `/api/v1/auth/logout` | `POST` | Bearer | Revokes current session. |
| `/api/v1/auth/logout-all` | `POST` | Bearer | Revokes all active sessions for current user. |
| `/api/v1/auth/socket-ticket` | `GET` | Bearer | Generates a 60-second single-use ticket for Socket.IO connection. |

### User Profile Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/v1/users/me` | `GET` | Bearer | Returns current user profile, roles, passenger profile, and outstanding fees. |
| `/api/v1/users/me` | `PATCH` | Bearer | Updates passenger profile preferences (`defaultMinGroupPreference`). |

### Driver & Admin Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/v1/drivers/onboard` | `POST` | Bearer | Submits driver onboarding application (license number, vehicle details). |
| `/api/v1/drivers/documents` | `POST` | `DRIVER` | Uploads driving license or vehicle documents. |
| `/api/v1/drivers/vehicles` | `POST` | `DRIVER` | Registers additional vehicle. |
| `/api/v1/drivers/vehicles` | `GET` | `DRIVER` | Lists vehicles belonging to the driver. |
| `/api/v1/drivers/status` | `GET` | `DRIVER` + Approved | Operational status check (guarded by `DriverApprovalGuard`). |
| `/api/v1/admin/drivers/pending` | `GET` | `ADMIN` | Lists driver applications awaiting admin verification. |
| `/api/v1/admin/drivers/:id/approve` | `POST` | `ADMIN` | Approves driver application (`verification_status = 'APPROVED'`). |
| `/api/v1/admin/drivers/:id/reject` | `POST` | `ADMIN` | Rejects driver application with reason. |

### Health Check Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | `GET` | Overall health summary (API, PostgreSQL, Redis, PostGIS version). |
| `/health/ready` | `GET` | Readiness probe (returns 200 if DB and Redis are connected, 503 otherwise). |
| `/health/live` | `GET` | Process liveness probe. |

---

## Running the Application

### Development Mode

Run the API server with auto-reload:
```bash
npm run start:api:dev
```

Run the Background Worker process with auto-reload:
```bash
npm run start:worker:dev
```

### Production Build & Execution

Build the TypeScript project to `dist/`:
```bash
npm run build
```

Start the compiled API server:
```bash
npm run start:prod
```

Start the compiled Background Worker:
```bash
npm run start:worker:prod
```

---

## Running Tests

Unit, integration, and end-to-end tests are executed via **Vitest**:

```bash
# Run all unit and integration tests (39 tests across 8 suites)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with code coverage
npm run test:cov

# Run all end-to-end (e2e) tests (22 tests across 2 suites)
npm run test:e2e
```
