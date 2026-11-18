import 'package:flutter/foundation.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/api_exception.dart';

/// Contract for acquiring Google OAuth ID tokens and managing Google session lifecycle.
abstract interface class GoogleSignInService {
  /// Initiates the Google Sign-In interactive flow.
  ///
  /// Returns the Google ID token string on success, or `null` if the user cancelled.
  Future<String?> signIn();

  /// Signs out of the Google account on the client device.
  Future<void> signOut();

  /// Disconnects the Google account and revokes client scopes.
  Future<void> disconnect();
}

/// Concrete [GoogleSignInService] using official `google_sign_in` plugin (v7+).
class NativeGoogleSignInService implements GoogleSignInService {
  NativeGoogleSignInService({
    required this.config,
    GoogleSignIn? googleSignIn,
  })  : _googleSignIn = googleSignIn ?? GoogleSignIn.instance;

  final AppConfig config;
  final GoogleSignIn _googleSignIn;
  bool _initialized = false;
  Future<void>? _initFuture;

  Future<void> _ensureInitialized() async {
    if (_initialized) return;
    if (_initFuture != null) {
      await _initFuture;
      return;
    }

    _initFuture = _runInitialization();
    await _initFuture;
  }

  Future<void> _runInitialization() async {
    try {
      await _googleSignIn.initialize(
        clientId: config.googleClientIdIos,
        serverClientId: config.googleServerClientId,
      );
      _initialized = true;
    } catch (e) {
      _initFuture = null;
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Initialize error: $e');
      }
    }
  }

  @override
  Future<String?> signIn() async {
    final clientId = config.googleClientIdIos;
    if (clientId == null || clientId.trim().isEmpty) {
      throw const ApiException(
        errorCode: 'GOOGLE_CONFIG_MISSING',
        message:
            'Google Sign-In is not configured. Please supply GOOGLE_CLIENT_ID_IOS in your .env or via --dart-define.',
      );
    }

    try {
      await _ensureInitialized();
      final account = await _googleSignIn.authenticate();
      final idToken = account.authentication.idToken;
      if (idToken == null || idToken.trim().isEmpty) {
        throw const ApiException(
          errorCode: 'MISSING_ID_TOKEN',
          message: 'Google Sign-In completed but returned an empty ID token.',
        );
      }
      return idToken;
    } on GoogleSignInException catch (e) {
      if (e.code == GoogleSignInExceptionCode.canceled) {
        // User explicitly cancelled the interactive sign-in flow
        return null;
      }
      if (kDebugMode) {
        debugPrint(
          '[GoogleSignInService] GoogleSignInException: ${e.code} ${e.description}',
        );
      }
      rethrow;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Interactive sign-in error: $e');
      }
      rethrow;
    }
  }

  @override
  Future<void> signOut() async {
    try {
      await _ensureInitialized();
      await _googleSignIn.signOut();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Sign out error: $e');
      }
    }
  }

  @override
  Future<void> disconnect() async {
    try {
      await _ensureInitialized();
      await _googleSignIn.disconnect();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Disconnect error: $e');
      }
    }
  }
}
