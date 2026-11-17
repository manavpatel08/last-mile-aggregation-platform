# Team Responsibilities

## 1. Team Structure

Lastmile is developed by two human developers supported by AI development and review tools.

| Participant | Role |
|---|---|
| Manav | Project Owner and Technical Lead |
| Co-developer | Full-stack Developer |
| ChatGPT | Architecture, technical specifications and review evaluation |
| Antigravity | Implementation and testing assistant |
| Claude | Independent code and architecture reviewer |

Human developers remain responsible for all technical decisions, implementation quality and approvals.

## 2. Project Owner — Manav

Manav is responsible for:

- Overall system architecture and technical direction.
- Approval of architecture changes and Architecture Decision Records.
- Backend architecture and module boundaries.
- Database architecture, Prisma and PostGIS.
- Authentication and authorization foundations.
- Booking, matching, routing and fare domain logic.
- Dispatch and trip lifecycle architecture.
- API contracts and cross-module integration.
- Reviewing the co-developer's pull requests.
- Final approval and merge decisions.
- Ensuring implementation follows approved specifications.

## 3. Co-developer — Full-stack Developer

The co-developer is responsible for:

- Flutter application architecture and implementation.
- Passenger application experience.
- Driver application experience.
- Next.js administration dashboard.
- Frontend API integration.
- UI state management and navigation.
- Driver onboarding and profile workflows.
- Assigned backend modules and APIs.
- Notifications and admin-facing functionality.
- Frontend, integration and assigned backend tests.
- Reviewing Manav's pull requests.
- Keeping assigned documentation updated.

The co-developer may implement backend features. Backend ownership is not restricted exclusively to Manav.

## 4. Initial Module Ownership

| Area | Primary Owner | Reviewer |
|---|---|---|
| System architecture | Manav | Co-developer |
| Architecture decisions | Manav | Co-developer |
| Database architecture | Manav | Co-developer |
| Authentication foundations | Manav | Co-developer |
| Booking | Manav | Co-developer |
| Matching | Manav | Co-developer |
| Routing and OSRM integration | Manav | Co-developer |
| Fare calculation | Manav | Co-developer |
| Dispatch | Manav | Co-developer |
| Trip lifecycle | Manav | Co-developer |
| Flutter passenger experience | Co-developer | Manav |
| Flutter driver experience | Co-developer | Manav |
| Admin dashboard | Co-developer | Manav |
| Driver onboarding | Co-developer | Manav |
| Notifications | Co-developer | Manav |
| Admin backend APIs | Co-developer | Manav |
| Demo simulation | Shared | Each other |
| Integration testing | Shared | Each other |

Ownership may be adjusted through explicit agreement and task reassignment.

## 5. Shared Responsibilities

Both developers are responsible for:

- Understanding the complete system architecture.
- Following API contracts.
- Writing tests for assigned work.
- Reviewing each other's pull requests.
- Communicating breaking changes before implementation.
- Keeping Git branches synchronized.
- Reporting blockers.
- Maintaining relevant documentation.
- Participating in integration testing.

## 6. Decisions Requiring Technical Lead Approval

The following changes require Manav's explicit approval before implementation:

- Changes to approved system architecture.
- Changes to database architecture or important schema relationships.
- Changes to API contracts.
- Changes to fare calculation and financial rules.
- Changes to matching and routing algorithms.
- Changes to booking, dispatch or trip state machines.
- Changes to authentication and authorization architecture.
- Changes to module responsibilities or dependency boundaries.
- Addition of major infrastructure or dependencies.

Any approved change must be documented where appropriate, especially in ARCHITECTURE_DECISION_RECORDS.md.

## 7. Ownership Rules

- Every GitHub Issue must have one accountable owner.
- A task may involve both developers, but one person remains responsible for its completion.
- Shared files must not be modified simultaneously without coordination.
- A developer must communicate changes that affect another developer's module.
- Ownership does not authorize changes to approved architecture without approval.

## 8. Final Authority

Manav is the project owner and has final responsibility for architectural decisions and merge approval.

Both developers must review each other's work. No developer should merge their own pull request without the required independent approval.