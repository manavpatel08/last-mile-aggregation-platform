# Mobile — Last-Mile Connectivity Aggregation Platform

Cross-platform Flutter mobile application (**iOS** and **Android**) built with **Flutter**, **Dart**, **Provider**, **go_router**, and **Dio**.

> [!IMPORTANT]
> The authoritative system architecture, API contracts, ADRs, and governance rules are defined in `/docs` and the root `/AGENTS.md`. Do not deviate from approved specifications or duplicate backend business logic in the mobile client.

---

## Architecture Overview

A single Flutter codebase hosts both **Passenger** and **Driver** interfaces (ADR-002):

- **Shared Infrastructure (`lib/core/`, `lib/app/`):**
  - Runtime environment configuration (`AppConfig`) supporting simulator and LAN overrides.
  - Material 3 design tokens and theme (`AppTheme`, `AppColors`).
  - Reusable Dio HTTP client (`ApiClient`) with extensible auth/idempotency interceptors and standardized `ApiException` error envelope mapping.
  - Declarative `go_router` navigation (`AppRouter`, `AppRoutes`) and application-level UI mode state (`AppModeProvider`).
- **Feature-First Modules (`lib/features/`):**
  - `role_selection/`: Entry point for switching between Passenger and Driver UI modes.
  - `passenger/`: Passenger-scoped state and presentation screens.
  - `driver/`: Driver-scoped state and presentation screens.

> [!NOTE]
> Per `AGENTS.md` §1.3, selecting Passenger or Driver mode in the Flutter client is **strictly a UI presentation state**, never a security boundary. Role authorization and driver approval (`verification_status = 'APPROVED'`) are enforced exclusively by the backend.

---

## Directory Structure

```text
apps/mobile/
├── android/                          # Android platform runner (Phase 2 verification target)
├── ios/                              # iOS platform runner (Phase 1 primary target)
├── lib/
│   ├── app/
│   │   ├── app.dart                  # Root LastMileApp (MultiProvider + MaterialApp.router)
│   │   ├── router/
│   │   │   ├── app_router.dart       # go_router route table and fallback error screen
│   │   │   └── app_routes.dart       # Route paths, names, and initial-route resolver
│   │   └── state/
│   │       └── app_mode_provider.dart # UI interface mode ChangeNotifier
│   ├── core/
│   │   ├── config/
│   │   │   └── app_config.dart       # Compile-time env defines and simulator defaults
│   │   ├── network/
│   │   │   ├── api_client.dart       # Reusable Dio HTTP client wrapper
│   │   │   ├── api_exception.dart    # Standardized API error envelope exception
│   │   │   └── dio_interceptors.dart # Auth header, Idempotency-Key, and safe debug logger
│   │   ├── theme/
│   │   │   ├── app_colors.dart       # Color palette tokens
│   │   │   └── app_theme.dart        # Material 3 ThemeData
│   │   └── widgets/
│   │       ├── mode_badge.dart       # Active UI mode indicator pill
│   │       └── placeholder_section_card.dart # Placeholder card for planned modules
│   ├── features/
│   │   ├── role_selection/
│   │   │   └── presentation/screens/role_selection_screen.dart
│   │   ├── passenger/
│   │   │   ├── state/passenger_home_provider.dart
│   │   │   └── presentation/screens/passenger_home_screen.dart
│   │   └── driver/
│   │       ├── state/driver_home_provider.dart
│   │       └── presentation/screens/driver_home_screen.dart
│   └── main.dart                     # Application entrypoint
├── test/                             # Unit and widget tests
├── .env.example                      # Template environment configuration
├── analysis_options.yaml             # Static analysis lint configuration
├── pubspec.yaml                      # Dependencies and project metadata
└── README.md
```

---

## Prerequisites

- **Flutter SDK:** `3.22+` (verified on Flutter `3.50.0` / Dart `3.14.0`)
- **Primary Phase 1 Target (ADR-003):** Apple Silicon Mac with Xcode and iOS Simulator (plus physical iPhone validation)
- **Phase 2 Target:** Android Studio and Android Emulator (plus physical Android validation)

---

## Getting Started

### 1. Install Dependencies

```bash
cd apps/mobile
flutter pub get
```

### 2. Environment Configuration

Copy the example environment file for local overrides:

```bash
cp .env.example .env
```

Never commit `.env` to Git (it is ignored by `apps/mobile/.gitignore`).

| Variable | iOS Simulator Default | Android Emulator Default | Physical Device Example |
|---|---|---|---|
| `API_BASE_URL` | `http://localhost:3000/api/v1` | `http://10.0.2.2:3000/api/v1` | `http://192.168.1.50:3000/api/v1` |
| `SOCKET_BASE_URL` | `ws://localhost:3000/realtime` | `ws://10.0.2.2:3000/realtime` | `ws://192.168.1.50:3000/realtime` |
| `APP_ENV` | `development` | `development` | `development` |
| `APP_MODE` | *(empty — opens Role Selection)* | *(empty)* | `PASSENGER` or `DRIVER` |

### 3. Run the Application

```bash
# Default launch (opens Role Selection screen)
cd apps/mobile
flutter run

# Launch with local .env overrides
flutter run --dart-define-from-file=.env

# Launch directly into Passenger or Driver UI mode
flutter run --dart-define=APP_MODE=PASSENGER
flutter run --dart-define=APP_MODE=DRIVER
```

---

## Verification & Testing

Run static analysis and the test suite before opening a PR:

```bash
cd apps/mobile
flutter pub get
flutter analyze
flutter test
```
