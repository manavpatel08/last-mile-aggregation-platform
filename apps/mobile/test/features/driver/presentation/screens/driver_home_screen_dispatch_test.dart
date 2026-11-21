import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/app/state/app_mode_provider.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/driver/models/accept_offer_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_dispatch_offer.dart';
import 'package:lastmile_mobile/features/driver/models/driver_status_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_vehicle.dart';
import 'package:lastmile_mobile/features/driver/services/driver_location_tracker.dart';
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

  final sampleOffer = DriverDispatchOffer(
    offerId: 'off-real-123',
    dispatchAttemptId: 'att-123',
    rideGroupId: 'grp-real-123',
    groupVersion: 1,
    pickupPoint: const DriverPickupPoint(
      id: 'pnt-pdeu-gate-1',
      name: 'PDEU Gate 1 (Koba Highway)',
    ),
    passengerCount: 3,
    totalEstimatedFare: '48.00',
    totalDistanceMeters: 2400,
    totalDurationSec: 360,
    offeredAt: DateTime.now(),
    expiresAt: DateTime.now().add(const Duration(seconds: 20)),
    remainingSeconds: 20,
  );

  group('DriverHomeScreen Dispatch UI Integration Tests', () {
    testWidgets('approved driver sees DriverAvailabilityCard and interactive switch', (tester) async {
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

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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

      // Verify availability switch is enabled and online
      final switchFinder = find.byKey(const Key('driver_availability_switch'));
      expect(switchFinder, findsOneWidget);
      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.value, isTrue);
      expect(switchWidget.onChanged, isNotNull);

      // Verify Dispatch Offers Inbox is displayed
      expect(find.text('Dispatch Offers'), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_empty_card')), findsOneWidget);
      expect(find.text('No Pending Offers'), findsOneWidget);

      // Verify registered vehicles are still properly rendered below
      expect(find.text('Registered Vehicles'), findsOneWidget);
      expect(find.byKey(const Key('driver_vehicle_card_veh-dispatch-1')), findsOneWidget);
    });

    testWidgets('tapping availability switch calls PATCH /drivers/status and updates state', (tester) async {
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
        updateStatusResponse: const DriverStatusResponse(
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

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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

      // Confirms backend PATCH called with isOnline: false
      expect(driverRepo.updateStatusCallCount, 1);
      expect(driverRepo.lastUpdateStatusIsOnline, isFalse);

      // Confirms updated offline state
      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.value, isFalse);
    });

    testWidgets('tapping availability switch with conflict error displays error snackbar', (tester) async {
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
        shouldThrowOnUpdateStatus: true,
        updateStatusException: const ApiException(
          statusCode: 409,
          errorCode: 'CONFLICT',
          message: 'Cannot go offline while driver has an active trip',
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

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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

      // Error snackbar should be displayed
      expect(find.byKey(const Key('driver_availability_error_snackbar')), findsOneWidget);
      expect(find.text('Cannot go offline while driver has an active trip'), findsOneWidget);

      // Switch should remain online (un-toggled)
      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.value, isTrue);
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

      expect(find.text('Driver Verification: PENDING'), findsOneWidget);
      expect(find.byKey(const Key('driver_availability_card')), findsNothing);
      expect(find.byKey(const Key('driver_offers_disconnected_card')), findsNothing);
      expect(find.text('Dispatch Offers'), findsNothing);
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
      expect(driverRepo.getStatusCallCount, 0);
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

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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
    });

    testWidgets('authoritative response with isOnline=false confirms and displays Offline and allows going online', (tester) async {
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
        updateStatusResponse: const DriverStatusResponse(
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

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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

      // Availability card displays Offline (Inactive)
      final badgeFinder = find.byKey(const Key('driver_availability_status_badge'));
      expect(find.descendant(of: badgeFinder, matching: find.text('Offline (Inactive)')), findsOneWidget);

      // Switch is enabled with false value
      final switchFinder = find.byKey(const Key('driver_availability_switch'));
      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.value, isFalse);
      expect(switchWidget.onChanged, isNotNull);

      // Tap to go online
      await tester.tap(switchFinder);
      await tester.pumpAndSettle();

      expect(driverRepo.updateStatusCallCount, 1);
      expect(driverRepo.lastUpdateStatusIsOnline, isTrue);
    });

    testWidgets('approved online driver receives pending offers and displays them in inbox', (tester) async {
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
        offersResponse: [sampleOffer],
        vehiclesResponse: [sampleVehicle],
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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

      // Verify pending offer is displayed in inbox
      expect(find.byKey(const Key('driver_offers_count_badge')), findsOneWidget);
      expect(find.text('1 active'), findsOneWidget);
      expect(find.text('Offer #off-real-123 • Group #grp-real-123'), findsOneWidget);
      expect(find.text('PDEU Gate 1 (Koba Highway)'), findsOneWidget);
      expect(find.text('3 riders'), findsOneWidget);
      expect(find.text('₹48.00'), findsOneWidget);
      expect(find.byKey(const Key('dispatch_offer_accept_button_off-real-123')), findsOneWidget);
      expect(find.byKey(const Key('dispatch_offer_reject_button_off-real-123')), findsOneWidget);
    });

    testWidgets('accepting an offer invokes acceptOffer with Idempotency-Key and refreshes offers', (tester) async {
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
        offersResponse: [sampleOffer],
        acceptOfferResponse: const AcceptOfferResponse(
          assignmentId: 'asgn-real-123',
          tripId: 'trip-real-123',
          rideGroupId: 'grp-real-123',
          passengerCount: 3,
          totalEstimatedFare: '48.00',
          navigationRoute: NavigationRouteData(geometry: {}, stops: []),
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

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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

      // When accept succeeds, offer list is refreshed (now empty)
      driverRepo.offersResponse = const [];

      final acceptBtn = find.byKey(const Key('dispatch_offer_accept_button_off-real-123'));
      await tester.ensureVisible(acceptBtn);
      await tester.tap(acceptBtn);
      await tester.pumpAndSettle();

      expect(driverRepo.acceptOfferCallCount, 1);
      expect(driverRepo.lastAcceptedOfferId, 'off-real-123');
      expect(driverRepo.lastAcceptedIdempotencyKey, isNotNull);
      expect(driverRepo.lastAcceptedIdempotencyKey, isNotEmpty);

      // Verify success snackbar
      expect(find.byKey(const Key('driver_offer_accepted_snackbar')), findsOneWidget);
      expect(find.text('Offer accepted successfully!'), findsOneWidget);
    });

    testWidgets('ambiguous acceptance followed by empty pending offers displays unresolved retry card and tapping retry succeeds', (tester) async {
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
        offersResponse: [sampleOffer],
        shouldThrowOnAcceptOffer: true,
        acceptOfferException: const ApiException(
          statusCode: null,
          errorCode: 'NETWORK_UNAVAILABLE',
          message: 'Network connection lost.',
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

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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

      // Tap accept button
      final acceptBtn = find.byKey(const Key('dispatch_offer_accept_button_off-real-123'));
      await tester.ensureVisible(acceptBtn);

      // On the server, pending offers becomes empty after attempt
      driverRepo.offersResponse = const [];

      await tester.tap(acceptBtn);
      await tester.pumpAndSettle();

      expect(driverRepo.acceptOfferCallCount, 1);
      final firstKey = driverRepo.lastAcceptedIdempotencyKey;
      expect(firstKey, isNotNull);

      // Offer card disappeared from pending list, but unresolved retry card is displayed
      expect(find.byKey(const Key('driver_offers_unresolved_card')), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_retry_accept_button')), findsOneWidget);
      expect(find.text('Offer Acceptance Pending Confirmation'), findsOneWidget);

      // Now server connectivity recovers and retry returns authoritative 200 response
      driverRepo.shouldThrowOnAcceptOffer = false;
      driverRepo.acceptOfferException = null;
      driverRepo.acceptOfferResponse = const AcceptOfferResponse(
        assignmentId: 'asgn-real-123',
        tripId: 'trip-real-123',
        rideGroupId: 'grp-real-123',
        passengerCount: 3,
        totalEstimatedFare: '48.00',
        navigationRoute: NavigationRouteData(geometry: {}, stops: []),
      );
      driverRepo.statusResponse = const DriverStatusResponse(
        id: 'dp-approved-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'RESERVED',
        isOnline: true,
        vehiclesCount: 1,
      );

      // Tap Retry Acceptance button on unresolved card
      final retryBtn = find.byKey(const Key('driver_offers_retry_accept_button'));
      await tester.tap(retryBtn);
      await tester.pumpAndSettle();

      // Confirms retry occurred with identical offer ID and idempotency key
      expect(driverRepo.acceptOfferCallCount, 2);
      expect(driverRepo.lastAcceptedOfferId, 'off-real-123');
      expect(driverRepo.lastAcceptedIdempotencyKey, equals(firstKey));

      // Unresolved card is now resolved and cleared
      expect(find.byKey(const Key('driver_offers_unresolved_card')), findsNothing);
      expect(find.byKey(const Key('driver_offer_accepted_snackbar')), findsOneWidget);
      expect(find.text('Offer accepted successfully!'), findsOneWidget);
    });

    testWidgets('rejecting an offer invokes rejectOffer with Idempotency-Key and removes offer', (tester) async {
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
        offersResponse: [sampleOffer],
        vehiclesResponse: [sampleVehicle],
      );

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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

      final rejectBtn = find.byKey(const Key('dispatch_offer_reject_button_off-real-123'));
      await tester.ensureVisible(rejectBtn);
      await tester.tap(rejectBtn);
      await tester.pumpAndSettle();

      expect(driverRepo.rejectOfferCallCount, 1);
      expect(driverRepo.lastRejectedOfferId, 'off-real-123');
      expect(driverRepo.lastRejectedIdempotencyKey, isNotNull);

      // Rejected offer is removed from the inbox, falling back to empty state
      expect(find.text('Offer #off-real-123 • Group #grp-real-123'), findsNothing);
      expect(find.text('No Pending Offers'), findsOneWidget);
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

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: const NoOpDriverLocationTracker(),
      );
      addTearDown(homeProvider.dispose);

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
      expect(homeProvider.offers, isEmpty);
    });

    testWidgets('dual-role driver switching mode stops GPS tracking without altering server online status', (tester) async {
      const dualRoleApprovedDriver = AuthUser(
        id: 'driver-dual-approved-1',
        email: 'dual.driver@pdeu.ac.in',
        fullName: 'Dual Role Driver',
        role: 'PASSENGER',
        roles: ['PASSENGER', 'DRIVER'],
        driverVerificationStatus: 'APPROVED',
        driverProfile: DriverProfile(
          id: 'dp-dual-approved-1',
          licenseNumber: 'GJ-01-2023-0088888',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
        ),
      );

      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'existing-refresh-token',
      });
      final authRepo = FakeAuthRepository(currentUser: dualRoleApprovedDriver);
      final driverRepo = FakeDriverRepository(
        statusResponse: const DriverStatusResponse(
          id: 'dp-dual-approved-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
          vehiclesCount: 1,
        ),
        vehiclesResponse: [sampleVehicle],
      );
      final fakeTracker = FakeDriverLocationTracker();

      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      final homeProvider = DriverHomeProvider(
        driverRepository: driverRepo,
        locationTracker: fakeTracker,
      );
      addTearDown(homeProvider.dispose);

      await tester.pumpWidget(
        LastMileApp(
          config: testConfig,
          authProvider: authProvider,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: authRepo,
          driverRepository: driverRepo,
          driverHomeProvider: homeProvider,
          appModeProvider: AppModeProvider(initialMode: AppMode.driver),
        ),
      );
      await tester.pumpAndSettle();

      // Driver home loaded and online GPS tracking started
      expect(homeProvider.isOnline, isTrue);
      expect(fakeTracker.isTracking, isTrue);

      // Tap Switch Mode button to exit Driver Home
      final switchModeFinder = find.byKey(const Key('switch_mode_button'));
      expect(switchModeFinder, findsOneWidget);
      await tester.tap(switchModeFinder);
      await tester.pumpAndSettle();

      // GPS tracking was stopped on exit
      expect(fakeTracker.isTracking, isFalse);
      expect(fakeTracker.stopCallCount, greaterThanOrEqualTo(1));

      // Server-side online duty status remains unchanged (isOnline: true)
      expect(driverRepo.updateStatusCallCount, 0); // No PATCH /status was sent
      expect(homeProvider.isOnline, isTrue);
    });
  });
}
