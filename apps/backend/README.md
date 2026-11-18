# Backend — Last-Mile Connectivity Aggregation Platform

Modular monolith backend built with **NestJS 12**, **TypeScript (ESM)**, **PostgreSQL 18 + PostGIS 3.7**, **Prisma ORM (v6.19)**, and **Redis 8 / BullMQ**.

---

## Architecture Overview

The backend is structured as a **single modular monolith** executing as two operational runtime profiles sharing the same codebase:

1. **API Server (`src/main.ts`)**:
   - Handles HTTP REST requests and WebSocket/Socket.IO connections.
   - Global prefix: `/api/v1` (with `/health` exempted at root).
   - Enforces Role-Based Access Control (RBAC), idempotency headers, and input validation.

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
│   ├── common/                # Shared utilities, filters, decorators, constants
│   │   ├── constants/         # App constants, queue names, API prefixes
│   │   └── filters/           # Global exception filter (standard error envelope)
│   ├── config/                # Environment configuration and class-validator schema
│   │   ├── configuration.ts   # Configuration factory
│   │   └── env.validation.ts  # Environment schema validation
│   ├── infrastructure/        # Core database, cache and queue modules
│   │   ├── prisma/            # PrismaService lifecycle and PostGIS verification
│   │   ├── redis/             # RedisService (ephemeral GPS fix caching & TTL)
│   │   └── queues/            # BullMQ QueueModule, QueueService & TestProcessor
│   ├── modules/               # Domain modules
│   │   └── health/            # Health checks (/health, /health/ready, /health/live)
│   ├── app.module.ts          # Root NestJS application module
│   ├── main.ts                # API server entry point
│   └── worker.main.ts         # Background worker entry point
├── test/                      # End-to-end (e2e) tests (Vitest)
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
DEMO_MODE=true
```

> [!WARNING]
> Never commit `.env` containing sensitive credentials to Git. Commit only `.env.example`.

---

## Database Setup & Migrations

The database foundation includes 39 tables, 11 engine-level database invariants (partial unique indexes, PostGIS GiST spatial indexes, outbox indexing), and 11 check constraints.

### 1. Generate Prisma Client

```bash
npx prisma generate
```

### 2. Apply Database Migrations

Apply pending migrations to PostgreSQL without altering the shadow database:

```bash
npx prisma migrate deploy
```

### 3. Inspect Schema or Database

```bash
npx prisma validate
```

---

## Redis & BullMQ Architecture

- **PostgreSQL is the Sole Authoritative Truth**: All bookings, groups, ledgers, and transactions persist durability in PostgreSQL.
- **Redis Ephemeral GPS**: Driver GPS fixes are cached with a 30-second TTL (`driver:gps:<driverId>`). If Redis restarts or is flushed, zero business data is lost.
- **BullMQ Broker**: Manages background task queues (`test-queue`, `matching-batches`, `driver-dispatch`, `outbox-publisher`).
- **Worker Host & Idempotency**: All job processors verify job identity and authoritative PostgreSQL entity state to ensure idempotent execution.

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
# Run all unit and integration tests (Prisma, PostGIS, Redis, BullMQ, Health)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with code coverage
npm run test:cov

# Run end-to-end (e2e) tests against running services
npm run test:e2e
```

---

## Health Check Endpoints

| Endpoint | Method | Success | Error | Description |
|---|---|---|---|---|
| `/health` | `GET` | `200 OK` | `503 Unavailable` | Full system health summary (API, Database, Redis, PostGIS version). |
| `/health/ready` | `GET` | `200 OK` | `503 Unavailable` | Readiness probe verifying PostgreSQL and Redis connections. |
| `/health/live` | `GET` | `200 OK` | — | Liveness probe indicating server process responsiveness. |

Example response from `/health`:
```json
{
  "status": "ok",
  "timestamp": "2026-11-18T14:20:35.612Z",
  "uptime": 2.08,
  "environment": "development",
  "version": "0.0.1",
  "services": {
    "api": "healthy",
    "database": "healthy",
    "redis": "healthy",
    "postgis": "3.7 USE_GEOS=1 USE_PROJ=1 USE_STATS=1"
  }
}
```

Example response from `/health/ready`:
```json
{
  "status": "ready",
  "database": "connected",
  "redis": "connected",
  "timestamp": "2026-11-18T14:20:35.631Z"
}
```

---

## Code Quality & Standards

- **Linter**: Oxlint (`npm run lint`)
- **Code Formatter**: Prettier (`npm run format`)
- **Module Format**: Pure ECMAScript Modules (ESM) with NodeNext resolution.
