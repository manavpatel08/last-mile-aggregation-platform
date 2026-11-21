import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import 'package:lastmile_mobile/app/router/app_router.dart';
import 'package:lastmile_mobile/app/router/app_routes.dart';
import 'package:lastmile_mobile/app/state/app_mode_provider.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/booking/data/booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_cancellation_response.dart';
import 'package:lastmile_mobile/features/booking/models/booking_details.dart';
import 'package:lastmile_mobile/features/booking/models/booking_request.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/booking/models/cancellation_fee.dart';
import 'package:lastmile_mobile/features/booking/models/fare_quote.dart';
import 'package:lastmile_mobile/features/booking/models/location_validation.dart';
import 'package:lastmile_mobile/features/booking/models/pickup_point.dart';
import 'package:lastmile_mobile/features/booking/models/service_region.dart';
import 'package:lastmile_mobile/features/booking/services/passenger_location_service.dart';
import 'package:lastmile_mobile/features/booking/state/booking_details_provider.dart';
import 'package:lastmile_mobile/features/booking/state/booking_flow_provider.dart';
import 'package:lastmile_mobile/features/driver/state/driver_home_provider.dart';
import 'package:lastmile_mobile/features/driver/state/driver_onboarding_provider.dart';
import 'package:lastmile_mobile/features/passenger/state/passenger_home_provider.dart';

import '../../helpers/test_fakes.dart';

class _FakeBookingRepository implements BookingRepository {
  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async {
    return BookingDetails(
      bookingId: bookingId,
      status: 'CONFIRMED',
      agreedFareCeiling: '45.00',
      maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
    );
  }

  @override
  Future<BookingCancellationResponse> cancelBooking({
    required String bookingId,
    String? reason,
    required String idempotencyKey,
  }) async {
    return BookingCancellationResponse(
      bookingId: bookingId,
      status: 'CANCELLED',
      cancellationFeeAssessedPaise: 0,
      cancellationFeeStatus: 'NONE',
    );
  }

  @override
  Future<OutstandingCancellationFeesResponse>
      getOutstandingCancellationFees() async {
    return const OutstandingCancellationFeesResponse(
      totalOutstandingPaise: 0,
      fees: [],
    );
  }

  @override
  Future<BookingResponse> createBooking({
    required BookingRequest request,
    required String idempotencyKey,
  }) =>
      throw UnimplementedError();

  @override
  Future<BookingResponse?> getActiveBooking() async => null;

  @override
  Future<FareQuote> generateFareQuote({
    required String pickupPointId,
    required double destinationLatitude,
    required double destinationLongitude,
  }) =>
      throw UnimplementedError();

  @override
  Future<List<PickupPoint>> getPickupZones() async => const [];

  @override
  Future<List<ServiceRegion>> getServiceRegions() async => const [];

  @override
  Future<DestinationValidationResult> validateDestination({
    required double latitude,
    required double longitude,
  }) =>
      throw UnimplementedError();

  @override
  Future<PickupValidationResult> validatePickup({
    required String pickupPointId,
    required double latitude,
    required double longitude,
  }) =>
      throw UnimplementedError();
}

Widget _buildTestApp({
  required GoRouter router,
  required AuthProvider authProvider,
  required AppModeProvider appModeProvider,
}) {
  final fakeBookingRepo = _FakeBookingRepository();
  return MultiProvider(
    providers: [
      Provider<AppConfig>.value(value: AppConfig.fromEnvironment()),
      ChangeNotifierProvider<AuthProvider>.value(value: authProvider),
      ChangeNotifierProvider<AppModeProvider>.value(value: appModeProvider),
      ChangeNotifierProvider<PassengerHomeProvider>(
        create: (_) => PassengerHomeProvider(),
      ),
      ChangeNotifierProvider<DriverHomeProvider>(
        create: (_) => DriverHomeProvider(),
      ),
      ChangeNotifierProvider<DriverOnboardingProvider>(
        create: (_) => DriverOnboardingProvider(
          driverRepository: FakeDriverRepository(),
        ),
      ),
      ChangeNotifierProvider<BookingFlowProvider>(
        create: (_) => BookingFlowProvider(
          bookingRepository: fakeBookingRepo,
          locationService: FakePassengerLocationService(),
        ),
      ),
      ChangeNotifierProvider<BookingDetailsProvider>(
        create: (_) => BookingDetailsProvider(
          bookingRepository: fakeBookingRepo,
        ),
      ),
    ],
    child: MaterialApp.router(
      routerConfig: router,
    ),
  );
}

Future<AuthProvider> _createAuthenticatedProvider(AuthUser user) async {
  final tokenStore = AuthTokenStore();
  final secureStorage = SecureTokenStorage.inMemory({
    SecureTokenStorage.refreshTokenKey: 'valid-refresh-token',
  });
  final repo = FakeAuthRepository(currentUser: user);
  final provider = AuthProvider(
    authRepository: repo,
    googleSignInService: FakeGoogleSignInService(),
    tokenStore: tokenStore,
    secureStorage: secureStorage,
  );
  await provider.restoreSession();
  return provider;
}

Future<AuthProvider> _createUnauthenticatedProvider() async {
  final tokenStore = AuthTokenStore();
  final secureStorage = SecureTokenStorage.inMemory();
  final repo = FakeAuthRepository();
  final provider = AuthProvider(
    authRepository: repo,
    googleSignInService: FakeGoogleSignInService(),
    tokenStore: tokenStore,
    secureStorage: secureStorage,
  );
  await provider.restoreSession();
  return provider;
}

void main() {
  group('Booking Details RBAC Route Guard', () {
    testWidgets('passenger user is allowed to access /passenger/bookings/:id',
        (tester) async {
      const passengerUser = AuthUser(
        id: 'u-passenger',
        email: 'passenger@pdeu.ac.in',
        fullName: 'PDEU Passenger',
        role: 'PASSENGER',
        roles: ['PASSENGER'],
      );

      final authProvider = await _createAuthenticatedProvider(passengerUser);
      final appModeProvider = AppModeProvider(initialMode: AppMode.passenger);

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.passengerBookingDetailsPath('b-123'),
      );

      await tester.pumpWidget(
        _buildTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(router.state.matchedLocation, '/passenger/bookings/b-123');
    });

    testWidgets('driver-only user is redirected from /passenger/bookings/:id to /driver',
        (tester) async {
      const driverUser = AuthUser(
        id: 'u-driver',
        email: 'driver@pdeu.ac.in',
        fullName: 'PDEU Driver',
        role: 'DRIVER',
        roles: ['DRIVER'],
        driverProfile: DriverProfile(
          id: 'dp-1',
          licenseNumber: 'GJ-01-2023-0012345',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
        ),
      );

      final authProvider = await _createAuthenticatedProvider(driverUser);
      final appModeProvider = AppModeProvider(initialMode: AppMode.driver);

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.passengerBookingDetailsPath('b-123'),
      );

      await tester.pumpWidget(
        _buildTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(router.state.matchedLocation, AppRoutes.driverHome);
    });

    testWidgets('unauthenticated user is redirected from /passenger/bookings/:id to /login',
        (tester) async {
      final authProvider = await _createUnauthenticatedProvider();
      final appModeProvider = AppModeProvider(initialMode: AppMode.passenger);

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.passengerBookingDetailsPath('b-123'),
      );

      await tester.pumpWidget(
        _buildTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(router.state.matchedLocation, AppRoutes.login);
    });

    testWidgets('dual-role user in passenger mode is allowed to access /passenger/bookings/:id',
        (tester) async {
      const dualRoleUser = AuthUser(
        id: 'u-dual',
        email: 'dual@pdeu.ac.in',
        fullName: 'PDEU Dual Role',
        role: 'PASSENGER',
        roles: ['PASSENGER', 'DRIVER'],
        driverProfile: DriverProfile(
          id: 'dp-dual',
          licenseNumber: 'GJ-01-2023-0099999',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
        ),
      );

      final authProvider = await _createAuthenticatedProvider(dualRoleUser);
      final appModeProvider = AppModeProvider(initialMode: AppMode.passenger);

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.passengerBookingDetailsPath('b-456'),
      );

      await tester.pumpWidget(
        _buildTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(router.state.matchedLocation, '/passenger/bookings/b-456');
    });

    testWidgets('admin-only user is redirected from /passenger/bookings/:id to /admin-info',
        (tester) async {
      const adminUser = AuthUser(
        id: 'u-admin',
        email: 'admin@pdeu.ac.in',
        fullName: 'PDEU Admin',
        role: 'ADMIN',
        roles: ['ADMIN'],
      );

      final authProvider = await _createAuthenticatedProvider(adminUser);
      final appModeProvider = AppModeProvider(initialMode: AppMode.passenger);

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.passengerBookingDetailsPath('b-789'),
      );

      await tester.pumpWidget(
        _buildTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(router.state.matchedLocation, AppRoutes.adminInfo);
    });
  });
}
