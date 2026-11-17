# Development Workflow

## 1. Purpose

This document defines the Git, collaboration, implementation, testing and pull request workflow for the Lastmile project.

The repository is the single source of truth for project code and approved technical documentation.

## 2. Git Strategy

We use a single permanent branch:

- `main`: stable, reviewed and integrated code.

All development happens on temporary branches created from the latest `main`.

We do not maintain a permanent `develop` branch.

## 3. Branch Naming

| Prefix | Purpose | Example |
|---|---|---|
| feat/ | New functionality | feat/booking-api |
| fix/ | Bug fixes | fix/booking-timeout |
| refactor/ | Internal restructuring | refactor/fare-module |
| docs/ | Documentation changes | docs/team-workflow |
| test/ | Test additions or improvements | test/matching-engine |
| hotfix/ | Urgent production fixes | hotfix/auth-failure |

Each branch should address one focused task or independently reviewable feature.

## 4. Starting a Task

Before starting:

1. Find or create the GitHub Issue.
2. Confirm the task owner.
3. Read the approved feature specification.
4. Identify dependencies and affected modules.
5. Confirm that the task does not conflict with another active task.
6. Pull the latest main branch.

Commands:

```bash
git checkout main
git pull origin main
git checkout -b feat/feature-name
```

## 5. During Development

- Work only on the assigned branch.
- Keep commits focused and descriptive.
- Do not modify unrelated modules.
- Do not commit secrets or local environment files.
- Do not silently change approved requirements.
- Run relevant tests before opening a PR.
- Push changes regularly.

## 6. Commit Convention

Use conventional commit-style messages.

Examples:

```text
feat(booking): implement booking creation
fix(dispatch): handle expired driver offers
refactor(fares): separate fare calculation logic
test(matching): add detour validation tests
docs(api): update booking API documentation
```

## 7. Pull Request Process

Every feature or independently reviewable task must be submitted through a pull request targeting `main`.

The PR author must:

1. Push the feature branch.
2. Open a PR against `main`.
3. Link the relevant GitHub Issue.
4. Explain the changes.
5. Identify affected modules.
6. Mention database or API changes.
7. Include test results.
8. Attach screenshots or logs where relevant.

## 8. Review Process

Every PR follows this sequence:

1. Author performs local verification.
2. Other human developer performs peer review.
3. Claude performs independent code review.
4. Claude findings are evaluated with ChatGPT against approved architecture and specifications.
5. Author fixes valid blocking findings.
6. Tests are rerun.
7. Manav gives final approval and makes the merge decision.

Claude and ChatGPT are review assistants, not authorities that can independently approve architectural changes.

## 9. Human Approval Rules

- Friend's PR: Manav reviews and approves.
- Manav's PR: Friend reviews and approves.
- The PR author cannot approve their own PR.
- Manav makes the final merge decision.
- Required GitHub approval and automated checks must be satisfied.

## 10. Merge Rules

- Merge only after required reviews are complete.
- Resolve all blocking review comments.
- Ensure required checks pass.
- Prefer squash merging for focused feature branches.
- Delete the feature branch after successful merge.
- Do not force-push shared branches without coordination.

## 11. Synchronizing Branches

Before beginning a new task:

```bash
git checkout main
git pull origin main
```

For an existing feature branch, synchronize with main using the agreed repository strategy.

If conflicts occur:

- Understand both changes before resolving.
- Never blindly accept one side.
- Ask the other developer when ownership is unclear.
- Run relevant tests after conflict resolution.

## 12. Shared File Protection

The following files require coordination before concurrent modification:

- prisma/schema.prisma
- Database migrations
- Shared DTOs and API contracts
- Global configuration
- Shared TypeScript types
- Application-level Flutter routing
- AGENTS.md
- Architecture documentation

Database migration history must never be casually rewritten or discarded.

## 13. Parallel Development

Parallel work is encouraged when feature boundaries and API contracts are agreed.

Example:

- Backend developer implements a booking API.
- Frontend developer implements the booking screen against the approved API contract.
- Mock responses may be used temporarily.
- Integration happens after both sides are ready.

Both developers must coordinate breaking changes.

## 14. GitHub Issue Tracking

Every task should have:

- Unique issue.
- Description and expected behaviour.
- Owner.
- Relevant specification.
- Dependencies.
- Acceptance criteria.
- Status.
- Related PR.

Use the GitHub Project board:

Backlog → Ready → In Progress → In Review → Changes Requested → Done.

## 15. Documentation Changes

Approved architecture documentation must be updated when an implementation changes an approved decision.

Documentation changes must be reviewed through pull requests.

## 16. Prohibited Practices

- Direct commits to main.
- Unreviewed merges.
- Committing secrets.
- Unapproved architecture changes.
- Duplicating business logic across modules.
- Direct frontend manipulation of backend business state.
- Modifying unrelated files without justification.
- Merging code with failing required checks.
- Treating AI-generated suggestions as approved decisions.