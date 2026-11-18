import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';

import 'helpers/test_fakes.dart';

void main() {
  const baseConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const dualRoleUser = AuthUser(
    id: 'user-dual-123',
    email: 'dual@pdeu.ac.in',
    fullName: 'Dual Role User',
    role: 'PASSENGER',
    roles: ['PASSENGER', 'DRIVER'],
    driverProfile: DriverProfile(
      id: 'driver-123',
      verificationStatus: 'APPROVED',
      operationalStatus: 'AVAILABLE',
      isOnline: true,
    ),
    passengerProfile: PassengerProfile(
      id: 'passenger-123',
      defaultMinGroupPreference: 2,
      totalRidesCompleted: 5,
    ),
  );

  const passengerOnlyUser = AuthUser(
    id: 'user-pass-123',
    email: 'passenger@pdeu.ac.in',
    fullName: 'Passenger Only',
    role: 'PASSENGER',
    roles: ['PASSENGER'],
    passengerProfile: PassengerProfile(
      id: 'passenger-123',
      defaultMinGroupPreference: 2,
      totalRidesCompleted: 3,
    ),
  );

  const driverOnlyUser = AuthUser(
    id: 'user-driver-123',
    email: 'driver@pdeu.ac.in',
    fullName: 'Driver Only',
    role: 'DRIVER',
    roles: ['DRIVER'],
    driverVerificationStatus: 'APPROVED',
    driverProfile: DriverProfile(
      id: 'driver-123',
      verificationStatus: 'APPROVED',
      operationalStatus: 'AVAILABLE',
      isOnline: true,
    ),
  );

  const adminUser = AuthUser(
    id: 'user-admin-123',
    email: 'admin@pdeu.ac.in',
    fullName: 'Admin User',
    role: 'ADMIN',
    roles: ['ADMIN'],
  );

  group('LastMileApp Navigation & Authentication Foundation', () {
    testWidgets(
      'unauthenticated app launch redirects to LoginScreen with Google sign-in button',
      (WidgetTester tester) async {
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

        // Run initial restore with no refresh token -> transitions to unauthenticated
        await authProvider.restoreSession();

        await tester.pumpWidget(
          LastMileApp(
            config: baseConfig,
            authProvider: authProvider,
            secureStorage: secureStorage,
            tokenStore: tokenStore,
            authRepository: repo,
            googleSignInService: googleService,
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('LastMile'), findsOneWidget);
        expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
        expect(find.text('Sign in with Google'), findsOneWidget);
      },
    );

    testWidgets(
      'navigates from Role Selection to Passenger Home and back for dual-role user',
      (WidgetTester tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
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
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('role_card_passenger')), findsOneWidget);
        expect(find.byKey(const Key('role_card_driver')), findsOneWidget);

        await tester.tap(find.text('Continue as Passenger'));
        await tester.pumpAndSettle();

        expect(find.text('Passenger Home'), findsOneWidget);
        expect(find.text('Passenger Workspace'), findsOneWidget);

        await tester.tap(find.byKey(const Key('switch_mode_button')));
        await tester.pumpAndSettle();

        expect(find.text('Choose an interface mode'), findsOneWidget);
      },
    );

    testWidgets(
      'navigates from Role Selection to Driver Home and back for dual-role user',
      (WidgetTester tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
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
          ),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.text('Continue as Driver'));
        await tester.tap(find.text('Continue as Driver'));
        await tester.pumpAndSettle();

        expect(find.text('Driver Home'), findsOneWidget);
        expect(find.text('Driver Workspace'), findsOneWidget);

        await tester.tap(find.byKey(const Key('switch_mode_button')));
        await tester.pumpAndSettle();

        expect(find.text('Choose an interface mode'), findsOneWidget);
      },
    );

    testWidgets(
      'lands passenger-only user directly on Passenger Home',
      (WidgetTester tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
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
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Passenger Home'), findsOneWidget);
        expect(find.text('Passenger Workspace'), findsOneWidget);
      },
    );

    testWidgets(
      'lands driver-only user directly on Driver Home',
      (WidgetTester tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
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
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Driver Home'), findsOneWidget);
        expect(find.text('Driver Workspace'), findsOneWidget);
      },
    );

    testWidgets(
      'lands admin-only user directly on AdminInfoScreen',
      (WidgetTester tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
        });
        final repo = FakeAuthRepository(currentUser: adminUser);
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
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Admin Portal Notice'), findsOneWidget);
        expect(find.text('Administrator Account'), findsOneWidget);
        expect(find.text('Web Portal Required'), findsOneWidget);
      },
    );

    testWidgets(
      'displays configured adminPortalUrl on AdminInfoScreen when provided',
      (WidgetTester tester) async {
        const portalConfig = AppConfig(
          apiBaseUrl: 'http://localhost:3000/api/v1',
          socketBaseUrl: 'ws://localhost:3000/realtime',
          appEnv: 'development',
          adminPortalUrl: 'https://admin.lastmile.pdeu.ac.in',
        );

        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
        });
        final repo = FakeAuthRepository(currentUser: adminUser);
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
            config: portalConfig,
            authProvider: authProvider,
            secureStorage: secureStorage,
            tokenStore: tokenStore,
            authRepository: repo,
            googleSignInService: googleService,
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('https://admin.lastmile.pdeu.ac.in'), findsOneWidget);
      },
    );

    testWidgets(
      'displays PENDING warning banner on Driver Home when verification is PENDING',
      (WidgetTester tester) async {
        const pendingDriverUser = AuthUser(
          id: 'driver-pending-1',
          email: 'driver-pending@pdeu.ac.in',
          fullName: 'Pending Driver',
          role: 'DRIVER',
          roles: ['DRIVER'],
          driverVerificationStatus: 'PENDING',
          driverProfile: DriverProfile(
            id: 'dp-pending',
            verificationStatus: 'PENDING',
            operationalStatus: 'OFFLINE',
            isOnline: false,
          ),
        );

        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
        });
        final repo = FakeAuthRepository(currentUser: pendingDriverUser);
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
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Driver Verification: PENDING'), findsOneWidget);
      },
    );

    testWidgets(
      'displays REJECTED banner on Driver Home when verification is REJECTED',
      (WidgetTester tester) async {
        const rejectedDriverUser = AuthUser(
          id: 'driver-rej-1',
          email: 'driver-rejected@pdeu.ac.in',
          fullName: 'Rejected Driver',
          role: 'DRIVER',
          roles: ['DRIVER'],
          driverVerificationStatus: 'REJECTED',
          driverProfile: DriverProfile(
            id: 'dp-rejected',
            verificationStatus: 'REJECTED',
            operationalStatus: 'OFFLINE',
            isOnline: false,
          ),
        );

        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
        });
        final repo = FakeAuthRepository(currentUser: rejectedDriverUser);
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
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Driver Application: REJECTED'), findsOneWidget);
      },
    );

    testWidgets(
      'displays SUSPENDED banner on Driver Home when verification is SUSPENDED',
      (WidgetTester tester) async {
        const suspendedDriverUser = AuthUser(
          id: 'driver-susp-1',
          email: 'driver-suspended@pdeu.ac.in',
          fullName: 'Suspended Driver',
          role: 'DRIVER',
          roles: ['DRIVER'],
          driverVerificationStatus: 'SUSPENDED',
          driverProfile: DriverProfile(
            id: 'dp-suspended',
            verificationStatus: 'SUSPENDED',
            operationalStatus: 'OFFLINE',
            isOnline: false,
          ),
        );

        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
        });
        final repo = FakeAuthRepository(currentUser: suspendedDriverUser);
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
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Driver Account: SUSPENDED'), findsOneWidget);
      },
    );

    testWidgets(
      'tapping logout on Passenger Home clears credentials and returns to Login',
      (WidgetTester tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
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
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Passenger Home'), findsOneWidget);

        await tester.tap(find.byKey(const Key('logout_button')));
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
        expect(find.text('Sign in with Google'), findsOneWidget);
        expect(await secureStorage.getRefreshToken(), isNull);
        expect(tokenStore.accessToken, isNull);
      },
    );
  });
}
