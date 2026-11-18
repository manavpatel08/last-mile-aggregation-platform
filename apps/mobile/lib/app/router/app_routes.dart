import '../../core/config/app_config.dart';

/// Centralized route paths and names for `go_router`.
abstract final class AppRoutes {
  static const String roleSelection = '/';
  static const String passengerHome = '/passenger';
  static const String driverHome = '/driver';

  static const String roleSelectionName = 'role-selection';
  static const String passengerHomeName = 'passenger-home';
  static const String driverHomeName = 'driver-home';

  static String initialLocationForMode(AppMode mode) {
    switch (mode) {
      case AppMode.passenger:
        return passengerHome;
      case AppMode.driver:
        return driverHome;
      case AppMode.unselected:
        return roleSelection;
    }
  }
}
