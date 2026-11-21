import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/presentation/screens/login_screen.dart';
import 'package:lastmile_mobile/features/auth/presentation/screens/splash_screen.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/booking/services/passenger_location_service.dart';
import 'package:lastmile_mobile/features/driver/presentation/screens/driver_home_screen.dart';
import 'package:lastmile_mobile/features/passenger/presentation/screens/passenger_home_screen.dart';

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

  const driverUser = AuthUser(
    id: 'user-driver-1',
    email: 'driver@pdeu.ac.in',
    fullName: 'PDEU Driver',
    role: 'DRIVER',
    roles: ['DRIVER'],
    driverVerificationStatus: 'APPROVED',
    driverProfile: DriverProfile(
      id: 'driver-1',
      verificationStatus: 'APPROVED',
      operationalStatus: 'AVAILABLE',
      isOnline: true,
    ),
  );

  group('App Startup & Loading Behavior Regression Tests', () {
    testWidgets(
      'renders SplashScreen with branding and progress indicator when auth state is initial',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory();
        final repo = FakeAuthRepository();
        final googleService = FakeGoogleSignInService();
        final authProvider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        // Intentionally do NOT call restoreSession() beforehand so it starts in initial state
        expect(authProvider.isInitial, isTrue);

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

        // First frame before postFrameCallback executes
        expect(find.byType(SplashScreen), findsOneWidget);
        expect(find.text('LastMile'), findsOneWidget);
        expect(find.text('PDEU Campus Micro-Mobility'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsOneWidget);

        // Neither LoginScreen nor PassengerHomeScreen should be mounted yet
        expect(find.byType(LoginScreen), findsNothing);
        expect(find.byType(PassengerHomeScreen), findsNothing);
      },
    );

    testWidgets(
      'SplashScreen postFrameCallback automatically triggers session restoration while maintaining splash until settled',
      (tester) async {
        final refreshCompleter = Completer<void>();
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'stored-refresh-token',
        });
        final repo = FakeAuthRepository(
          currentUser: passengerUser,
          onRefreshSession: () => refreshCompleter.future,
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

        // Advance to run postFrameCallback
        await tester.pump();

        // Verify session refresh was initiated automatically by SplashScreen
        expect(repo.refreshCallCount, 1);

        // While the refresh operation is in flight, SplashScreen remains displayed
        expect(find.byType(SplashScreen), findsOneWidget);
        expect(find.byType(PassengerHomeScreen), findsNothing);

        // Complete the asynchronous refresh
        refreshCompleter.complete();
        await tester.pumpAndSettle();

        // Verify the app seamlessly transitions to the authenticated passenger home
        expect(find.byType(SplashScreen), findsNothing);
        expect(find.byType(PassengerHomeScreen), findsOneWidget);
        expect(find.text('Passenger Home'), findsOneWidget);
      },
    );

    testWidgets(
      'transitions from SplashScreen to LoginScreen when session restoration finds no stored credentials',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory(); // Empty storage
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

        // Allow postFrameCallback restoreSession to execute and settle
        await tester.pumpAndSettle();

        expect(find.byType(SplashScreen), findsNothing);
        expect(find.byType(LoginScreen), findsOneWidget);
        expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
        expect(find.text('Sign in with Google'), findsOneWidget);
      },
    );

    testWidgets(
      'transitions from SplashScreen to DriverHomeScreen when session restoration succeeds for driver',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-driver-token',
        });
        final repo = FakeAuthRepository(currentUser: driverUser);
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

        expect(find.byType(SplashScreen), findsNothing);
        expect(find.byType(DriverHomeScreen), findsOneWidget);
        expect(find.text('Driver Home'), findsOneWidget);
      },
    );

    testWidgets(
      'transitions from SplashScreen to LoginScreen with retry button when session restoration encounters a transient network error',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            errorCode: 'NETWORK_UNAVAILABLE',
            message: 'Unable to reach the server. Please check your network and try again.',
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
        expect(
          find.text('Unable to reach the server. Please check your network and try again.'),
          findsOneWidget,
        );
        expect(find.byKey(const Key('restore_session_retry_button')), findsOneWidget);
        expect(find.text('Retry'), findsOneWidget);

        // The refresh token must be preserved in secure storage across retryable errors
        expect(await secureStorage.getRefreshToken(), 'valid-token');
      },
    );

    testWidgets(
      'tapping Retry on LoginScreen re-attempts session restoration and transitions to home on recovery',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            errorCode: 'NETWORK_UNAVAILABLE',
            message: 'Unable to reach the server. Please check your network and try again.',
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

        expect(find.byKey(const Key('restore_session_retry_button')), findsOneWidget);

        // Network recovers: clear exception and set current user
        repo.refreshException = null;
        repo.currentUser = passengerUser;

        // Tap Retry
        await tester.tap(find.byKey(const Key('restore_session_retry_button')));
        await tester.pumpAndSettle();

        // Successful retry transitions user directly to Passenger Home
        expect(find.byType(LoginScreen), findsNothing);
        expect(find.byType(PassengerHomeScreen), findsOneWidget);
        expect(find.text('Passenger Home'), findsOneWidget);
      },
    );
  });
}
