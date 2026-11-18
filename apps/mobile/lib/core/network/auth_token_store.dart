/// In-memory RAM storage for the short-lived JWT access token and its expiration.
///
/// Per architecture requirements:
/// - The access token is never persisted to disk, SharedPreferences, or device storage.
/// - When the application process terminates or is killed, the in-memory token is discarded.
/// - A refresh token stored in [SecureTokenStorage] is required to restore sessions on app restart.
class AuthTokenStore {
  String? _accessToken;
  DateTime? _expiresAt;

  /// Returns the cached JWT access token if present.
  String? get accessToken => _accessToken;

  /// Returns whether a valid, non-expired access token is available.
  bool get hasValidToken {
    if (_accessToken == null || _accessToken!.isEmpty) return false;
    if (_expiresAt == null) return false;
    // Buffer by 5 seconds to avoid race conditions with network transit time
    return DateTime.now().isBefore(
      _expiresAt!.subtract(const Duration(seconds: 5)),
    );
  }

  /// Returns whether the token has expired.
  bool get isExpired {
    if (_accessToken == null) return true;
    if (_expiresAt == null) return true;
    return DateTime.now().isAfter(_expiresAt!);
  }

  /// Expiry timestamp of the active access token.
  DateTime? get expiresAt => _expiresAt;

  /// Updates the in-memory access token and calculates expiration.
  void setToken({
    required String accessToken,
    required int expiresInSeconds,
  }) {
    _accessToken = accessToken.trim();
    _expiresAt = DateTime.now().add(Duration(seconds: expiresInSeconds));
  }

  /// Clears in-memory credentials upon logout, expiry, or session invalidation.
  void clear() {
    _accessToken = null;
    _expiresAt = null;
  }
}
