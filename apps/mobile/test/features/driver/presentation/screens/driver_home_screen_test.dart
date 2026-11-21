import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/driver/models/driver_status_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_vehicle.dart';
import 'package:lastmile_mobile/features/driver/state/driver_home_provider.dart';
import 'package:lastmile_mobile/features/driver/state/driver_onboarding_provider.dart';

import '../../../../helpers/test_fakes.dart';

void main() {
  const testConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const approvedDriverUser = AuthUser(
    id: 'driver-approved-1',
    email: 'driver.approved@pdeu.ac.in',
    fullName: 'Approved Driver',
    role: 'DRIVER',
    roles: ['DRIVER'],
    driverVerificationStatus: 'APPROVED',
    driverProfile: DriverProfile(
      id: 'dp-approved-1',
      licenseNumber: 'GJ-01-2023-0099999',
      verificationStatus: 'APPROVED',
      operationalStatus: 'AVAILABLE',
      isOnline: true,
    ),
  );

  const pendingDriverUser = AuthUser(
    id: 'driver-pending-1',
    email: 'driver.pending@pdeu.ac.in',
    fullName: 'Pending Driver',
    role: 'DRIVER',
    roles: ['DRIVER'],
    driverVerificationStatus: 'PENDING',
    driverProfile: DriverProfile(
      id: 'dp-pending-1',
      licenseNumber: 'GJ-01-2023-0011111',
      verificationStatus: 'PENDING',
      operationalStatus: 'OFFLINE',
      isOnline: false,
    ),
  );

  const rejectedDriverUser = AuthUser(
    id: 'driver-rejected-1',
    email: 'driver.rejected@pdeu.ac.in',
    fullName: 'Rejected Driver',
    role: 'DRIVER',
    roles: ['DRIVER'],
    driverVerificationStatus: 'REJECTED',
    driverProfile: DriverProfile(
      id: 'dp-rejected-1',
      licenseNumber: 'GJ-01-2023-0022222',
      verificationStatus: 'REJECTED',
      operationalStatus: 'OFFLINE',
      isOnline: false,
    ),
  );

  const suspendedDriverUser = AuthUser(
    id: 'driver-suspended-1',
    email: 'driver.suspended@pdeu.ac.in',
    fullName: 'Suspended Driver',
    role: 'DRIVER',
    roles: ['DRIVER'],
    driverVerificationStatus: 'SUSPENDED',
    driverProfile: DriverProfile(
      id: 'dp-suspended-1',
      licenseNumber: 'GJ-01-2023-0033333',
      verificationStatus: 'SUSPENDED',
      operationalStatus: 'OFFLINE',
      isOnline: false,
    ),
  );

  const dualRoleApprovedDriverUser = AuthUser(
    id: 'driver-dual-1',
    email: 'driver.dual@pdeu.ac.in',
    fullName: 'Dual Role Driver',
    role: 'DRIVER',
    roles: ['DRIVER', 'PASSENGER'],
    driverVerificationStatus: 'APPROVED',
    driverProfile: DriverProfile(
      id: 'dp-dual-1',
      licenseNumber: 'GJ-01-2023-0044444',
      verificationStatus: 'APPROVED',
      operationalStatus: 'AVAILABLE',
      isOnline: true,
    ),
    passengerProfile: PassengerProfile(
      id: 'pass-dual-1',
      defaultMinGroupPreference: 2,
      totalRidesCompleted: 5,
    ),
  );

  const sampleVehicle = DriverVehicle(
    id: 'veh-sample-1',
    driverProfileId: 'dp-approved-1',
    registrationNumber: 'GJ-01-AB-1234',
    vehicleType: 'E_RICKSHAW',
    passengerCapacity: 4,
    makeModel: 'Mahindra Treo',
    isActive: true,
  );

  group('DriverHomeScreen Widget Tests', () {
    testWidgets('renders functional readiness dashboard for APPROVED driver', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: approvedDriverUser);
      final driverRepo = FakeDriverRepository(
        statusResponse: const DriverStatusResponse(
          id: 'dp-approved-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
          vehiclesCount: 1,
        ),
        vehiclesResponse: [sampleVehicle],
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // Verify app bar and workspace header
      expect(find.text('Driver Home'), findsOneWidget);
      expect(find.text('Driver Workspace'), findsOneWidget);
      expect(find.byKey(const Key('driver_verification_status_chip')), findsOneWidget);

      // Verify operational status for approved driver
      expect(find.byKey(const Key('driver_operational_status')), findsOneWidget);
      expect(find.text('AVAILABLE'), findsAtLeastNWidgets(1));

      // Verify server connection online state
      expect(find.byKey(const Key('driver_online_state')), findsOneWidget);
      expect(find.text('Online'), findsOneWidget);

      // Verify vehicle count
      expect(find.byKey(const Key('driver_vehicle_count')), findsOneWidget);
      expect(find.text('1 vehicle'), findsOneWidget);

      // Verify registered vehicle card details
      expect(find.byKey(const Key('driver_vehicle_card_veh-sample-1')), findsOneWidget);
      expect(find.byKey(const Key('vehicle_registration_GJ-01-AB-1234')), findsOneWidget);
      expect(find.text('GJ-01-AB-1234'), findsOneWidget);
      expect(find.text('Mahindra Treo'), findsOneWidget);
      expect(find.text('E_RICKSHAW'), findsOneWidget);
      expect(find.text('4'), findsOneWidget);
      expect(find.text('Active'), findsOneWidget);

      // Verify both endpoints were called
      expect(driverRepo.getStatusCallCount, 1);
      expect(driverRepo.getVehiclesCallCount, 1);
    });

    testWidgets('renders PENDING state: shows warning banner and disables operational status', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: pendingDriverUser);
      final driverRepo = FakeDriverRepository(
        vehiclesResponse: [sampleVehicle],
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // PENDING banner must be displayed
      expect(find.text('Driver Verification: PENDING'), findsOneWidget);

      // Operational status is Disabled (not approved)
      expect(find.byKey(const Key('driver_operational_status_disabled')), findsOneWidget);
      expect(find.text('Disabled'), findsOneWidget);

      // Server state indicates Offline (Not Approved)
      expect(find.byKey(const Key('driver_online_state_disabled')), findsOneWidget);
      expect(find.text('Offline (Not Approved)'), findsOneWidget);

      // Vehicle is still displayed (scroll down to reveal below the fold)
      await tester.scrollUntilVisible(
        find.text('GJ-01-AB-1234'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('GJ-01-AB-1234'), findsOneWidget);

      // CRITICAL GUARD: getDriverStatus must NEVER be called for PENDING driver!
      expect(driverRepo.getStatusCallCount, 0);
      expect(driverRepo.getVehiclesCallCount, 1);
    });

    testWidgets('renders REJECTED state: shows error banner and disables operational status', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: rejectedDriverUser);
      final driverRepo = FakeDriverRepository();

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver Application: REJECTED'), findsOneWidget);
      expect(find.byKey(const Key('driver_operational_status_disabled')), findsOneWidget);
      expect(driverRepo.getStatusCallCount, 0);
    });

    testWidgets('renders SUSPENDED state: shows suspension banner and disables operational status', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: suspendedDriverUser);
      final driverRepo = FakeDriverRepository();

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver Account: SUSPENDED'), findsOneWidget);
      expect(find.byKey(const Key('driver_operational_status_disabled')), findsOneWidget);
      expect(driverRepo.getStatusCallCount, 0);
    });

    testWidgets('displays empty vehicles card when vehicle list is empty', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: approvedDriverUser);
      final driverRepo = FakeDriverRepository(
        statusResponse: const DriverStatusResponse(
          id: 'dp-approved-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
          vehiclesCount: 0,
        ),
        vehiclesResponse: [],
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('driver_empty_vehicles_card')), findsOneWidget);
      expect(find.text('No Registered Vehicles'), findsOneWidget);
      expect(find.text('0 vehicles'), findsOneWidget);
    });

    testWidgets('displays error banner on failure and retries on button tap', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: approvedDriverUser);
      final driverRepo = FakeDriverRepository(
        shouldThrowOnStatus: true,
        statusException: const ApiException(
          statusCode: 500,
          errorCode: 'SERVER_ERROR',
          message: 'Status endpoint unreachable',
        ),
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // Error banner is displayed
      expect(find.byKey(const Key('driver_dashboard_error_banner')), findsOneWidget);
      expect(find.text('Failed to load driver dashboard'), findsOneWidget);
      expect(find.text('Status endpoint unreachable'), findsOneWidget);

      final retryButton = find.byKey(const Key('driver_dashboard_retry_button'));
      expect(retryButton, findsOneWidget);

      // Now heal the fake repository and tap retry
      driverRepo.shouldThrowOnStatus = false;
      driverRepo.statusException = null;
      driverRepo.statusResponse = const DriverStatusResponse(
        id: 'dp-approved-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
        vehiclesCount: 1,
      );
      driverRepo.vehiclesResponse = [sampleVehicle];

      await tester.tap(retryButton);
      await tester.pumpAndSettle();

      // Error banner is dismissed, dashboard is rendered
      expect(find.byKey(const Key('driver_dashboard_error_banner')), findsNothing);
      expect(find.byKey(const Key('driver_operational_status')), findsOneWidget);
      expect(find.text('AVAILABLE'), findsAtLeastNWidgets(1));
    });

    testWidgets('pull-to-refresh triggers refreshDashboard', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: approvedDriverUser);
      final driverRepo = FakeDriverRepository(
        statusResponse: const DriverStatusResponse(
          id: 'dp-approved-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
          vehiclesCount: 1,
        ),
        vehiclesResponse: [sampleVehicle],
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      expect(driverRepo.getStatusCallCount, 1);

      // Perform swipe down to trigger refresh
      await tester.fling(
        find.byKey(const Key('driver_dashboard_refresh_indicator')),
        const Offset(0, 300),
        1000,
      );
      await tester.pumpAndSettle();

      expect(driverRepo.getStatusCallCount, 2);
      expect(driverRepo.getVehiclesCallCount, 2);
    });

    testWidgets('dual-role user sees switch button and can navigate to role selection', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: dualRoleApprovedDriverUser);
      final driverRepo = FakeDriverRepository(vehiclesResponse: [sampleVehicle]);

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

      // Dual-role user begins on Role Selection
      expect(find.text('Choose an interface mode'), findsOneWidget);

      // Select Driver mode
      await tester.ensureVisible(find.text('Continue as Driver'));
      await tester.tap(find.text('Continue as Driver'));
      await tester.pumpAndSettle();

      final switchButton = find.byKey(const Key('switch_mode_button'));
      expect(switchButton, findsOneWidget);

      await tester.tap(switchButton);
      await tester.pumpAndSettle();

      expect(find.text('Choose an interface mode'), findsOneWidget);
    });

    testWidgets('tapping logout button logs out user', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: approvedDriverUser);
      final driverRepo = FakeDriverRepository(vehiclesResponse: [sampleVehicle]);

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

      final logoutButton = find.byKey(const Key('logout_button'));
      expect(logoutButton, findsOneWidget);

      await tester.tap(logoutButton);
      await tester.pumpAndSettle();

      expect(authProvider.isAuthenticated, isFalse);
    });

    testWidgets('cross-account isolation: data from first driver is never displayed to second driver', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: approvedDriverUser);
      final driverRepo = FakeDriverRepository(
        statusResponse: const DriverStatusResponse(
          id: 'dp-approved-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
          vehiclesCount: 1,
        ),
        vehiclesResponse: [sampleVehicle],
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // Driver 1 data is displayed
      expect(find.text('GJ-01-AB-1234'), findsOneWidget);
      expect(find.text('Mahindra Treo'), findsOneWidget);
      expect(find.text('AVAILABLE'), findsAtLeastNWidgets(1));

      // Driver 1 logs out
      await tester.tap(find.byKey(const Key('logout_button')));
      await tester.pumpAndSettle();

      // On login screen; verify driver provider state was cleared
      expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
      expect(homeProvider.status, isNull);
      expect(homeProvider.vehicles, isEmpty);
      expect(homeProvider.hasLoaded, isFalse);

      // Prepare Driver 2 with a different vehicle and PENDING status
      const driver2User = AuthUser(
        id: 'driver-user-2',
        email: 'driver2@pdeu.ac.in',
        fullName: 'Driver Two',
        role: 'DRIVER',
        roles: ['DRIVER'],
        driverVerificationStatus: 'PENDING',
        driverProfile: DriverProfile(
          id: 'dp-user-2',
          licenseNumber: 'GJ-02-2023-0099999',
          verificationStatus: 'PENDING',
          operationalStatus: 'OFFLINE',
          isOnline: false,
        ),
      );
      const driver2Vehicle = DriverVehicle(
        id: 'veh-driver-2',
        driverProfileId: 'dp-user-2',
        registrationNumber: 'GJ-02-CD-5678',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Mayuri Deluxe',
        isActive: true,
      );

      driverRepo.statusResponse = null;
      driverRepo.vehiclesResponse = [driver2Vehicle];
      authRepo.currentUser = driver2User;

      // Sign in as Driver 2
      await tester.tap(find.byKey(const Key('google_sign_in_button')));
      await tester.pumpAndSettle();

      // CRITICAL ASSERTION: Driver 1 data is NEVER displayed to Driver 2!
      expect(find.text('GJ-01-AB-1234'), findsNothing);
      expect(find.text('Mahindra Treo'), findsNothing);
      expect(find.text('AVAILABLE'), findsNothing);

      // Driver 2's dashboard is displayed
      expect(find.text('Driver Verification: PENDING'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('GJ-02-CD-5678'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('GJ-02-CD-5678'), findsOneWidget);
      expect(find.text('Mayuri Deluxe'), findsOneWidget);
    });

    testWidgets('non-approved driver initial vehicle fetch failure displays error banner and does not display empty vehicles card', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: pendingDriverUser);
      final driverRepo = FakeDriverRepository(
        shouldThrowOnVehicles: true,
        vehiclesException: const ApiException(
          statusCode: 500,
          errorCode: 'SERVER_ERROR',
          message: 'Failed to retrieve registered vehicles',
        ),
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // Error banner is displayed with clear message
      expect(find.byKey(const Key('driver_dashboard_error_banner')), findsOneWidget);
      expect(find.text('Failed to retrieve registered vehicles'), findsOneWidget);

      // Must NOT display "No Registered Vehicles" as though API succeeded with 0 vehicles!
      expect(find.byKey(const Key('driver_empty_vehicles_card')), findsNothing);
      expect(find.text('No Registered Vehicles'), findsNothing);

      // Retry button is available
      final retryButton = find.byKey(const Key('driver_dashboard_retry_button'));
      expect(retryButton, findsOneWidget);

      // Status endpoint must never have been called for PENDING driver
      expect(driverRepo.getStatusCallCount, 0);

      // Heal repository and tap retry
      driverRepo.shouldThrowOnVehicles = false;
      driverRepo.vehiclesException = null;
      driverRepo.vehiclesResponse = [sampleVehicle];

      await tester.tap(retryButton);
      await tester.pumpAndSettle();

      // Error banner dismissed, vehicle card appears
      expect(find.byKey(const Key('driver_dashboard_error_banner')), findsNothing);
      await tester.scrollUntilVisible(
        find.text('GJ-01-AB-1234'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('GJ-01-AB-1234'), findsOneWidget);
    });

    testWidgets('non-approved driver refresh vehicle fetch failure displays error banner and preserves existing vehicle card', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: pendingDriverUser);
      final driverRepo = FakeDriverRepository(
        vehiclesResponse: [sampleVehicle],
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // Initial vehicle loaded
      expect(homeProvider.hasLoaded, isTrue);
      expect(homeProvider.vehicles.length, 1);

      // Trigger refresh failure
      driverRepo.shouldThrowOnVehicles = true;
      driverRepo.vehiclesException = const ApiException(
        statusCode: 503,
        errorCode: 'SERVICE_UNAVAILABLE',
        message: 'Vehicle service temporarily down',
      );

      // Perform swipe down to trigger refresh
      await tester.fling(
        find.byKey(const Key('driver_dashboard_refresh_indicator')),
        const Offset(0, 300),
        1000,
      );
      await tester.pumpAndSettle();

      // Error banner is displayed
      expect(find.byKey(const Key('driver_dashboard_error_banner')), findsOneWidget);
      expect(find.text('Vehicle service temporarily down'), findsOneWidget);

      // Existing vehicle data must be preserved and still visible
      await tester.scrollUntilVisible(
        find.text('GJ-01-AB-1234'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('GJ-01-AB-1234'), findsOneWidget);

      // getDriverStatus must NEVER be called for PENDING driver
      expect(driverRepo.getStatusCallCount, 0);
    });

    testWidgets('successful profile sync transitions driver from PENDING to APPROVED and reloads dashboard', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: pendingDriverUser);
      final driverRepo = FakeDriverRepository(
        vehiclesResponse: [sampleVehicle],
        statusResponse: const DriverStatusResponse(
          id: 'dp-pending-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
          vehiclesCount: 1,
        ),
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final onboardingProvider = DriverOnboardingProvider(driverRepository: driverRepo);
      onboardingProvider.setProfileRefreshPending(true);

      final homeProvider = DriverHomeProvider(driverRepository: driverRepo);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverOnboardingProvider: onboardingProvider,
          driverHomeProvider: homeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // Pending sync banner and PENDING driver banner are visible
      expect(find.byKey(const Key('pending_sync_banner')), findsOneWidget);
      expect(find.byKey(const Key('refresh_application_status_button')), findsOneWidget);
      expect(find.text('Driver Verification: PENDING'), findsOneWidget);

      await tester.scrollUntilVisible(
        find.byKey(const Key('driver_operational_status_disabled')),
        100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.byKey(const Key('driver_operational_status_disabled')), findsOneWidget);

      // getDriverStatus must not have been called yet
      expect(driverRepo.getStatusCallCount, 0);

      // Admin approves driver on backend: update currentUser in auth repo
      const newlyApprovedDriver = AuthUser(
        id: 'driver-pending-1',
        email: 'driver.pending@pdeu.ac.in',
        fullName: 'Pending Driver',
        role: 'DRIVER',
        roles: ['DRIVER'],
        driverVerificationStatus: 'APPROVED',
        driverProfile: DriverProfile(
          id: 'dp-pending-1',
          licenseNumber: 'GJ-01-2023-0011111',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
        ),
      );
      authRepo.currentUser = newlyApprovedDriver;

      // Scroll back up to the top so refresh button is fully visible
      await tester.fling(find.byType(Scrollable).first, const Offset(0, 500), 1000);
      await tester.pumpAndSettle();

      // Tap "Refresh Application Status"
      await tester.tap(find.byKey(const Key('refresh_application_status_button')));
      await tester.pumpAndSettle();

      // Pending sync banner and warning banner are dismissed
      expect(find.byKey(const Key('pending_sync_banner')), findsNothing);
      expect(find.text('Driver Verification: PENDING'), findsNothing);

      // Dashboard now reflects APPROVED state
      await tester.scrollUntilVisible(
        find.byKey(const Key('driver_operational_status')),
        100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.byKey(const Key('driver_operational_status')), findsOneWidget);
      expect(find.text('AVAILABLE'), findsAtLeastNWidgets(1));
      expect(find.byKey(const Key('driver_online_state')), findsOneWidget);
      expect(find.text('Online'), findsOneWidget);

      // getDriverStatus was called exactly once upon becoming APPROVED
      expect(driverRepo.getStatusCallCount, 1);
    });
  });
}
