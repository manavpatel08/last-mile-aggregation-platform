# Backend AI Agent Guidelines

> [!IMPORTANT]
> **MANDATORY READING:**
> The authoritative architecture, database schema, and operational policies for this repository are defined in:
> - Root [`AGENTS.md`](../../AGENTS.md)
> - [`docs/SYSTEM_ARCHITECTURE.md`](../../docs/SYSTEM_ARCHITECTURE.md)
> - [`docs/DATABASE_DESIGN.md`](../../docs/DATABASE_DESIGN.md)
> - [`docs/API_SPECIFICATION.md`](../../docs/API_SPECIFICATION.md)
> - [`docs/IMPLEMENTATION_ROADMAP.md`](../../docs/IMPLEMENTATION_ROADMAP.md)
> - [`docs/ARCHITECTURE_DECISION_RECORDS.md`](../../docs/ARCHITECTURE_DECISION_RECORDS.md)
>
> All backend implementation work in `apps/backend` must strictly adhere to these authoritative documents.

---

## Backend Framework & Runtime Facts

1. **NestJS 12 in ESM Mode:**
   - This project is configured as pure ECMAScript Modules (`"type": "module"` in `package.json`, `"moduleResolution": "NodeNext"` in `tsconfig.json`).
   - Relative TypeScript file imports require `.js` extensions (e.g., `import { Config } from './config.js'`).
   - `__dirname` does not exist in ESM scope; use `import.meta.dirname` when path resolution is required.

2. **Test Runner is Vitest:**
   - Tests run via Vitest (`npm test` and `npm run test:e2e`).
   - Use `vi.fn()` instead of `jest.fn()`.
   - Ensure `reflect-metadata` is imported when testing decorated classes.

3. **Dual Runtime Entry Points:**
   - `src/main.ts`: HTTP / WebSocket API server.
   - `src/worker.main.ts`: BullMQ background job consumers.

4. **Modular Monolith Invariant:**
   - Keep domain modules self-contained in `src/modules/`.
   - All modules communicate via in-process synchronous services or BullMQ / PostgreSQL Transactional Outbox.
   - No microservices or external message brokers (Kafka/RabbitMQ).
