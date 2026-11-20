import 'package:google_sign_in/google_sign_in.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/data/auth_repository.dart';
import 'package:lastmile_mobile/features/auth/data/google_sign_in_service.dart';
import 'package:lastmile_mobile/features/auth/models/auth_session.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/driver/data/driver_repository.dart';
import 'package:lastmile_mobile/features/driver/models/driver_onboarding_request.dart';

/// Test double for [GoogleSignInAccount].
class FakeGoogleSignInAccount implements GoogleSignInAccount {
  FakeGoogleSignInAccount({this.idToken = 'fake-google-id-token'});

  final String idToken;

  @override
  String get email => 'test@pdeu.ac.in';

  @override
  String get id => 'google-user-123';

  @override
  String? get displayName => 'Test User';

  @override
  String? get photoUrl => null;

  @override
  GoogleSignInAuthentication get authentication =>
      GoogleSignInAuthentication(idToken: idToken);

  @override
  GoogleSignInAuthorizationClient get authorizationClient =>
      throw UnimplementedError();
}

/// Test double for [GoogleSignInAdapter].
class FakeGoogleSignInAdapter implements GoogleSignInAdapter {
  FakeGoogleSignInAdapter({
    this.shouldFailInit = false,
    this.shouldCancel = false,
    this.shouldThrowOnAuth = false,
    this.idToken = 'fake-google-id-token',
  });

  bool shouldFailInit;
  bool shouldCancel;
  bool shouldThrowOnAuth;
  String idToken;

  int initializeCount = 0;
  int authenticateCount = 0;
  int signOutCount = 0;
  int disconnectCount = 0;

  @override
  Future<void> initialize({
    String? clientId,
    String? serverClientId,
  }) async {
    initializeCount++;
    if (shouldFailInit) {
      throw Exception('Google Sign-In SDK initialization failed (-1001)');
    }
  }

  @override
  Future<GoogleSignInAccount> authenticate() async {
    authenticateCount++;
    if (shouldCancel) {
      throw GoogleSignInException(
        code: GoogleSignInExceptionCode.canceled,
        description: 'Sign in canceled by user',
      );
    }
    if (shouldThrowOnAuth) {
      throw Exception('Authentication failed');
    }
    return FakeGoogleSignInAccount(idToken: idToken);
  }

  @override
  Future<void> signOut() async {
    signOutCount++;
  }

  @override
  Future<void> disconnect() async {
    disconnectCount++;
  }
}

/// Test double for [GoogleSignInService].
class FakeGoogleSignInService implements GoogleSignInService {
  FakeGoogleSignInService({
    this.fakeIdToken = 'fake-valid-google-id-token',
    this.shouldCancel = false,
    this.shouldThrow = false,
    this.shouldFailInit = false,
  });

  String? fakeIdToken;
  bool shouldCancel;
  bool shouldThrow;
  bool shouldFailInit;
  bool signedOut = false;
  bool disconnected = false;
  int authenticateCallCount = 0;

  @override
  Future<String?> signIn() async {
    if (shouldFailInit) {
      throw const ApiException(
        errorCode: 'GOOGLE_INIT_FAILED',
        message:
            'Google Sign-In initialization failed. Please restart the app.',
      );
    }
    authenticateCallCount++;
    if (shouldThrow) {
      throw Exception('Google sign-in service failure');
    }
    if (shouldCancel) {
      return null;
    }
    return fakeIdToken;
  }

  @override
  Future<void> signOut() async {
    signedOut = true;
  }

  @override
  Future<void> disconnect() async {
    disconnected = true;
  }
}

/// Test double for [AuthRepository].
class FakeAuthRepository implements AuthRepository {
  FakeAuthRepository({
    this.currentUser,
    this.authSession,
    this.refreshResult,
    this.shouldThrowOnGoogle = false,
    this.shouldThrowOnRefresh = false,
    this.shouldThrowOnUser = false,
    this.refreshException,
    this.userException,
    this.onRefreshSession,
  });

  AuthUser? currentUser;
  AuthSession? authSession;
  RefreshSessionResult? refreshResult;
  bool shouldThrowOnGoogle;
  bool shouldThrowOnRefresh;
  bool shouldThrowOnUser;
  Exception? refreshException;
  Exception? userException;
  Future<void> Function()? onRefreshSession;
  bool logoutCalled = false;
  int refreshCallCount = 0;
  int currentUserCallCount = 0;

  @override
  Future<AuthSession> authenticateWithGoogle({
    required String idToken,
    String? deviceFingerprint,
  }) async {
    if (shouldThrowOnGoogle) {
      throw Exception('Google backend auth rejected');
    }
    return authSession ??
        AuthSession(
          user: currentUser ??
              const AuthUser(
                id: 'test-user-id',
                email: 'test@pdeu.ac.in',
                fullName: 'Test User',
                role: 'PASSENGER',
                roles: ['PASSENGER'],
              ),
          accessToken: 'mock-access-token',
          refreshToken: 'mock-refresh-token',
          expiresIn: 900,
        );
  }

  @override
  Future<RefreshSessionResult> refreshSession({
    required String refreshToken,
    String? deviceFingerprint,
  }) async {
    refreshCallCount++;
    if (onRefreshSession != null) {
      await onRefreshSession!();
    }
    if (refreshException != null) {
      throw refreshException!;
    }
    if (shouldThrowOnRefresh) {
      throw Exception('Refresh token expired or invalid');
    }
    return refreshResult ??
        const RefreshSessionResult(
          accessToken: 'rotated-access-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 900,
        );
  }

  @override
  Future<void> logout() async {
    logoutCalled = true;
  }

  @override
  Future<AuthUser> getCurrentUser() async {
    currentUserCallCount++;
    if (userException != null) {
      throw userException!;
    }
    if (shouldThrowOnUser) {
      throw Exception('User profile not found');
    }
    return currentUser ??
        const AuthUser(
          id: 'test-user-id',
          email: 'test@pdeu.ac.in',
          fullName: 'Test User',
          role: 'PASSENGER',
          roles: ['PASSENGER'],
        );
  }
}

/// Test double for [DriverRepository].
class FakeDriverRepository implements DriverRepository {
  FakeDriverRepository({
    this.response,
    this.shouldThrow = false,
    this.exceptionToThrow,
  });

  DriverOnboardingResponse? response;
  bool shouldThrow;
  Exception? exceptionToThrow;
  DriverOnboardingRequest? lastRequest;
  int onboardCallCount = 0;

  @override
  Future<DriverOnboardingResponse> onboardDriver(
    DriverOnboardingRequest request,
  ) async {
    onboardCallCount++;
    lastRequest = request;
    if (exceptionToThrow != null) {
      throw exceptionToThrow!;
    }
    if (shouldThrow) {
      throw const ApiException(
        statusCode: 409,
        errorCode: 'CONFLICT',
        message: 'Driver profile already registered for this user',
      );
    }
    return response ??
        DriverOnboardingResponse(
          driverProfile: DriverProfile(
            id: 'dp-fake-123',
            licenseNumber: request.licenseNumber,
            verificationStatus: 'PENDING',
            operationalStatus: 'OFFLINE',
            isOnline: false,
          ),
          vehicle: {
            'registrationNumber': request.vehicle.registrationNumber,
            'vehicleType': request.vehicle.vehicleType,
            'passengerCapacity': request.vehicle.passengerCapacity,
            'makeModel': request.vehicle.makeModel,
          },
          message: 'Driver onboarding application submitted successfully',
        );
  }
}

/// Test double for [SecureTokenStorage] that can simulate read, write or delete failures.
class FailingSecureTokenStorage extends SecureTokenStorage {
  FailingSecureTokenStorage({
    this.failOnSave = true,
    this.failOnDelete = false,
    this.failOnRead = false,
    Map<String, String>? initialData,
  }) : super.inMemory(initialData);

  final bool failOnSave;
  final bool failOnDelete;
  bool failOnRead;

  @override
  Future<String?> getRefreshToken() async {
    if (failOnRead) {
      throw Exception('Secure storage read operation failed (-25300 Keychain lock)');
    }
    return super.getRefreshToken();
  }

  @override
  Future<void> saveRefreshToken(String token) async {
    if (failOnSave) {
      throw Exception('Secure storage write operation failed');
    }
    return super.saveRefreshToken(token);
  }

  @override
  Future<void> deleteRefreshToken() async {
    if (failOnDelete) {
      throw Exception('Secure storage delete operation failed');
    }
    return super.deleteRefreshToken();
  }
}

/// Helper that constructs an authenticated [AuthProvider] with a given [AuthUser].
AuthProvider createTestAuthProvider({
  AuthUser? user,
  AuthStatus status = AuthStatus.authenticated,
  AuthRepository? authRepository,
  GoogleSignInService? googleSignInService,
  AuthTokenStore? tokenStore,
  SecureTokenStorage? secureStorage,
}) {
  final effectiveTokenStore = tokenStore ?? AuthTokenStore();
  final effectiveSecureStorage =
      secureStorage ?? SecureTokenStorage.inMemory();
  final effectiveRepo = authRepository ??
      FakeAuthRepository(
        currentUser: user ??
            const AuthUser(
              id: 'test-user-id',
              email: 'passenger@pdeu.ac.in',
              fullName: 'PDEU Passenger',
              role: 'PASSENGER',
              roles: ['PASSENGER', 'DRIVER'],
            ),
      );
  final effectiveGoogleService =
      googleSignInService ?? FakeGoogleSignInService();

  final provider = AuthProvider(
    authRepository: effectiveRepo,
    googleSignInService: effectiveGoogleService,
    tokenStore: effectiveTokenStore,
    secureStorage: effectiveSecureStorage,
  );

  return provider;
}
