import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/app/router/app_routes.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/presentation/screens/login_screen.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/booking/presentation/screens/booking_flow_screen.dart';
import 'package:lastmile_mobile/features/booking/services/passenger_location_service.dart';
import 'package:lastmile_mobile/features/driver/presentation/screens/driver_home_screen.dart';
import 'package:lastmile_mobile/features/driver/presentation/screens/driver_onboarding_screen.dart';
import 'package:lastmile_mobile/features/passenger/presentation/screens/passenger_home_screen.dart';
import 'package:lastmile_mobile/features/role_selection/presentation/screens/role_selection_screen.dart';

import '../helpers/test_fakes.dart';

void main() {
  const baseConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const passengerOnlyUser = AuthUser(
    id: 'user-pass-1',
    email: 'passenger@pdeu.ac.in',
    fullName: 'PDEU Passenger',
    role: 'PASSENGER',
    roles: ['PASSENGER'],
    passengerProfile: PassengerProfile(
      id: 'passenger-1',
      defaultMinGroupPreference: 2,
      totalRidesCompleted: 2,
    ),
  );

  const driverOnlyUser = AuthUser(
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

  const dualRoleUser = AuthUser(
    id: 'user-dual-1',
    email: 'dual@pdeu.ac.in',
    fullName: 'Dual Role User',
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
      totalRidesCompleted: 4,
    ),
  );

  group('App Role-Based Access Control (RBAC) & Navigation Regression Tests', () {
    testWidgets(
      'passenger-only user attempting to navigate to /driver is redirected to /passenger',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: passengerOnlyUser);
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

        expect(find.byType(PassengerHomeScreen), findsOneWidget);

        final context = tester.element(find.byType(PassengerHomeScreen));
        GoRouter.of(context).go(AppRoutes.driverHome);
        await tester.pumpAndSettle();

        // RBAC guard redirects non-driver back to Passenger Home
        expect(find.byType(PassengerHomeScreen), findsOneWidget);
        expect(find.byType(DriverHomeScreen), findsNothing);
        expect(GoRouter.of(context).state.matchedLocation, AppRoutes.passengerHome);
      },
    );

    testWidgets(
      'passenger-only user attempting to navigate to /admin-info is redirected to /passenger',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: passengerOnlyUser);
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

        expect(find.byType(PassengerHomeScreen), findsOneWidget);

        final context = tester.element(find.byType(PassengerHomeScreen));
        GoRouter.of(context).go(AppRoutes.adminInfo);
        await tester.pumpAndSettle();

        // Non-admin redirect back to Passenger Home
        expect(find.byType(PassengerHomeScreen), findsOneWidget);
        expect(GoRouter.of(context).state.matchedLocation, AppRoutes.passengerHome);
      },
    );

    testWidgets(
      'passenger-only user taps "Become a Driver" button and navigates to /driver/onboard',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: passengerOnlyUser);
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

        expect(find.byKey(const Key('become_driver_button')), findsOneWidget);

        await tester.tap(find.byKey(const Key('become_driver_button')));
        await tester.pumpAndSettle();

        expect(find.byType(DriverOnboardingScreen), findsOneWidget);
        expect(find.text('Driver Onboarding'), findsOneWidget);
        expect(find.text('Join PDEU Micro-Mobility Fleet'), findsOneWidget);
      },
    );

    testWidgets(
      'driver-only user attempting to navigate to /passenger is redirected to /driver',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: driverOnlyUser);
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

        expect(find.byType(DriverHomeScreen), findsOneWidget);

        final context = tester.element(find.byType(DriverHomeScreen));
        GoRouter.of(context).go(AppRoutes.passengerHome);
        await tester.pumpAndSettle();

        // RBAC guard redirects non-passenger back to Driver Home
        expect(find.byType(DriverHomeScreen), findsOneWidget);
        expect(find.byType(PassengerHomeScreen), findsNothing);
        expect(GoRouter.of(context).state.matchedLocation, AppRoutes.driverHome);
      },
    );

    testWidgets(
      'driver-only user attempting to navigate to /passenger/book is redirected to /driver',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: driverOnlyUser);
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

        expect(find.byType(DriverHomeScreen), findsOneWidget);

        final context = tester.element(find.byType(DriverHomeScreen));
        GoRouter.of(context).go(AppRoutes.passengerBooking);
        await tester.pumpAndSettle();

        expect(find.byType(DriverHomeScreen), findsOneWidget);
        expect(find.byType(BookingFlowScreen), findsNothing);
        expect(GoRouter.of(context).state.matchedLocation, AppRoutes.driverHome);
      },
    );

    testWidgets(
      'driver-only user attempting to navigate to /admin-info is redirected to /driver',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: driverOnlyUser);
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

        expect(find.byType(DriverHomeScreen), findsOneWidget);

        final context = tester.element(find.byType(DriverHomeScreen));
        GoRouter.of(context).go(AppRoutes.adminInfo);
        await tester.pumpAndSettle();

        expect(find.byType(DriverHomeScreen), findsOneWidget);
        expect(GoRouter.of(context).state.matchedLocation, AppRoutes.driverHome);
      },
    );

    testWidgets(
      'approved driver attempting to navigate to /driver/onboard is redirected to /driver',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: driverOnlyUser);
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

        expect(find.byType(DriverHomeScreen), findsOneWidget);

        final context = tester.element(find.byType(DriverHomeScreen));
        GoRouter.of(context).go(AppRoutes.driverOnboarding);
        await tester.pumpAndSettle();

        // Already onboarded driver is redirected back to Driver Home
        expect(find.byType(DriverHomeScreen), findsOneWidget);
        expect(find.byType(DriverOnboardingScreen), findsNothing);
        expect(GoRouter.of(context).state.matchedLocation, AppRoutes.driverHome);
      },
    );

    testWidgets(
      'driver on DriverHomeScreen taps logout button and returns to LoginScreen',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: driverOnlyUser);
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

        expect(find.byType(DriverHomeScreen), findsOneWidget);
        expect(find.byKey(const Key('logout_button')), findsOneWidget);

        // Tap driver logout
        await tester.tap(find.byKey(const Key('logout_button')));
        await tester.pumpAndSettle();

        // Authenticated driver is logged out and returned to LoginScreen
        expect(find.byType(LoginScreen), findsOneWidget);
        expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
        expect(await secureStorage.getRefreshToken(), isNull);
        expect(tokenStore.accessToken, isNull);
      },
    );

    testWidgets(
      'dual-role user switches from Passenger mode to Driver mode in a single active session',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-token',
        });
        final repo = FakeAuthRepository(currentUser: dualRoleUser);
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

        // 1. Initial selection into Passenger mode
        await tester.tap(find.text('Continue as Passenger'));
        await tester.pumpAndSettle();
        expect(find.byType(PassengerHomeScreen), findsOneWidget);
        final passengerContext = tester.element(find.byType(PassengerHomeScreen));
        expect(GoRouter.of(passengerContext).state.matchedLocation, AppRoutes.passengerHome);

        // 2. Switch mode back to Role Selection
        await tester.tap(find.byKey(const Key('switch_mode_button')));
        await tester.pumpAndSettle();
        expect(find.byType(RoleSelectionScreen), findsOneWidget);
        final roleContext = tester.element(find.byType(RoleSelectionScreen));
        expect(GoRouter.of(roleContext).state.matchedLocation, AppRoutes.roleSelection);

        // 3. Select Driver mode within the same session
        await tester.ensureVisible(find.text('Continue as Driver'));
        await tester.tap(find.text('Continue as Driver'));
        await tester.pumpAndSettle();
        expect(find.byType(DriverHomeScreen), findsOneWidget);
        final driverContext = tester.element(find.byType(DriverHomeScreen));
        expect(GoRouter.of(driverContext).state.matchedLocation, AppRoutes.driverHome);
      },
    );
  });
}
