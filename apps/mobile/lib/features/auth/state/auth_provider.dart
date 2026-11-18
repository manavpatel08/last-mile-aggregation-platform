import 'package:flutter/foundation.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/auth_token_store.dart';
import '../../../core/storage/secure_token_storage.dart';
import '../data/auth_repository.dart';
import '../data/google_sign_in_service.dart';
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
  bool _isRestoring = false;

  AuthStatus get status => _status;
  AuthUser? get user => _user;
  String? get errorMessage => _errorMessage;

  bool get isAuthenticated =>
      _status == AuthStatus.authenticated && _user != null;

  bool get isLoading =>
      _status == AuthStatus.initial || _status == AuthStatus.authenticating;

  bool get isInitial => _status == AuthStatus.initial;
  bool get isUnauthenticated => _status == AuthStatus.unauthenticated;

  /// Restores session on application startup from the persisted refresh token.
  Future<void> restoreSession() async {
    if (_isRestoring) return;
    _isRestoring = true;

    try {
      final refreshToken = await secureStorage.getRefreshToken();
      if (refreshToken == null || refreshToken.trim().isEmpty) {
        _status = AuthStatus.unauthenticated;
        notifyListeners();
        return;
      }

      // Rotate session with backend
      final refreshResult = await authRepository.refreshSession(
        refreshToken: refreshToken.trim(),
      );

      tokenStore.setToken(
        accessToken: refreshResult.accessToken,
        expiresInSeconds: refreshResult.expiresIn,
      );
      await secureStorage.saveRefreshToken(refreshResult.refreshToken);

      // Fetch full user profile
      final profile = await authRepository.getCurrentUser();
      _user = profile;
      _status = AuthStatus.authenticated;
      _errorMessage = null;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[AuthProvider] Session restoration failed: $e');
      }
      tokenStore.clear();
      await secureStorage.deleteRefreshToken();
      _user = null;
      _status = AuthStatus.unauthenticated;
    } finally {
      _isRestoring = false;
      notifyListeners();
    }
  }

  /// Initiates interactive Google Sign-In and exchanges ID token for backend JWT.
  Future<bool> signInWithGoogle() async {
    try {
      _errorMessage = null;
      final idToken = await googleSignInService.signIn();
      if (idToken == null) {
        // User cancelled the interactive sign-in flow
        return false;
      }

      _status = AuthStatus.authenticating;
      notifyListeners();

      final session = await authRepository.authenticateWithGoogle(
        idToken: idToken,
      );

      tokenStore.setToken(
        accessToken: session.accessToken,
        expiresInSeconds: session.expiresIn,
      );
      await secureStorage.saveRefreshToken(session.refreshToken);

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

  /// Terminates the current device session, cleans up local credentials,
  /// and invalidates the session on the backend.
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
    await secureStorage.deleteRefreshToken();
    _user = null;
    _errorMessage = null;
    _status = AuthStatus.unauthenticated;
    notifyListeners();
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
