import '../../core/config/app_config.dart';

/// Centralized route paths and names for `go_router`.
abstract final class AppRoutes {
  static const String splash = '/splash';
  static const String login = '/login';
  static const String roleSelection = '/role-selection';
  static const String passengerHome = '/passenger';
  static const String passengerBooking = '/passenger/book';
  static const String passengerBookingDetails = '/passenger/bookings/:id';
  static const String passengerActiveTrip = '/passenger/bookings/:id/trip';
  static const String driverHome = '/driver';
  static const String driverActiveTrip = '/driver/trips/:id';
  static const String driverOnboarding = '/driver/onboard';
  static const String adminInfo = '/admin-info';

  static const String splashName = 'splash';
  static const String loginName = 'login';
  static const String roleSelectionName = 'role-selection';
  static const String passengerHomeName = 'passenger-home';
  static const String passengerBookingName = 'passenger-booking';
  static const String passengerBookingDetailsName = 'passenger-booking-details';
  static const String passengerActiveTripName = 'passenger-active-trip';
  static const String driverHomeName = 'driver-home';
  static const String driverActiveTripName = 'driver-active-trip';
  static const String driverOnboardingName = 'driver-onboarding';
  static const String adminInfoName = 'admin-info';

  static String passengerBookingDetailsPath(String id) =>
      '/passenger/bookings/$id';
  static String passengerActiveTripPath(String id) =>
      '/passenger/bookings/$id/trip';
  static String driverActiveTripPath(String id) => '/driver/trips/$id';

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
