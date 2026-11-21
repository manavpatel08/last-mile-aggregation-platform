import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/presentation/screens/login_screen.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/booking/models/booking_request.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/booking/presentation/widgets/active_booking_card.dart';
import 'package:lastmile_mobile/features/booking/services/passenger_location_service.dart';
import 'package:lastmile_mobile/features/driver/presentation/screens/driver_home_screen.dart';
import 'package:lastmile_mobile/features/passenger/presentation/screens/passenger_home_screen.dart';
import 'package:lastmile_mobile/features/role_selection/presentation/screens/role_selection_screen.dart';

import '../helpers/test_fakes.dart';

void main() {
  const baseConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const passengerUser = AuthUser(
    id: 'user-pass-1',
    email: 'passenger@pdeu.ac.in',
    fullName: 'PDEU Passenger',
    role: 'PASSENGER',
    roles: ['PASSENGER'],
    passengerProfile: PassengerProfile(
      id: 'passenger-1',
      defaultMinGroupPreference: 2,
      totalRidesCompleted: 3,
    ),
  );

  const dualRoleUser = AuthUser(
    id: 'user-dual-1',
    email: 'dual@pdeu.ac.in',
    fullName: 'Dual Role Student',
    role: 'PASSENGER',
    roles: ['PASSENGER', 'DRIVER'],
    driverProfile: DriverProfile(
      id: 'driver-dual-1',
      verificationStatus: 'APPROVED',
      operationalStatus: 'AVAILABLE',
      isOnline: true,
    ),
    passengerProfile: PassengerProfile(
      id: 'passenger-dual-1',
      defaultMinGroupPreference: 2,
      totalRidesCompleted: 5,
    ),
  );

  group('App Session Restoration Regression Tests', () {
    testWidgets(
      'restoration with expired refresh token (401) clears credentials and navigates to LoginScreen with expiration notice',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'expired-refresh-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            statusCode: 401,
            errorCode: 'UNAUTHORIZED',
            message: 'Refresh token has expired or was revoked',
          ),
        );
        final googleService = FakeGoogleSignInService();
        final authProvider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await tester.pumpWidget(
          LastMileApp(
            config: baseConfig,
            authProvider: authProvider,
            secureStorage: secureStorage,
            tokenStore: tokenStore,
            authRepository: repo,
            googleSignInService: googleService,
            bookingRepository: FakeBookingRepository(),
            driverRepository: FakeDriverRepository(),
            locationService: FakePassengerLocationService(),
          ),
        );

        await tester.pumpAndSettle();

        expect(find.byType(LoginScreen), findsOneWidget);
        expect(find.text('Your session has expired. Please sign in again.'), findsOneWidget);
        expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);

        // Security check: expired token must be eradicated from secure storage
        expect(await secureStorage.getRefreshToken(), isNull);
        expect(tokenStore.accessToken, isNull);
      },
    );

    testWidgets(
      'restoration with secure storage read failure displays security error banner on LoginScreen',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = FailingSecureTokenStorage(failOnRead: true);
        final repo = FakeAuthRepository();
        final googleService = FakeGoogleSignInService();
        final authProvider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await tester.pumpWidget(
          LastMileApp(
            config: baseConfig,
            authProvider: authProvider,
            secureStorage: secureStorage,
            tokenStore: tokenStore,
            authRepository: repo,
            googleSignInService: googleService,
            bookingRepository: FakeBookingRepository(),
            driverRepository: FakeDriverRepository(),
            locationService: FakePassengerLocationService(),
          ),
        );

        await tester.pumpAndSettle();

        expect(find.byType(LoginScreen), findsOneWidget);
        expect(
          find.text('Unable to access secure storage. Please check device security settings and try again.'),
          findsOneWidget,
        );
        expect(find.byKey(const Key('restore_session_retry_button')), findsOneWidget);
      },
    );

    testWidgets(
      'restoring dual-role user with pre-configured passenger mode in AppConfig navigates directly to Passenger Home',
      (tester) async {
        const passengerModeConfig = AppConfig(
          apiBaseUrl: 'http://localhost:3000/api/v1',
          socketBaseUrl: 'ws://localhost:3000/realtime',
          appEnv: 'development',
          initialMode: AppMode.passenger,
        );

        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-dual-token',
        });
        final repo = FakeAuthRepository(currentUser: dualRoleUser);
        final googleService = FakeGoogleSignInService();
        final authProvider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await tester.pumpWidget(
          LastMileApp(
            config: passengerModeConfig,
            authProvider: authProvider,
            secureStorage: secureStorage,
            tokenStore: tokenStore,
            authRepository: repo,
            googleSignInService: googleService,
            bookingRepository: FakeBookingRepository(),
            driverRepository: FakeDriverRepository(),
            locationService: FakePassengerLocationService(),
          ),
        );

        await tester.pumpAndSettle();

        // Must bypass RoleSelectionScreen and land straight on Passenger Home
        expect(find.byType(RoleSelectionScreen), findsNothing);
        expect(find.byType(PassengerHomeScreen), findsOneWidget);
        expect(find.text('Passenger Home'), findsOneWidget);
        expect(find.byKey(const Key('switch_mode_button')), findsOneWidget);
      },
    );

    testWidgets(
      'restoring dual-role user with pre-configured driver mode in AppConfig navigates directly to Driver Home',
      (tester) async {
        const driverModeConfig = AppConfig(
          apiBaseUrl: 'http://localhost:3000/api/v1',
          socketBaseUrl: 'ws://localhost:3000/realtime',
          appEnv: 'development',
          initialMode: AppMode.driver,
        );

        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-dual-token',
        });
        final repo = FakeAuthRepository(currentUser: dualRoleUser);
        final googleService = FakeGoogleSignInService();
        final authProvider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await tester.pumpWidget(
          LastMileApp(
            config: driverModeConfig,
            authProvider: authProvider,
            secureStorage: secureStorage,
            tokenStore: tokenStore,
            authRepository: repo,
            googleSignInService: googleService,
            bookingRepository: FakeBookingRepository(),
            driverRepository: FakeDriverRepository(),
            locationService: FakePassengerLocationService(),
          ),
        );

        await tester.pumpAndSettle();

        // Must bypass RoleSelectionScreen and land straight on Driver Home
        expect(find.byType(RoleSelectionScreen), findsNothing);
        expect(find.byType(DriverHomeScreen), findsOneWidget);
        expect(find.text('Driver Home'), findsOneWidget);
        expect(find.byKey(const Key('switch_mode_button')), findsOneWidget);
      },
    );

    testWidgets(
      'restoring passenger session with active booking renders active booking card on Passenger Home',
      (tester) async {
        final activeBooking = BookingResponse(
          bookingId: 'book-active-99',
          status: 'CONFIRMED',
          agreedFareCeiling: '45.00',
          maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
          pickupPointName: 'PDEU Main Gate Transit Hub',
          destinationLocation: const BookingLocation(
            latitude: 23.1885,
            longitude: 72.6288,
          ),
        );

        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-passenger-token',
        });
        final authRepo = FakeAuthRepository(currentUser: passengerUser);
        final bookingRepo = FakeBookingRepository(activeBooking: activeBooking);
        final googleService = FakeGoogleSignInService();
        final authProvider = AuthProvider(
          authRepository: authRepo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await tester.pumpWidget(
          LastMileApp(
            config: baseConfig,
            authProvider: authProvider,
            secureStorage: secureStorage,
            tokenStore: tokenStore,
            authRepository: authRepo,
            googleSignInService: googleService,
            bookingRepository: bookingRepo,
            driverRepository: FakeDriverRepository(),
            locationService: FakePassengerLocationService(),
          ),
        );

        await tester.pumpAndSettle();

        expect(find.byType(PassengerHomeScreen), findsOneWidget);
        expect(find.byType(ActiveBookingCard), findsOneWidget);
        expect(find.byKey(const Key('active_booking_card')), findsOneWidget);
        expect(find.text('Active Booking'), findsOneWidget);
        expect(find.text('₹45.00'), findsOneWidget);
        expect(find.text('CONFIRMED'), findsOneWidget);
      },
    );
  });
}
