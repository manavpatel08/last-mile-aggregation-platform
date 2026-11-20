import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
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

    test(
      'Session restoration with no stored refresh token',
      () async {
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
      },
    );

    test(
      'Session restoration with a valid refresh token',
      () async {
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
      },
    );

    test(
      'Session restoration during a network timeout preserves the refresh token',
      () async {
        final tokenStore = AuthTokenStore()
          ..setToken(accessToken: 'old-access', expiresInSeconds: 900);
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-persisted-refresh-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            errorCode: 'REQUEST_TIMEOUT',
            message: 'The request timed out. Please try again.',
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

        // Must enter retryable error state without deleting the refresh token!
        expect(provider.status, AuthStatus.error);
        expect(provider.isAuthenticated, isFalse);
        expect(provider.errorMessage, contains('timed out'));
        expect(
          await secureStorage.getRefreshToken(),
          'valid-persisted-refresh-token',
        );
      },
    );

    test(
      'Session restoration during a temporary 5xx preserves the refresh token',
      () async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-persisted-refresh-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            statusCode: 502,
            errorCode: 'HTTP_ERROR',
            message: 'Bad gateway',
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

        // Temporary 5xx must preserve the refresh token
        expect(provider.status, AuthStatus.error);
        expect(provider.isAuthenticated, isFalse);
        expect(
          await secureStorage.getRefreshToken(),
          'valid-persisted-refresh-token',
        );
      },
    );

    test(
      'Definitively invalid refresh token clears credentials',
      () async {
        final tokenStore = AuthTokenStore()
          ..setToken(accessToken: 'old-access', expiresInSeconds: 900);
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'invalid-revoked-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            statusCode: 401,
            errorCode: 'UNAUTHORIZED',
            message: 'Invalid refresh token',
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

        expect(provider.status, AuthStatus.unauthenticated);
        expect(provider.isAuthenticated, isFalse);
        expect(tokenStore.accessToken, isNull);
        expect(await secureStorage.getRefreshToken(), isNull);
        expect(provider.errorMessage, contains('expired'));
      },
    );

    test(
      'Concurrent restore calls share one operation',
      () async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'stored-refresh-token',
        });
        final repo = FakeAuthRepository(
          currentUser: testUser,
          refreshResult: const RefreshSessionResult(
            accessToken: 'concurrent-access-token',
            refreshToken: 'concurrent-rotated-token',
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

        // Call restoreSession 3 times simultaneously
        final futures = [
          provider.restoreSession(),
          provider.restoreSession(),
          provider.restoreSession(),
        ];

        await Future.wait(futures);

        // Exactly ONE refresh call executed across all concurrent invocations
        expect(repo.refreshCallCount, 1);
        expect(repo.currentUserCallCount, 1);
        expect(provider.isAuthenticated, isTrue);
        expect(tokenStore.accessToken, 'concurrent-access-token');
      },
    );

    test(
      'Secure-storage write failure does not leave a partially active session',
      () async {
        final tokenStore = AuthTokenStore();
        final failingStorage = FailingSecureTokenStorage(
          failOnSave: true,
          initialData: {
            SecureTokenStorage.refreshTokenKey: 'stored-refresh-token',
          },
        );
        final repo = FakeAuthRepository(
          currentUser: testUser,
          refreshResult: const RefreshSessionResult(
            accessToken: 'unsavable-access-token',
            refreshToken: 'unsavable-refresh-token',
            expiresIn: 900,
          ),
        );
        final googleService = FakeGoogleSignInService();

        final provider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: failingStorage,
        );

        await provider.restoreSession();

        // Must not leave an active access token or authenticated state
        expect(provider.isAuthenticated, isFalse);
        expect(provider.status, AuthStatus.unauthenticated);
        expect(tokenStore.accessToken, isNull);
      },
    );

    test(
      'Secure-storage read failure preserves refresh token, skips backend refresh, sets error state, and allows retry',
      () async {
        final tokenStore = AuthTokenStore()
          ..setToken(accessToken: 'stale-access-token', expiresInSeconds: 900);
        final failingStorage = FailingSecureTokenStorage(
          failOnRead: true,
          failOnSave: false,
          initialData: {
            SecureTokenStorage.refreshTokenKey: 'stored-precious-refresh-token',
          },
        );
        final repo = FakeAuthRepository(currentUser: testUser);
        final googleService = FakeGoogleSignInService();

        final provider = AuthProvider(
          authRepository: repo,
          googleSignInService: googleService,
          tokenStore: tokenStore,
          secureStorage: failingStorage,
        );

        // First attempt: Storage read throws exception
        await provider.restoreSession();

        // 1. Catches read failure explicitly and transitions to error state
        expect(provider.status, AuthStatus.error);
        expect(provider.isAuthenticated, isFalse);
        expect(provider.user, isNull);
        expect(provider.errorMessage, contains('secure storage'));

        // 2. Stale in-memory token is cleared
        expect(tokenStore.accessToken, isNull);

        // 3. Backend refresh is NEVER called when token could not be read
        expect(repo.refreshCallCount, 0);

        // 4. Stored refresh token is PRESERVED (not deleted or overwritten)
        failingStorage.failOnRead = false;
        expect(
          await failingStorage.getRefreshToken(),
          'stored-precious-refresh-token',
        );

        // 5. Subsequent retry after storage issue is resolved restores session successfully!
        await provider.restoreSession();
        expect(provider.status, AuthStatus.authenticated);
        expect(provider.isAuthenticated, isTrue);
        expect(provider.user?.email, 'student@pdeu.ac.in');
        expect(repo.refreshCallCount, 1);
      },
    );

    test(
      'Profile retrieval failure during restore clears in-memory access token, preserves rotated refresh token, and allows subsequent retry',
      () async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'stored-refresh-token',
        });
        final repo = FakeAuthRepository(
          refreshResult: const RefreshSessionResult(
            accessToken: 'brand-new-rotated-access-token',
            refreshToken: 'brand-new-rotated-refresh-token',
            expiresIn: 900,
          ),
          userException: const ApiException(
            errorCode: 'NETWORK_UNAVAILABLE',
            message: 'Unable to reach the server. Check your network connection.',
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

        // Must NOT mark user authenticated!
        expect(provider.isAuthenticated, isFalse);
        expect(provider.user, isNull);
        expect(provider.status, AuthStatus.error);

        // High Priority 2: In-memory access token MUST be cleared so stale token cannot be used!
        expect(tokenStore.accessToken, isNull);

        // Rotated refresh token MUST remain safely persisted in secure storage
        expect(
          await secureStorage.getRefreshToken(),
          'brand-new-rotated-refresh-token',
        );

        // Subsequent restoration retry after network is back succeeds without signing in again!
        repo.userException = null;
        repo.currentUser = testUser;
        repo.refreshResult = const RefreshSessionResult(
          accessToken: 'retried-access-token',
          refreshToken: 'retried-refresh-token',
          expiresIn: 900,
        );

        await provider.restoreSession();
        expect(provider.status, AuthStatus.authenticated);
        expect(provider.isAuthenticated, isTrue);
        expect(tokenStore.accessToken, 'retried-access-token');
        expect(await secureStorage.getRefreshToken(), 'retried-refresh-token');
      },
    );

    test(
      '403 Forbidden from /users/me during restore preserves the refresh token and sets error state',
      () async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'stored-refresh-token',
        });
        final repo = FakeAuthRepository(
          refreshResult: const RefreshSessionResult(
            accessToken: 'active-access-token',
            refreshToken: 'new-rotated-token',
            expiresIn: 900,
          ),
          userException: const ApiException(
            statusCode: 403,
            errorCode: 'FORBIDDEN',
            message: 'User account lacks required permission.',
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

        // Must NOT mark user authenticated!
        expect(provider.isAuthenticated, isFalse);
        expect(provider.user, isNull);
        expect(provider.status, AuthStatus.error);
        expect(provider.errorMessage, contains('permission'));
        // Stored refresh token must be preserved! HTTP 403 must never clear refresh credentials.
        expect(await secureStorage.getRefreshToken(), 'new-rotated-token');
      },
    );

    test(
      '403 from refresh endpoint preserves the refresh token and sets error state',
      () async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'valid-refresh-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            statusCode: 403,
            errorCode: 'FORBIDDEN',
            message: 'Account suspended or forbidden',
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

        expect(provider.isAuthenticated, isFalse);
        expect(provider.status, AuthStatus.error);
        // Stored refresh token must be preserved!
        expect(await secureStorage.getRefreshToken(), 'valid-refresh-token');
      },
    );

    test(
      'signInWithGoogle completes authentication flow successfully and persists refresh token before setting authenticated',
      () async {
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
      },
    );

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

      await provider.restoreSession();
      expect(provider.isAuthenticated, isTrue);

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
