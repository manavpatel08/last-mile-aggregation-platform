import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';

import '../../../../helpers/test_fakes.dart';

void main() {
  const testConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const passengerUser = AuthUser(
    id: 'passenger-user-1',
    email: 'passenger@pdeu.ac.in',
    fullName: 'Passenger Candidate',
    role: 'PASSENGER',
    roles: ['PASSENGER'],
  );

  group('DriverOnboardingScreen Widget Tests', () {
    testWidgets('renders all form input fields and submit button', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: passengerUser);
      final driverRepo = FakeDriverRepository();

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
        ),
      );
      await tester.pumpAndSettle();

      // On Passenger Home, verify Become a Driver button is visible
      final becomeDriverButton = find.byKey(const Key('become_driver_button'));
      expect(becomeDriverButton, findsOneWidget);

      // Tap Become a Driver to navigate to Driver Onboarding screen
      await tester.tap(becomeDriverButton);
      await tester.pumpAndSettle();

      expect(find.text('Driver Onboarding'), findsOneWidget);
      expect(find.byKey(const Key('license_number_field')), findsOneWidget);
      expect(find.byKey(const Key('registration_number_field')), findsOneWidget);
      expect(find.byKey(const Key('vehicle_type_dropdown')), findsOneWidget);
      expect(find.byKey(const Key('passenger_capacity_field')), findsOneWidget);
      expect(find.byKey(const Key('make_model_field')), findsOneWidget);
      expect(find.byKey(const Key('submit_onboarding_button')), findsOneWidget);
    });

    testWidgets('validates required fields and numerical capacity constraints', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: passengerUser);
      final driverRepo = FakeDriverRepository();

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
        ),
      );
      await tester.pumpAndSettle();

      // Navigate to onboarding
      await tester.tap(find.byKey(const Key('become_driver_button')));
      await tester.pumpAndSettle();

      // Submit with empty inputs
      await tester.ensureVisible(find.byKey(const Key('submit_onboarding_button')));
      await tester.ensureVisible(find.byKey(const Key('submit_onboarding_button')));
      await tester.tap(find.byKey(const Key('submit_onboarding_button')));
      await tester.pumpAndSettle();

      expect(find.text('Please enter your driving licence number'), findsOneWidget);
      expect(find.text('Please enter vehicle registration number'), findsOneWidget);
      expect(find.text('Please enter vehicle make and model'), findsOneWidget);
      expect(driverRepo.onboardCallCount, 0);

      // Test invalid capacity (< 1 or > 8)
      await tester.ensureVisible(find.byKey(const Key('passenger_capacity_field')));
      await tester.enterText(find.byKey(const Key('passenger_capacity_field')), '10');
      await tester.ensureVisible(find.byKey(const Key('submit_onboarding_button')));
      await tester.ensureVisible(find.byKey(const Key('submit_onboarding_button')));
      await tester.tap(find.byKey(const Key('submit_onboarding_button')));
      await tester.pumpAndSettle();

      expect(find.text('Capacity must be between 1 and 8'), findsOneWidget);
      expect(driverRepo.onboardCallCount, 0);
    });

    testWidgets('successful submission navigates to Driver Home and shows PENDING verification banner', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: passengerUser);
      final driverRepo = FakeDriverRepository();

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
        ),
      );
      await tester.pumpAndSettle();

      // Navigate to onboarding
      await tester.tap(find.byKey(const Key('become_driver_button')));
      await tester.pumpAndSettle();

      // Fill in valid details
      await tester.enterText(
        find.byKey(const Key('license_number_field')),
        'GJ-01-2023-0012345',
      );
      await tester.enterText(
        find.byKey(const Key('registration_number_field')),
        'GJ-01-AA-1234',
      );
      await tester.enterText(
        find.byKey(const Key('passenger_capacity_field')),
        '4',
      );
      await tester.enterText(
        find.byKey(const Key('make_model_field')),
        'Mahindra Treo',
      );

      // On GET /users/me after onboarding, backend returns DRIVER role and PENDING driverProfile
      authRepo.currentUser = const AuthUser(
        id: 'passenger-user-1',
        email: 'passenger@pdeu.ac.in',
        fullName: 'Passenger Candidate',
        role: 'DRIVER',
        roles: ['PASSENGER', 'DRIVER'],
        driverVerificationStatus: 'PENDING',
        driverProfile: DriverProfile(
          id: 'dp-pending-123',
          licenseNumber: 'GJ-01-2023-0012345',
          verificationStatus: 'PENDING',
          operationalStatus: 'OFFLINE',
          isOnline: false,
        ),
      );

      // Submit
      await tester.ensureVisible(find.byKey(const Key('submit_onboarding_button')));
      await tester.ensureVisible(find.byKey(const Key('submit_onboarding_button')));
      await tester.tap(find.byKey(const Key('submit_onboarding_button')));
      await tester.pumpAndSettle();

      expect(driverRepo.onboardCallCount, 1);
      // Lands on Driver Home!
      expect(find.text('Driver Home'), findsOneWidget);
      // Displays the PENDING verification banner!
      expect(find.text('Driver Verification: PENDING'), findsOneWidget);
    });

    testWidgets('shows error banner when backend returns 409 conflict', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: passengerUser);
      final driverRepo = FakeDriverRepository(shouldThrow: true);

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
        ),
      );
      await tester.pumpAndSettle();

      // Navigate to onboarding
      await tester.tap(find.byKey(const Key('become_driver_button')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('license_number_field')),
        'GJ-01-2023-DUPLICATE',
      );
      await tester.enterText(
        find.byKey(const Key('registration_number_field')),
        'GJ-01-AA-9999',
      );
      await tester.enterText(
        find.byKey(const Key('make_model_field')),
        'Mahindra Treo',
      );

      await tester.ensureVisible(find.byKey(const Key('submit_onboarding_button')));
      await tester.tap(find.byKey(const Key('submit_onboarding_button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('onboarding_error_banner')), findsOneWidget);
      expect(find.text('Driver profile already registered for this user'), findsOneWidget);
      // Stays on Driver Onboarding screen
      expect(find.text('Driver Onboarding'), findsOneWidget);
    });
  });
}
