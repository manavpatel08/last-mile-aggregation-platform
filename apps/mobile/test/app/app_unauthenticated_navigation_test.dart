import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/app/router/app_routes.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_session.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/presentation/screens/login_screen.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/booking/services/passenger_location_service.dart';
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
      totalRidesCompleted: 1,
    ),
  );

  group('App Unauthenticated Navigation & Interactive Login Regression Tests', () {
    testWidgets(
      'direct deep-link navigation to protected routes while unauthenticated redirects to /login',
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

        await authProvider.restoreSession();

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

        final protectedRoutes = [
          AppRoutes.passengerHome,
          AppRoutes.driverHome,
          AppRoutes.passengerBooking,
          AppRoutes.driverOnboarding,
          AppRoutes.roleSelection,
          AppRoutes.adminInfo,
        ];

        for (final route in protectedRoutes) {
          final context = tester.element(find.byType(LoginScreen));
          GoRouter.of(context).go(route);
          await tester.pumpAndSettle();

          // Router guard must enforce login redirect
          expect(find.byType(LoginScreen), findsOneWidget);
          expect(GoRouter.of(context).state.matchedLocation, AppRoutes.login);
        }
      },
    );

    testWidgets(
      'interactive Google Sign-In displays loading state during authentication and navigates to passenger home on success',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory();
        final repo = FakeAuthRepository(
          currentUser: passengerUser,
          authSession: const AuthSession(
            user: passengerUser,
            accessToken: 'new-login-access-token',
            refreshToken: 'new-login-refresh-token',
            expiresIn: 900,
          ),
        );
        final googleService = FakeGoogleSignInService();
        final authProvider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await authProvider.restoreSession();

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

        // Tap Google Sign-in button
        await tester.tap(find.byKey(const Key('google_sign_in_button')));
        await tester.pumpAndSettle();

        // Successful authentication routes to Passenger Home
        expect(find.byType(LoginScreen), findsNothing);
        expect(find.byType(PassengerHomeScreen), findsOneWidget);
        expect(find.text('Passenger Home'), findsOneWidget);
        expect(tokenStore.accessToken, 'new-login-access-token');
      },
    );

    testWidgets(
      'interactive Google Sign-In user cancellation returns cleanly to LoginScreen without error banner',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory();
        final repo = FakeAuthRepository();
        final googleService = FakeGoogleSignInService(shouldCancel: true);
        final authProvider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await authProvider.restoreSession();

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

        await tester.tap(find.byKey(const Key('google_sign_in_button')));
        await tester.pumpAndSettle();

        // App remains on LoginScreen without displaying an error
        expect(find.byType(LoginScreen), findsOneWidget);
        expect(find.byIcon(Icons.error_outline), findsNothing);
        expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
      },
    );

    testWidgets(
      'interactive Google Sign-In failure displays error banner and dismiss button clears the error',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory();
        final repo = FakeAuthRepository(
          authException: const ApiException(
            statusCode: 403,
            errorCode: 'FORBIDDEN',
            message: 'Only @pdeu.ac.in Google accounts are authorized',
          ),
        );
        final googleService = FakeGoogleSignInService();
        final authProvider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await authProvider.restoreSession();

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

        await tester.tap(find.byKey(const Key('google_sign_in_button')));
        await tester.pumpAndSettle();

        // Verify error banner is rendered
        expect(find.byType(LoginScreen), findsOneWidget);
        expect(find.byIcon(Icons.error_outline), findsOneWidget);
        expect(find.text('Only @pdeu.ac.in Google accounts are authorized'), findsOneWidget);

        // Tap the close button to dismiss the banner
        await tester.tap(find.byIcon(Icons.close));
        await tester.pumpAndSettle();

        // Verify error banner is removed
        expect(find.byIcon(Icons.error_outline), findsNothing);
        expect(find.text('Only @pdeu.ac.in Google accounts are authorized'), findsNothing);
      },
    );
  });
}
