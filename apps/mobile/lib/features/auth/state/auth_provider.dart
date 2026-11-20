import 'package:flutter/foundation.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/auth_token_store.dart';
import '../../../core/storage/secure_token_storage.dart';
import '../data/auth_repository.dart';
import '../data/google_sign_in_service.dart';
import '../models/auth_session.dart';
import '../models/auth_user.dart';

enum AuthStatus {
  initial,
  authenticating,
  authenticated,
  unauthenticated,
  error,
}

/// Central state manager for authentication lifecycle, session restoration,
/// profile caching, and role identification.
class AuthProvider extends ChangeNotifier {
  AuthProvider({
    required this.authRepository,
    required this.googleSignInService,
    required this.tokenStore,
    required this.secureStorage,
  });

  final AuthRepository authRepository;
  final GoogleSignInService googleSignInService;
  final AuthTokenStore tokenStore;
  final SecureTokenStorage secureStorage;

  AuthStatus _status = AuthStatus.initial;
  AuthUser? _user;
  String? _errorMessage;
  Future<void>? _restoreSessionFuture;

  AuthStatus get status => _status;
  AuthUser? get user => _user;
  String? get errorMessage => _errorMessage;

  bool get isAuthenticated =>
      _status == AuthStatus.authenticated && _user != null;

  bool get isLoading =>
      _status == AuthStatus.initial || _status == AuthStatus.authenticating;

  bool get isInitial => _status == AuthStatus.initial;
  bool get isUnauthenticated => _status == AuthStatus.unauthenticated;

  /// Restores session on application startup from persisted refresh token.
  ///
  /// Concurrent callers share the same in-flight Future to prevent duplicate
  /// token rotation attempts and inconsistent state transitions.
  Future<void> restoreSession() {
    if (_restoreSessionFuture != null) {
      return _restoreSessionFuture!;
    }
    final future = _runRestoreSession();
    _restoreSessionFuture = future;
    return future;
  }

  Future<void> _runRestoreSession() async {
    try {
      if (_status == AuthStatus.error) {
        _status = AuthStatus.authenticating;
        notifyListeners();
      }

      final refreshToken = await secureStorage.getRefreshToken();
      if (refreshToken == null || refreshToken.trim().isEmpty) {
        _status = AuthStatus.unauthenticated;
        _errorMessage = null;
        notifyListeners();
        return;
      }

      // Rotate session with backend
      final RefreshSessionResult refreshResult;
      try {
        refreshResult = await authRepository.refreshSession(
          refreshToken: refreshToken.trim(),
        );
      } catch (e) {
        if (kDebugMode) {
          debugPrint('[AuthProvider] Session refresh failed during restore: $e');
        }
        if (_isInvalidRefreshTokenResponse(e)) {
          // Definitive failure from refresh endpoint (401 Unauthorized):
          // Clear credentials and transition to unauthenticated
          tokenStore.clear();
          try {
            await secureStorage.deleteRefreshToken();
          } catch (_) {}
          _user = null;
          _status = AuthStatus.unauthenticated;
          _errorMessage = 'Your session has expired. Please sign in again.';
        } else {
          // Permission rejection (403) or transient failure (network timeout, connection error, 5xx):
          // Preserve stored refresh token so user can retry!
          tokenStore.clear();
          _user = null;
          _status = AuthStatus.error;
          _errorMessage = e is ApiException
              ? e.message
              : 'Unable to reach the server. Please check your network and try again.';
        }
        notifyListeners();
        return;
      }

      // Safe token rotation: Persist rotated refresh token successfully
      // BEFORE publishing access token to tokenStore!
      try {
        await secureStorage.saveRefreshToken(refreshResult.refreshToken);
      } catch (storageError) {
        if (kDebugMode) {
          debugPrint(
            '[AuthProvider] Failed to persist rotated token during restore: $storageError',
          );
        }
        // Unrecoverable state: backend burned old token, but device cannot persist new one
        tokenStore.clear();
        try {
          await secureStorage.deleteRefreshToken();
        } catch (_) {}
        _user = null;
        _status = AuthStatus.unauthenticated;
        _errorMessage =
            'Failed to securely persist authentication credentials. Please sign in again.';
        notifyListeners();
        return;
      }

      // Publish access token in RAM only after persistence succeeded
      tokenStore.setToken(
        accessToken: refreshResult.accessToken,
        expiresInSeconds: refreshResult.expiresIn,
      );

      // Fetch full user profile. Do NOT mark authenticated if profile retrieval fails.
      try {
        final profile = await authRepository.getCurrentUser();
        _user = profile;
        _status = AuthStatus.authenticated;
        _errorMessage = null;
      } catch (userError) {
        if (kDebugMode) {
          debugPrint(
            '[AuthProvider] Profile fetch failed during restore: $userError',
          );
        }
        // Requirements 1 & 3: Never clear stored refresh token for profile retrieval failures (403, 401, 5xx).
        // Profile retrieval failure preserves the valid rotated refresh token so the user can retry.
        _user = null;
        _status = AuthStatus.error;
        _errorMessage = userError is ApiException
            ? userError.message
            : 'Failed to retrieve profile. Please check your connection and try again.';
      }
      notifyListeners();
    } finally {
      _restoreSessionFuture = null;
    }
  }

  /// Initiates interactive Google Sign-In and exchanges ID token for backend JWT.
  Future<bool> signInWithGoogle() async {
    try {
      _errorMessage = null;
      final idToken = await googleSignInService.signIn();
      if (idToken == null) {
        // User cancelled interactive sign-in flow
        return false;
      }

      _status = AuthStatus.authenticating;
      notifyListeners();

      final session = await authRepository.authenticateWithGoogle(
        idToken: idToken,
      );

      // Persist refresh token BEFORE publishing access token or setting authenticated!
      try {
        await secureStorage.saveRefreshToken(session.refreshToken);
      } catch (storageError) {
        if (kDebugMode) {
          debugPrint(
            '[AuthProvider] Failed to save refresh token on sign-in: $storageError',
          );
        }
        tokenStore.clear();
        try {
          await secureStorage.deleteRefreshToken();
        } catch (_) {}
        _user = null;
        _status = AuthStatus.unauthenticated;
        _errorMessage =
            'Failed to securely store authentication credentials. Please try again.';
        notifyListeners();
        return false;
      }

      tokenStore.setToken(
        accessToken: session.accessToken,
        expiresInSeconds: session.expiresIn,
      );

      _user = session.user;
      _status = AuthStatus.authenticated;
      _errorMessage = null;
      notifyListeners();
      return true;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[AuthProvider] Google Sign-In error: $e');
      }
      _status = AuthStatus.unauthenticated;
      if (e is ApiException) {
        _errorMessage = e.message;
      } else {
        _errorMessage = 'Authentication failed. Please try again.';
      }
      notifyListeners();
      return false;
    }
  }

  /// Terminates current device session, cleans up local credentials,
  /// and invalidates session on backend.
  Future<void> logout() async {
    try {
      await authRepository.logout();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[AuthProvider] Backend logout call non-fatal error: $e');
      }
    }

    try {
      await googleSignInService.signOut();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[AuthProvider] Google sign-out non-fatal error: $e');
      }
    }

    tokenStore.clear();
    try {
      await secureStorage.deleteRefreshToken();
    } catch (_) {}
    _user = null;
    _errorMessage = null;
    _status = AuthStatus.unauthenticated;
    notifyListeners();
  }

  bool _isInvalidRefreshTokenResponse(Object error) {
    if (error is ApiException) {
      return error.isInvalidRefreshTokenResponse;
    }
    return false;
  }

  /// Re-fetches the current user profile from `/users/me`.
  Future<void> refreshProfile() async {
    if (!isAuthenticated) return;
    try {
      final updatedProfile = await authRepository.getCurrentUser();
      _user = updatedProfile;
      notifyListeners();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[AuthProvider] Refresh profile error: $e');
      }
    }
  }

  /// Invoked by [AuthRefreshInterceptor] when refresh fails or token is revoked.
  void onSessionExpired() {
    tokenStore.clear();
    _user = null;
    _status = AuthStatus.unauthenticated;
    _errorMessage = 'Your session has expired. Please sign in again.';
    notifyListeners();
  }

  /// Resets any transient error message.
  void clearError() {
    _errorMessage = null;
    notifyListeners();
  }
}
