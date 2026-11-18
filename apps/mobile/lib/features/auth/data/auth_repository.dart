import '../models/auth_session.dart';
import '../models/auth_user.dart';

/// Contract for authentication operations against the backend.
abstract interface class AuthRepository {
  /// Authenticates with a verified Google OAuth ID token.
  Future<AuthSession> authenticateWithGoogle({
    required String idToken,
    String? deviceFingerprint,
  });

  /// Rotates an active session using the persisted refresh token.
  Future<RefreshSessionResult> refreshSession({
    required String refreshToken,
    String? deviceFingerprint,
  });

  /// Terminates the current device session on the backend.
  Future<void> logout();

  /// Retrieves the complete user profile and role details for the current user.
  Future<AuthUser> getCurrentUser();
}
