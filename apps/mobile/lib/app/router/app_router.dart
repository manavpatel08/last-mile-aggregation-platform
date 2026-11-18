import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';

import '../../features/driver/presentation/screens/driver_home_screen.dart';
import '../../features/passenger/presentation/screens/passenger_home_screen.dart';
import '../../features/role_selection/presentation/screens/role_selection_screen.dart';
import '../state/app_mode_provider.dart';
import 'app_routes.dart';

/// Application-level `go_router` navigation foundation.
abstract final class AppRouter {
  static GoRouter createRouter({required AppModeProvider appModeProvider}) {
    return GoRouter(
      initialLocation: AppRoutes.initialLocationForMode(appModeProvider.mode),
      refreshListenable: appModeProvider,
      routes: [
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
          path: AppRoutes.driverHome,
          name: AppRoutes.driverHomeName,
          builder: (context, state) => const DriverHomeScreen(),
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
                    appModeProvider.clearMode();
                    context.go(AppRoutes.roleSelection);
                  },
                  child: const Text('Return to Role Selection'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
