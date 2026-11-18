# Implementation Record: TASK-002 — Flutter Application Foundation

- **Task ID:** TASK-002
- **GitHub Issue:** #4
- **Branch:** `feat/flutter-foundation`
- **Owner:** Aditya
- **Reviewer:** Manav (Technical Lead)
- **Status:** Implemented (Pending Review, Uncommitted)

---

## 1. Files Created and Modified

### Flutter Application Scaffold & Configuration (`apps/mobile/`)
- `apps/mobile/` — Created via `flutter create --org com.lastmile --project-name lastmile_mobile --platforms=ios,android` (includes iOS and Android platform runners, `pubspec.yaml`, `pubspec.lock`, `analysis_options.yaml`, `.metadata`).
- `apps/mobile/.gitignore` — Updated to ignore local `.env`, `.env.local`, and `.env.*.local` files while preserving `.env.example`.
- `apps/mobile/.env.example` — Created mobile environment variable template (`API_BASE_URL`, `SOCKET_BASE_URL`, `APP_ENV`, `APP_MODE`).
- `apps/mobile/README.md` — Created mobile architecture overview, folder structure, environment contract, run commands, and test commands.

### Shared Application & Core Infrastructure (`apps/mobile/lib/`)
- `apps/mobile/lib/main.dart` — Minimal entrypoint initializing `AppConfig.fromEnvironment()` and booting `LastMileApp`.
- `apps/mobile/lib/app/app.dart` — Root `LastMileApp` widget wiring `MultiProvider`, `AppTheme.lightTheme`, `ApiClient`, `AppModeProvider`, feature providers, and `MaterialApp.router`.
- `apps/mobile/lib/app/router/app_routes.dart` — Centralized route paths (`/` , `/passenger`, `/driver`), route names, and `initialLocationForMode`.
- `apps/mobile/lib/app/router/app_router.dart` — Declarative `go_router` configuration and fallback unknown-route screen.
- `apps/mobile/lib/app/state/app_mode_provider.dart` — Application-level `ChangeNotifier` tracking UI mode selection (`unselected`, `passenger`, `driver`).
- `apps/mobile/lib/core/config/app_config.dart` — Compile-time environment configuration (`--dart-define` / `--dart-define-from-file=.env`) with platform-aware simulator defaults (`localhost` for iOS, `10.0.2.2` for Android).
- `apps/mobile/lib/core/network/api_client.dart` — Reusable Dio HTTP client configured with base URL, JSON headers, timeouts, `Idempotency-Key` support, and `ApiException` error mapping.
- `apps/mobile/lib/core/network/api_exception.dart` — Normalized exception parsing the standard backend error envelope documented in `docs/API_SPECIFICATION.md` §1.3.
- `apps/mobile/lib/core/network/dio_interceptors.dart` — `ApiHeadersInterceptor` (extensible `Authorization: Bearer` hook + `Idempotency-Key` header injection) and `SafeNetworkLogInterceptor` (debug-only method/path/status logging without secrets).
- `apps/mobile/lib/core/theme/app_colors.dart` — Shared Material 3 design color tokens.
- `apps/mobile/lib/core/theme/app_theme.dart` — Shared Material 3 `ThemeData`.
- `apps/mobile/lib/core/widgets/mode_badge.dart` — Reusable UI pill indicating active Passenger or Driver presentation mode.
- `apps/mobile/lib/core/widgets/placeholder_section_card.dart` — Reusable card widget for planned module placeholders.

### Feature Modules (`apps/mobile/lib/features/`)
- `apps/mobile/lib/features/role_selection/presentation/screens/role_selection_screen.dart` — Entry screen with Passenger and Driver mode cards, explicit UI-only authorization notice (`AGENTS.md` §1.3), and environment label.
- `apps/mobile/lib/features/passenger/state/passenger_home_provider.dart` — Feature-scoped Provider foundation for Passenger Home placeholder metadata.
- `apps/mobile/lib/features/passenger/presentation/screens/passenger_home_screen.dart` — Passenger Home placeholder screen with mode badge, switch-mode navigation, and planned module placeholders.
- `apps/mobile/lib/features/driver/state/driver_home_provider.dart` — Feature-scoped Provider foundation for Driver Home placeholder metadata.
- `apps/mobile/lib/features/driver/presentation/screens/driver_home_screen.dart` — Driver Home placeholder screen with mode badge, backend verification notice, switch-mode navigation, and planned module placeholders.

### Tests (`apps/mobile/test/`)
- `apps/mobile/test/core/config/app_config_test.dart` — Unit tests for `AppMode.fromString` and iOS/Android default URL resolution.
- `apps/mobile/test/core/network/api_client_test.dart` — Unit tests verifying `ApiClient` base URL, JSON headers, Bearer token hook, `Idempotency-Key` header, and standard error envelope mapping using a fake `HttpClientAdapter`.
- `apps/mobile/test/app/state/app_mode_provider_test.dart` — Unit tests for `AppModeProvider` transitions and listener notification behavior.
- `apps/mobile/test/widget_test.dart` — Widget tests verifying Role Selection $\leftrightarrow$ Passenger Home and Role Selection $\leftrightarrow$ Driver Home navigation flows plus `initialMode` overrides.

### Documentation & Tracking
- `docs/tasks/TASK-002-flutter-foundation.md` — This implementation record.
- No existing architecture documents, ADRs, `AGENTS.md`, or `apps/backend/` files were modified.

---

## 2. Purpose of Significant Changes

1. **Modular Foundation Architecture:** Separated `app/` (root wiring, router, UI mode state), `core/` (config, Dio networking, theme, shared widgets), and `features/` (`role_selection`, `passenger`, `driver`) so future vertical features can evolve independently without inflating `main.dart` or mixing Passenger and Driver code.
2. **Environment-Driven Configuration:** Implemented `AppConfig.fromEnvironment` supporting `--dart-define` and `--dart-define-from-file=.env`, avoiding hardcoded localhost/LAN URLs and honoring iOS Simulator (`localhost`) and Android Emulator (`10.0.2.2`) defaults.
3. **Reusable HTTP Networking Layer:** Established `ApiClient` over `Dio` with standard JSON headers, extensible auth token provider and `Idempotency-Key` hooks, and standardized error mapping without executing live backend calls or inventing undocumented endpoints.
4. **Role Selection & Placeholder Navigation:** Built `go_router` navigation and `Provider` state foundations connecting Role Selection, Passenger Home, and Driver Home, while clearly documenting that client UI mode is not a security boundary.

---

## 3. Dependencies Added and Rationale

| Package | Version | Rationale |
|---|---|---|
| `provider` | `^6.1.5+1` | Approved state management library (`docs/CONTRIBUTING.md` §2) powering `AppModeProvider`, `PassengerHomeProvider`, and `DriverHomeProvider`. |
| `go_router` | `^18.1.4` | Approved declarative navigation library (`docs/CONTRIBUTING.md` §2) routing between Role Selection, Passenger Home, and Driver Home. |
| `dio` | `^5.11.1` | Approved HTTP networking library (`docs/CONTRIBUTING.md` §2) backing `ApiClient`, interceptors, and error normalization. |
| `material_ui` | `^1.1.0` | Generated by Flutter 3.50.0 `flutter create` template; required because `package:flutter/material.dart` is deprecated in Flutter 3.47+. |
| `cupertino_icons` | `^1.0.8` | Default iOS iconography package generated by `flutter create`. |
| `flutter_lints` (dev) | `^6.0.0` | Default recommended Flutter lint ruleset generated by `flutter create`. |

No packages for deferred features (`flutter_map`, `geolocator`, `socket_io_client`, `flutter_secure_storage`, OAuth SDKs) were installed.

---

## 4. Architectural Decisions Followed

- **ADR-002 (Single Flutter Codebase for Android and iOS):** Single project at `apps/mobile` configured with both `ios` and `android` runners hosting Passenger and Driver interfaces.
- **ADR-003 (iOS Simulator as Primary Initial Development Environment):** Verified build and UI rendering on the iPhone 18 Pro iOS Simulator (`iOS 27.2`).
- **ADR-021 (REST for Authoritative Mutations):** Configured reusable Dio REST client foundation with JSON content headers and `Idempotency-Key` header support (`AGENTS.md` §1.5).
- **`AGENTS.md` §1.3 (Zero Frontend Trust):** Explicitly documented in code and UI that Passenger/Driver mode selection is strictly presentation state and never an authorization boundary.
- **`AGENTS.md` §4.1–4.2 (₹0 Budget & Mac Host Safety):** Zero paid SDKs; no system configuration changes; local `.env` ignored via `.gitignore` with `.env.example` template provided.
- **`docs/DEPLOYMENT_AND_ENVIRONMENT.md` §3–5:** Platform-aware simulator defaults (`localhost` / `10.0.2.2`) and `--dart-define=APP_MODE=PASSENGER|DRIVER` support.

---

## 5. Verification & Tests Executed

All checks were executed after the final code edit on Flutter `3.50.0` / Dart `3.14.0`:

| Command | Result |
|---|---|
| `flutter pub get --directory apps/mobile` | Passed (exit code 0) |
| `flutter analyze apps/mobile` | Passed — `No issues found!` (exit code 0) |
| `cd apps/mobile && flutter test` | Passed — `11/11` tests passed (exit code 0) |
| `cd apps/mobile && flutter build ios --simulator --debug` | Passed — `Built build/ios/iphonesimulator/Runner.app` (exit code 0) |
| `xcrun simctl install` & `launch` on booted `iPhone 18 Pro` Simulator | Passed — Verified Role Selection, Passenger Home (`APP_MODE=PASSENGER`), and Driver Home (`APP_MODE=DRIVER`) visually via screenshots; caught and fixed AppBar title truncation (`Passenger H...`) by placing `ModeBadge` inside the workspace hero card. |

---

## 6. Known Limitations and Pending Work

- **No Backend Integration Yet:** Authentication (Google OAuth + JWT refresh), socket tickets, geofencing, quotes, bookings, matching, dispatch, trips, OTP verification, cash confirmation, and breakdown reporting are intentionally excluded from TASK-002 and deferred to subsequent tasks.
- **Deferred Mobile Dependencies:** `flutter_secure_storage`, `socket_io_client`, `flutter_map`, `latlong2`, and `geolocator` will be added only in the specific tasks that require them.
- **Android Emulator Verification:** Deferred to Phase 2 verification per ADR-003 (Android platform runner files and `10.0.2.2` default config are already in place and unit-tested).
- **Git State:** All changes remain uncommitted on branch `feat/flutter-foundation` awaiting human review.
