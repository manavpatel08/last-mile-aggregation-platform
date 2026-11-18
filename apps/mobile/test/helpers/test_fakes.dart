import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/data/auth_repository.dart';
import 'package:lastmile_mobile/features/auth/data/google_sign_in_service.dart';
import 'package:lastmile_mobile/features/auth/models/auth_session.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';

/// Test double for [GoogleSignInService].
class FakeGoogleSignInService implements GoogleSignInService {
  FakeGoogleSignInService({
    this.fakeIdToken = 'fake-valid-google-id-token',
    this.shouldCancel = false,
    this.shouldThrow = false,
  });

  String? fakeIdToken;
  bool shouldCancel;
  bool shouldThrow;
  bool signedOut = false;
  bool disconnected = false;

  @override
  Future<String?> signIn() async {
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
  });

  AuthUser? currentUser;
  AuthSession? authSession;
  RefreshSessionResult? refreshResult;
  bool shouldThrowOnGoogle;
  bool shouldThrowOnRefresh;
  bool shouldThrowOnUser;
  bool logoutCalled = false;
  int refreshCallCount = 0;

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
