# Contributing to Lastmile

## 1. Introduction

Lastmile is an on-demand aggregation platform for last-mile connectivity using shared micro-mobility.

The project uses a modular monolith backend, Flutter mobile application and Next.js administration dashboard.

All contributors must follow AGENTS.md and the approved architecture documents in docs/.

## 2. Technology Stack

### Mobile
- Flutter
- Dart
- iOS and Android
- Provider for state management
- go_router for navigation
- Dio for HTTP networking
- socket_io_client for realtime communication
- flutter_map for maps
- flutter_secure_storage for secure local storage
- geolocator for location functionality

### Backend
- NestJS
- TypeScript
- PostgreSQL
- PostGIS
- Prisma ORM
- Redis
- BullMQ
- Socket.IO
- OSRM
- OpenStreetMap

### Administration
- Next.js
- TypeScript
- Tailwind CSS

Refer to DEPLOYMENT_AND_ENVIRONMENT.md for approved environment configuration.

## 3. Repository Structure

The target repository structure is:

```text
lastmile/
├── apps/
│   ├── mobile/
│   ├── backend/
│   └── admin/
├── infrastructure/
├── docs/
├── .github/
├── AGENTS.md
└── README.md
```

Applications are initialized progressively according to the implementation roadmap.

## 4. Architecture Principles

- Preserve the approved modular monolith architecture.
- Do not introduce microservices.
- Keep business responsibilities separated into NestJS modules.
- API and worker are separate runnable processes from the same backend codebase.
- PostgreSQL is the authoritative persistent data store.
- Redis is used for queues, caching and temporary coordination.
- Backend owns business logic and financial calculations.
- Flutter and Next.js consume backend contracts.
- No duplicated fare, matching or dispatch business logic in clients.

## 5. Backend Guidelines

- Controllers handle HTTP transport and validation integration.
- Services contain their module's application and business logic.
- Modules own their domain responsibilities.
- Cross-module communication must use explicit interfaces or approved application contracts.
- Avoid circular dependencies.
- Do not access another module's internal implementation directly.
- Keep database operations and transaction boundaries explicit.
- Use DTOs and validation for incoming data.
- Follow approved error response conventions.
- Make retryable mutations idempotent where specified.
- Use database transactions for concurrency-sensitive operations.

## 6. Database Guidelines

- Use Prisma for standard ORM operations.
- Use SQL migrations for PostGIS, partial indexes and specialized PostgreSQL features where required.
- Never edit an already-applied migration casually.
- Keep money in integer paise.
- Keep distances in metres.
- Use UTC timestamps.
- Preserve immutable financial and audit history.
- Do not make Redis the source of truth for business records.
- Follow DATABASE_DESIGN.md.

## 7. Flutter Guidelines

- Maintain one Flutter application for passenger and driver experiences.
- Keep features organized by responsibility.
- Separate presentation, state management and data access.
- Use the approved API client.
- Do not put business calculations inside widgets.
- Do not hardcode API endpoints or secrets.
- Handle loading, error, empty and success states.
- Follow the approved navigation and authentication architecture.
- Keep platform-specific functionality isolated where appropriate.

## 8. Next.js Guidelines

- Keep admin UI separate from backend business logic.
- Consume documented APIs.
- Enforce authorization through backend permissions.
- Use reusable components.
- Handle API errors and loading states consistently.
- Do not bypass backend validation.

## 9. API Guidelines

- Use the approved REST API versioning and response conventions.
- Validate incoming requests.
- Follow API_SPECIFICATION.md.
- Preserve existing response contracts unless changes are approved.
- Use appropriate HTTP status codes.
- Enforce resource ownership and authorization.
- Document breaking changes before implementation.

## 10. Testing

Every feature must include relevant tests.

Depending on the feature, tests may include:

- Unit tests.
- Integration tests.
- API tests.
- Database transaction tests.
- Flutter widget tests.
- End-to-end tests.
- Failure and concurrency tests.

Do not claim tests passed unless they were actually executed.

## 11. Environment Variables and Secrets

- Keep local secrets in ignored .env files.
- Commit .env.example with placeholder values only.
- Never commit API keys, tokens, passwords or private keys.
- Document newly introduced environment variables.
- Each developer maintains their own local secrets.

## 12. AI-Assisted Development

Antigravity is an implementation assistant.

Before modifying code, it must:

1. Read AGENTS.md.
2. Read relevant architecture documentation.
3. Inspect the existing implementation.
4. Follow the approved feature specification.
5. Respect file and module ownership.
6. Avoid unrelated modifications.
7. Implement tests.
8. Run required checks.
9. Report changed files and test results.

Claude is used for independent review.

ChatGPT assists with architecture, specifications, debugging and evaluation of review findings.

AI tools must not independently change approved architectural decisions.

## 13. Dependency Management

- Avoid unnecessary dependencies.
- Explain why new dependencies are needed.
- Check compatibility with the existing stack.
- Keep dependency versions and lockfiles consistent.
- Do not introduce major infrastructure without approval.

## 14. Completion Criteria

A feature is ready for review when:

- Implementation follows the approved specification.
- Relevant tests are added and executed.
- Static analysis and formatting checks pass.
- No unrelated files are modified.
- Documentation is updated where necessary.
- The PR description is complete.
- Known limitations are disclosed.

## 15. Source of Truth

In case of uncertainty, consult:

1. AGENTS.md
2. Relevant approved architecture documents.
3. Approved Architecture Decision Records.
4. Approved feature specification.
5. Existing implementation and tests.

Unresolved conflicts must be discussed with the technical lead rather than resolved through assumptions.