import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Secure token storage wrapping [FlutterSecureStorage].
///
/// Per architecture requirements:
/// - Only the long-lived refresh token is persisted to device secure storage.
/// - The short-lived JWT access token is stored strictly in-memory (RAM) via [AuthTokenStore].
class SecureTokenStorage {
  SecureTokenStorage({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(),
              iOptions: IOSOptions(
                accessibility: KeychainAccessibility.first_unlock,
              ),
            ),
        _inMemoryMap = null;

  /// In-memory constructor for unit and widget testing without native platform channels.
  SecureTokenStorage.inMemory([Map<String, String>? initialData])
      : _storage = null,
        _inMemoryMap = initialData != null
            ? Map<String, String>.from(initialData)
            : <String, String>{};

  static const String refreshTokenKey = 'lastmile_refresh_token';

  final FlutterSecureStorage? _storage;
  final Map<String, String>? _inMemoryMap;

  /// Saves the rotated or initial refresh token to secure storage.
  Future<void> saveRefreshToken(String token) async {
    if (_inMemoryMap != null) {
      _inMemoryMap[refreshTokenKey] = token;
      return;
    }
    await _storage?.write(key: refreshTokenKey, value: token);
  }

  /// Retrieves the persisted refresh token, or null if no session exists.
  Future<String?> getRefreshToken() async {
    if (_inMemoryMap != null) {
      return _inMemoryMap[refreshTokenKey];
    }
    return _storage?.read(key: refreshTokenKey);
  }

  /// Deletes the refresh token upon single-device logout or session invalidation.
  Future<void> deleteRefreshToken() async {
    if (_inMemoryMap != null) {
      _inMemoryMap.remove(refreshTokenKey);
      return;
    }
    await _storage?.delete(key: refreshTokenKey);
  }

  /// Clears all stored secure credentials.
  Future<void> clearAll() async {
    if (_inMemoryMap != null) {
      _inMemoryMap.clear();
      return;
    }
    await _storage?.deleteAll();
  }
}
