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

import '../../../../helpers/test_fakes.dart';

void main() {
  const testConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const approvedDriverUser = AuthUser(
    id: 'driver-dispatch-approved-1',
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
    id: 'driver-dispatch-pending-1',
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
    id: 'driver-dispatch-rejected-1',
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
    id: 'driver-dispatch-suspended-1',
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

  const sampleVehicle = DriverVehicle(
    id: 'veh-dispatch-1',
    driverProfileId: 'dp-approved-1',
    registrationNumber: 'GJ-01-AB-1234',
    vehicleType: 'E_RICKSHAW',
    passengerCapacity: 4,
    makeModel: 'Mahindra Treo',
    isActive: true,
  );

  group('DriverHomeScreen Dispatch UI Integration Tests', () {
    testWidgets('approved driver sees DriverAvailabilityCard and Disconnected DispatchOffersInbox', (tester) async {
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

      // Verify Driver Availability Card is displayed
      expect(find.byKey(const Key('driver_availability_card')), findsOneWidget);
      expect(find.text('Driver Availability'), findsOneWidget);
      expect(find.byKey(const Key('driver_availability_explanation')), findsOneWidget);

      // Verify availability switch is disabled
      final switchFinder = find.byKey(const Key('driver_availability_switch'));
      expect(switchFinder, findsOneWidget);
      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.onChanged, isNull,
          reason: 'Availability toggle must be disabled pending backend dispatch integration.');

      // Verify Dispatch Offers Inbox is displayed in disconnected state
      expect(find.text('Dispatch Offers'), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_disconnected_card')), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_disconnected_badge')), findsOneWidget);
      expect(find.text('Not Connected'), findsOneWidget);
      expect(find.text('Dispatch Offers Not Connected'), findsOneWidget);

      // Verify no fabricated counts, fake offers, or accept/decline buttons exist
      expect(find.textContaining('active'), findsNothing);
      expect(find.textContaining('Accept'), findsNothing);
      expect(find.textContaining('Decline'), findsNothing);

      // Verify registered vehicles are still properly rendered below
      expect(find.text('Registered Vehicles'), findsOneWidget);
      expect(find.byKey(const Key('driver_vehicle_card_veh-dispatch-1')), findsOneWidget);
    });

    testWidgets('unapproved driver (PENDING) does NOT see availability card or dispatch offers inbox', (tester) async {
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

      // Verification warning banner should be visible
      expect(find.text('Driver Verification: PENDING'), findsOneWidget);

      // Availability and Dispatch offers must NOT be visible for PENDING drivers
      expect(find.byKey(const Key('driver_availability_card')), findsNothing);
      expect(find.byKey(const Key('driver_offers_disconnected_card')), findsNothing);
      expect(find.text('Dispatch Offers'), findsNothing);

      // Status endpoint must NOT have been called
      expect(driverRepo.getStatusCallCount, 0);
    });

    testWidgets('unapproved driver (REJECTED) does NOT see availability card or dispatch offers inbox', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: rejectedDriverUser);
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

      expect(find.text('Driver Application: REJECTED'), findsOneWidget);
      expect(find.byKey(const Key('driver_availability_card')), findsNothing);
      expect(find.byKey(const Key('driver_offers_disconnected_card')), findsNothing);
      expect(driverRepo.getStatusCallCount, 0);
    });

    testWidgets('unapproved driver (SUSPENDED) does NOT see availability card or dispatch offers inbox', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: suspendedDriverUser);
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

      expect(find.text('Driver Account: SUSPENDED'), findsOneWidget);
      expect(find.byKey(const Key('driver_availability_card')), findsNothing);
      expect(find.byKey(const Key('driver_offers_disconnected_card')), findsNothing);
      expect(driverRepo.getStatusCallCount, 0);
    });

    testWidgets('tapping disabled availability switch does not toggle state or call backend', (tester) async {
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

      final switchFinder = find.byKey(const Key('driver_availability_switch'));
      await tester.tap(switchFinder);
      await tester.pumpAndSettle();

      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.onChanged, isNull);
      // Status call count should still be 1 (only the initial loadDashboard)
      expect(driverRepo.getStatusCallCount, 1);
    });

    testWidgets('logout clears driver home state including availability and offers', (tester) async {
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

      expect(homeProvider.hasLoaded, isTrue);

      // Tap logout button
      await tester.tap(find.byKey(const Key('logout_button')));
      await tester.pumpAndSettle();

      // Home provider state must be reset
      expect(homeProvider.hasLoaded, isFalse);
      expect(homeProvider.status, isNull);
      expect(homeProvider.vehicles, isEmpty);
      expect(homeProvider.currentUserId, isNull);
    });

    testWidgets('initial status-fetch failure displays Status unavailable on dashboard and availability card', (tester) async {
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
          message: 'Status endpoint failed',
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

      // Operational status and Server connection display Status unavailable
      expect(find.byKey(const Key('driver_operational_status_unavailable')), findsOneWidget);
      expect(find.byKey(const Key('driver_online_state_unavailable')), findsOneWidget);

      // Driver Availability badge displays Status unavailable
      final badgeFinder = find.byKey(const Key('driver_availability_status_badge'));
      expect(badgeFinder, findsOneWidget);
      expect(find.descendant(of: badgeFinder, matching: find.text('Status unavailable')), findsOneWidget);

      // Switch remains disabled
      final switchFinder = find.byKey(const Key('driver_availability_switch'));
      expect(switchFinder, findsOneWidget);
      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.value, isFalse);
      expect(switchWidget.onChanged, isNull);

      // Verify neither Offline nor Online is falsely claimed
      expect(find.text('Offline'), findsNothing);
      expect(find.text('Online'), findsNothing);
    });

    testWidgets('authoritative response with isOnline=false confirms and displays Offline', (tester) async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: approvedDriverUser);
      final driverRepo = FakeDriverRepository(
        statusResponse: const DriverStatusResponse(
          id: 'dp-approved-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'OFFLINE',
          isOnline: false,
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

      // Confirmed offline from server
      expect(find.byKey(const Key('driver_online_state')), findsOneWidget);
      expect(find.text('Offline'), findsOneWidget);
      expect(find.byKey(const Key('driver_operational_status')), findsOneWidget);
      expect(find.text('OFFLINE'), findsOneWidget);

      // Availability card displays Offline (Disabled)
      final badgeFinder = find.byKey(const Key('driver_availability_status_badge'));
      expect(find.descendant(of: badgeFinder, matching: find.text('Offline (Disabled)')), findsOneWidget);

      // Switch is disabled with false value
      final switchFinder = find.byKey(const Key('driver_availability_switch'));
      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.value, isFalse);
      expect(switchWidget.onChanged, isNull);
    });
  });
}
