import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_session.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';

import '../../../helpers/test_fakes.dart';

void main() {
  group('AuthProvider', () {
    const testUser = AuthUser(
      id: 'test-user-id',
      email: 'student@pdeu.ac.in',
      fullName: 'Student Name',
      role: 'PASSENGER',
      roles: ['PASSENGER'],
    );

    test('initial state has initial status and no user', () {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory();
      final repo = FakeAuthRepository();
      final googleService = FakeGoogleSignInService();

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      expect(provider.status, AuthStatus.initial);
      expect(provider.isInitial, isTrue);
      expect(provider.isAuthenticated, isFalse);
      expect(provider.user, isNull);
      expect(provider.errorMessage, isNull);
    });

    test('restoreSession transitions to unauthenticated when no token is stored', () async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory();
      final repo = FakeAuthRepository();
      final googleService = FakeGoogleSignInService();

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      await provider.restoreSession();

      expect(provider.status, AuthStatus.unauthenticated);
      expect(provider.isAuthenticated, isFalse);
      expect(provider.user, isNull);
    });

    test('restoreSession restores session, sets access token and fetches user profile', () async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'stored-refresh-token',
      });
      final repo = FakeAuthRepository(
        currentUser: testUser,
        refreshResult: const RefreshSessionResult(
          accessToken: 'new-access-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 900,
        ),
      );
      final googleService = FakeGoogleSignInService();

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      await provider.restoreSession();

      expect(provider.status, AuthStatus.authenticated);
      expect(provider.isAuthenticated, isTrue);
      expect(provider.user?.email, 'student@pdeu.ac.in');
      expect(tokenStore.accessToken, 'new-access-token');
      expect(await secureStorage.getRefreshToken(), 'rotated-refresh-token');
    });

    test('restoreSession clears tokens and sets unauthenticated when refresh fails', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'old-access', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'invalid-token',
      });
      final repo = FakeAuthRepository(shouldThrowOnRefresh: true);
      final googleService = FakeGoogleSignInService();

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      await provider.restoreSession();

      expect(provider.status, AuthStatus.unauthenticated);
      expect(provider.isAuthenticated, isFalse);
      expect(tokenStore.accessToken, isNull);
      expect(await secureStorage.getRefreshToken(), isNull);
    });

    test('signInWithGoogle completes authentication flow successfully', () async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory();
      final repo = FakeAuthRepository(
        authSession: const AuthSession(
          user: testUser,
          accessToken: 'jwt-google-access',
          refreshToken: 'uuid-google-refresh',
          expiresIn: 900,
        ),
      );
      final googleService = FakeGoogleSignInService(
        fakeIdToken: 'google-oauth-token',
      );

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      final result = await provider.signInWithGoogle();

      expect(result, isTrue);
      expect(provider.status, AuthStatus.authenticated);
      expect(provider.isAuthenticated, isTrue);
      expect(provider.user?.email, 'student@pdeu.ac.in');
      expect(tokenStore.accessToken, 'jwt-google-access');
      expect(await secureStorage.getRefreshToken(), 'uuid-google-refresh');
    });

    test('signInWithGoogle does not change state when user cancels dialog', () async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory();
      final repo = FakeAuthRepository();
      final googleService = FakeGoogleSignInService(shouldCancel: true);

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      final result = await provider.signInWithGoogle();

      expect(result, isFalse);
      expect(provider.status, AuthStatus.initial);
      expect(provider.isAuthenticated, isFalse);
      expect(provider.errorMessage, isNull);
    });

    test('signInWithGoogle handles error gracefully and sets error message', () async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory();
      final repo = FakeAuthRepository(shouldThrowOnGoogle: true);
      final googleService = FakeGoogleSignInService();

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      final result = await provider.signInWithGoogle();

      expect(result, isFalse);
      expect(provider.status, AuthStatus.unauthenticated);
      expect(provider.errorMessage, isNotNull);
    });

    test('logout terminates session and clears local credentials', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'active-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'active-refresh',
      });
      final repo = FakeAuthRepository(currentUser: testUser);
      final googleService = FakeGoogleSignInService();

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      // Authenticate
      await provider.restoreSession();
      expect(provider.isAuthenticated, isTrue);

      // Logout
      await provider.logout();

      expect(provider.isAuthenticated, isFalse);
      expect(provider.status, AuthStatus.unauthenticated);
      expect(provider.user, isNull);
      expect(tokenStore.accessToken, isNull);
      expect(await secureStorage.getRefreshToken(), isNull);
      expect(repo.logoutCalled, isTrue);
      expect(googleService.signedOut, isTrue);
    });

    test('onSessionExpired marks unauthenticated with error message', () {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'active-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory();
      final repo = FakeAuthRepository();
      final googleService = FakeGoogleSignInService();

      final provider = AuthProvider(
        authRepository: repo,
        googleSignInService: googleService,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
      );

      provider.onSessionExpired();

      expect(provider.status, AuthStatus.unauthenticated);
      expect(provider.isAuthenticated, isFalse);
      expect(provider.errorMessage, contains('expired'));
      expect(tokenStore.accessToken, isNull);
    });
  });
}
