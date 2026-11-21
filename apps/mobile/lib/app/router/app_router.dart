import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/screens/admin_info_screen.dart';
import '../../features/auth/presentation/screens/login_screen.dart';
import '../../features/auth/presentation/screens/splash_screen.dart';
import '../../features/auth/state/auth_provider.dart';
import '../../features/booking/presentation/screens/booking_details_screen.dart';
import '../../features/booking/presentation/screens/booking_flow_screen.dart';
import '../../features/driver/presentation/screens/driver_home_screen.dart';
import '../../features/driver/presentation/screens/driver_onboarding_screen.dart';
import '../../features/passenger/presentation/screens/passenger_home_screen.dart';
import '../../features/role_selection/presentation/screens/role_selection_screen.dart';
import '../state/app_mode_provider.dart';
import '../../core/config/app_config.dart';
import 'app_routes.dart';

/// Application-level `go_router` navigation with authentication and RBAC route guards.
abstract final class AppRouter {
  static GoRouter createRouter({
    required AppModeProvider appModeProvider,
    required AuthProvider authProvider,
    String? initialLocation,
  }) {
    return GoRouter(
      initialLocation: initialLocation ?? AppRoutes.splash,
      refreshListenable: Listenable.merge([appModeProvider, authProvider]),
      redirect: (context, state) {
        final matchedPath = state.matchedLocation;

        // 1. Initial startup / session verification phase
        if (authProvider.isInitial) {
          return matchedPath == AppRoutes.splash ? null : AppRoutes.splash;
        }

        // 2. Unauthenticated state -> enforce login
        if (!authProvider.isAuthenticated) {
          return matchedPath == AppRoutes.login ? null : AppRoutes.login;
        }

        // 3. Authenticated state -> role-aware dispatch
        final user = authProvider.user;
        if (user == null) {
          return AppRoutes.login;
        }

        // Admin-only accounts must use the Web Operations Portal
        final isAdminOnly = user.isAdmin && !user.isPassenger && !user.isDriver;
        if (isAdminOnly) {
          return matchedPath == AppRoutes.adminInfo
              ? null
              : AppRoutes.adminInfo;
        }

        // Non-admins attempting to access admin notice route
        if (matchedPath == AppRoutes.adminInfo && !user.isAdmin) {
          return AppRoutes.passengerHome;
        }

        // Redirect from transient screens (splash or login)
        if (matchedPath == AppRoutes.splash || matchedPath == AppRoutes.login) {
          if (user.isDriver && !user.isPassenger) {
            return AppRoutes.driverHome;
          }
          if (user.isPassenger && !user.isDriver) {
            return AppRoutes.passengerHome;
          }
          if (user.isDualRole) {
            if (appModeProvider.mode == AppMode.passenger) {
              return AppRoutes.passengerHome;
            }
            if (appModeProvider.mode == AppMode.driver) {
              return AppRoutes.driverHome;
            }
            return AppRoutes.roleSelection;
          }
          return AppRoutes.passengerHome;
        }

        // Driver route guard: non-drivers cannot access driver home
        if (matchedPath == AppRoutes.driverHome && !user.isDriver) {
          return AppRoutes.passengerHome;
        }

        // Driver onboarding guard: users with an existing driver profile cannot access onboarding
        if (matchedPath == AppRoutes.driverOnboarding &&
            user.driverProfile != null) {
          return AppRoutes.driverHome;
        }

        // Passenger route guard: non-passengers cannot access passenger routes
        if ((matchedPath == AppRoutes.passengerHome ||
                matchedPath == AppRoutes.passengerBooking ||
                matchedPath.startsWith('/passenger/bookings')) &&
            !user.isPassenger &&
            user.isDriver) {
          return AppRoutes.driverHome;
        }

        return null;
      },
      routes: [
        GoRoute(
          path: AppRoutes.splash,
          name: AppRoutes.splashName,
          builder: (context, state) => const SplashScreen(),
        ),
        GoRoute(
          path: AppRoutes.login,
          name: AppRoutes.loginName,
          builder: (context, state) => const LoginScreen(),
        ),
        GoRoute(
          path: AppRoutes.roleSelection,
          name: AppRoutes.roleSelectionName,
          builder: (context, state) => const RoleSelectionScreen(),
        ),
        GoRoute(
          path: AppRoutes.passengerHome,
          name: AppRoutes.passengerHomeName,
          builder: (context, state) => const PassengerHomeScreen(),
        ),
        GoRoute(
          path: AppRoutes.passengerBooking,
          name: AppRoutes.passengerBookingName,
          builder: (context, state) => const BookingFlowScreen(),
        ),
        GoRoute(
          path: AppRoutes.passengerBookingDetails,
          name: AppRoutes.passengerBookingDetailsName,
          builder: (context, state) {
            final id = state.pathParameters['id'] ?? '';
            return BookingDetailsScreen(bookingId: id);
          },
        ),
        GoRoute(
          path: AppRoutes.driverHome,
          name: AppRoutes.driverHomeName,
          builder: (context, state) => const DriverHomeScreen(),
        ),
        GoRoute(
          path: AppRoutes.driverOnboarding,
          name: AppRoutes.driverOnboardingName,
          builder: (context, state) => const DriverOnboardingScreen(),
        ),
        GoRoute(
          path: AppRoutes.adminInfo,
          name: AppRoutes.adminInfoName,
          builder: (context, state) => const AdminInfoScreen(),
        ),
      ],
      errorBuilder: (context, state) => Scaffold(
        appBar: AppBar(title: const Text('Route Not Found')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'No route configured for ${state.uri}',
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: () {
                    context.go(AppRoutes.splash);
                  },
                  child: const Text('Return to Home'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
