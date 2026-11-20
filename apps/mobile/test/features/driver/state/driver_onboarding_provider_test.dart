import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/app/state/app_mode_provider.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/driver/models/driver_onboarding_request.dart';
import 'package:lastmile_mobile/features/driver/state/driver_onboarding_provider.dart';

import '../../../helpers/test_fakes.dart';

void main() {
  group('DriverOnboardingProvider', () {
    const testRequest = DriverOnboardingRequest(
      licenseNumber: 'GJ-01-2023-0012345',
      vehicle: VehicleDetails(
        registrationNumber: 'GJ-01-AA-1234',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Mahindra Treo',
      ),
    );

    const passengerUser = AuthUser(
      id: 'passenger-user-id',
      email: 'student@pdeu.ac.in',
      fullName: 'PDEU Student',
      role: 'PASSENGER',
      roles: ['PASSENGER'],
    );

    late FakeDriverRepository fakeDriverRepo;
    late FakeAuthRepository fakeAuthRepo;
    late AuthProvider authProvider;
    late AppModeProvider appModeProvider;
    late DriverOnboardingProvider provider;

    setUp(() async {
      fakeDriverRepo = FakeDriverRepository();
      fakeAuthRepo = FakeAuthRepository(currentUser: passengerUser);
      final tokenStore = AuthTokenStore();
      tokenStore.setToken(accessToken: 'mock-access-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'mock-refresh-token',
      });

      authProvider = AuthProvider(
        authRepository: fakeAuthRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );
      await authProvider.restoreSession();

      appModeProvider = AppModeProvider(initialMode: AppMode.passenger);
      provider = DriverOnboardingProvider(driverRepository: fakeDriverRepo);
    });

    test('successful onboarding submits, refreshes profile, and switches to driver mode', () async {
      // Setup backend GET /users/me response to return the updated user with DRIVER role and PENDING status
      fakeAuthRepo.currentUser = const AuthUser(
        id: 'passenger-user-id',
        email: 'student@pdeu.ac.in',
        fullName: 'PDEU Student',
        role: 'DRIVER',
        roles: ['PASSENGER', 'DRIVER'],
        driverVerificationStatus: 'PENDING',
        driverProfile: DriverProfile(
          id: 'dp-pending-123',
          verificationStatus: 'PENDING',
          operationalStatus: 'OFFLINE',
          isOnline: false,
        ),
      );

      final success = await provider.submitOnboarding(
        request: testRequest,
        authProvider: authProvider,
        appModeProvider: appModeProvider,
      );

      expect(success, isTrue);
      expect(provider.isSubmitting, isFalse);
      expect(provider.applicationSubmitted, isTrue);
      expect(provider.errorMessage, isNull);
      expect(provider.warningMessage, isNull);
      expect(fakeDriverRepo.onboardCallCount, 1);
      expect(fakeAuthRepo.currentUserCallCount, 2); // Initial restore + refreshProfile
      expect(authProvider.user?.isDriver, isTrue);
      expect(authProvider.user?.driverVerificationStatus, 'PENDING');
      expect(appModeProvider.mode, AppMode.driver);
    });

    test('profile refresh failure after successful onboarding sets warning and does not re-submit', () async {
      // Simulate profile refresh endpoint failing after submission succeeded
      fakeAuthRepo.shouldThrowOnUser = true;

      final success = await provider.submitOnboarding(
        request: testRequest,
        authProvider: authProvider,
        appModeProvider: appModeProvider,
      );

      expect(success, isTrue);
      expect(provider.applicationSubmitted, isTrue);
      expect(provider.profileRefreshPending, isTrue);
      expect(provider.warningMessage, contains('PENDING'));
      expect(provider.warningMessage, contains('do not need to re-submit'));
      expect(fakeDriverRepo.onboardCallCount, 1);
      // Local user driver profile was updated
      expect(authProvider.user?.isDriver, isTrue);
      expect(authProvider.user?.driverVerificationStatus, 'PENDING');
      expect(appModeProvider.mode, AppMode.driver);

      // Attempting to submit again does NOT call the backend endpoint again
      final secondAttempt = await provider.submitOnboarding(
        request: testRequest,
        authProvider: authProvider,
        appModeProvider: appModeProvider,
      );
      expect(secondAttempt, isTrue);
      expect(fakeDriverRepo.onboardCallCount, 1); // Still 1, never duplicated!
    });

    test('retryProfileSync successfully synchronizes profile and clears profileRefreshPending without calling onboardDriver', () async {
      // Start in profileRefreshPending state
      final pendingProvider = DriverOnboardingProvider(
        driverRepository: fakeDriverRepo,
      )..setProfileRefreshPending(true);
      expect(pendingProvider.profileRefreshPending, isTrue);

      // Now backend GET /users/me is operational and returns updated profile
      fakeAuthRepo.currentUser = const AuthUser(
        id: 'passenger-user-id',
        email: 'student@pdeu.ac.in',
        fullName: 'PDEU Student',
        role: 'DRIVER',
        roles: ['PASSENGER', 'DRIVER'],
        driverVerificationStatus: 'PENDING',
        driverProfile: DriverProfile(
          id: 'dp-pending-123',
          verificationStatus: 'PENDING',
          operationalStatus: 'OFFLINE',
          isOnline: false,
        ),
      );

      final initialOnboardCalls = fakeDriverRepo.onboardCallCount;

      final syncSuccess = await pendingProvider.retryProfileSync(
        authProvider: authProvider,
      );

      expect(syncSuccess, isTrue);
      expect(pendingProvider.profileRefreshPending, isFalse);
      expect(pendingProvider.warningMessage, isNull);
      expect(pendingProvider.errorMessage, isNull);
      // CRITICAL: onboardDriver was NOT called!
      expect(fakeDriverRepo.onboardCallCount, initialOnboardCalls);
      expect(authProvider.user?.driverVerificationStatus, 'PENDING');
    });

    test('retryProfileSync failure preserves profileRefreshPending and never calls onboardDriver', () async {
      final pendingProvider = DriverOnboardingProvider(
        driverRepository: fakeDriverRepo,
      )..setProfileRefreshPending(true);
      expect(pendingProvider.profileRefreshPending, isTrue);

      // Backend GET /users/me still fails
      fakeAuthRepo.shouldThrowOnUser = true;

      final initialOnboardCalls = fakeDriverRepo.onboardCallCount;

      final syncSuccess = await pendingProvider.retryProfileSync(
        authProvider: authProvider,
      );

      expect(syncSuccess, isFalse);
      // Preserved pending state for another attempt
      expect(pendingProvider.profileRefreshPending, isTrue);
      expect(pendingProvider.warningMessage, contains('synchronization failed'));
      // CRITICAL: onboardDriver was NOT called!
      expect(fakeDriverRepo.onboardCallCount, initialOnboardCalls);
    });

    test('submission failure on 409 Conflict surfaces message and does not switch mode', () async {
      fakeDriverRepo.shouldThrow = true;

      final success = await provider.submitOnboarding(
        request: testRequest,
        authProvider: authProvider,
        appModeProvider: appModeProvider,
      );

      expect(success, isFalse);
      expect(provider.applicationSubmitted, isFalse);
      expect(provider.errorMessage, contains('Driver profile already registered'));
      expect(appModeProvider.mode, AppMode.passenger); // Remains passenger
    });

    test('network timeout surfaces user-friendly network message', () async {
      fakeDriverRepo.exceptionToThrow = const ApiException(
        errorCode: 'REQUEST_TIMEOUT',
        message: 'The request timed out.',
      );

      final success = await provider.submitOnboarding(
        request: testRequest,
        authProvider: authProvider,
        appModeProvider: appModeProvider,
      );

      expect(success, isFalse);
      expect(provider.applicationSubmitted, isFalse);
      expect(provider.errorMessage, contains('timed out'));
      expect(appModeProvider.mode, AppMode.passenger);
    });
  });
}
