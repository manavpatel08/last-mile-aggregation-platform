import '../../core/config/app_config.dart';

/// Centralized route paths and names for `go_router`.
abstract final class AppRoutes {
  static const String splash = '/splash';
  static const String login = '/login';
  static const String roleSelection = '/role-selection';
  static const String passengerHome = '/passenger';
  static const String passengerBooking = '/passenger/book';
  static const String driverHome = '/driver';
  static const String driverOnboarding = '/driver/onboard';
  static const String adminInfo = '/admin-info';

  static const String splashName = 'splash';
  static const String loginName = 'login';
  static const String roleSelectionName = 'role-selection';
  static const String passengerHomeName = 'passenger-home';
  static const String passengerBookingName = 'passenger-booking';
  static const String driverHomeName = 'driver-home';
  static const String driverOnboardingName = 'driver-onboarding';
  static const String adminInfoName = 'admin-info';

  static String initialLocationForMode(AppMode mode) {
    switch (mode) {
      case AppMode.passenger:
        return passengerHome;
      case AppMode.driver:
        return driverHome;
      case AppMode.unselected:
        return splash;
    }
  }
}
