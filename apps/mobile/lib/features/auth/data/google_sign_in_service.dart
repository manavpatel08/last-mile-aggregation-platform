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

/// Internal platform adapter abstracting the Google Sign-In SDK for testability
/// and instance lifecycle management.
abstract interface class GoogleSignInAdapter {
  Future<void> initialize({
    String? clientId,
    String? serverClientId,
  });

  Future<GoogleSignInAccount> authenticate();

  Future<void> signOut();

  Future<void> disconnect();
}

/// Default production adapter delegating to official [GoogleSignIn.instance].
class DefaultGoogleSignInAdapter implements GoogleSignInAdapter {
  DefaultGoogleSignInAdapter({GoogleSignIn? plugin})
      : _plugin = plugin ?? GoogleSignIn.instance;

  final GoogleSignIn _plugin;

  @override
  Future<void> initialize({
    String? clientId,
    String? serverClientId,
  }) {
    return _plugin.initialize(
      clientId: clientId,
      serverClientId: serverClientId,
    );
  }

  @override
  Future<GoogleSignInAccount> authenticate() {
    return _plugin.authenticate();
  }

  @override
  Future<void> signOut() {
    return _plugin.signOut();
  }

  @override
  Future<void> disconnect() {
    return _plugin.disconnect();
  }
}

/// Concrete [GoogleSignInService] using official `google_sign_in` plugin (v7+).
class NativeGoogleSignInService implements GoogleSignInService {
  NativeGoogleSignInService({
    required this.config,
    GoogleSignInAdapter? adapter,
    GoogleSignInAdapter Function()? adapterFactory,
    GoogleSignIn? googleSignIn,
  }) : _adapter = adapter ??
            (adapterFactory != null
                ? adapterFactory()
                : DefaultGoogleSignInAdapter(plugin: googleSignIn));

  final AppConfig config;
  final GoogleSignInAdapter _adapter;

  bool _initialized = false;
  ApiException? _initError;
  Future<void>? _initFuture;

  /// Ensures the Google Sign-In SDK is initialized before any interactive authentication.
  ///
  /// Concurrency & Lifecycle:
  /// - `initialize()` must be called at most once per application runtime.
  /// - Concurrent calls share the same [_initFuture].
  /// - If initialization fails, the failure is cached in [_initError]. Subsequent sign-in
  ///   attempts during the same app runtime return the cached error without calling initialize again.
  /// - If initialization succeeds, [_initialized] is true and subsequent calls return immediately.
  Future<void> _ensureInitialized() async {
    if (_initialized) return;

    if (_initError != null) {
      throw _initError!;
    }

    if (_initFuture != null) {
      await _initFuture;
      if (_initError != null) {
        throw _initError!;
      }
      return;
    }

    final future = _runInitialization();
    _initFuture = future;
    await future;

    if (_initError != null) {
      throw _initError!;
    }
  }

  Future<void> _runInitialization() async {
    try {
      await _adapter.initialize(
        clientId: config.googleClientIdIos,
        serverClientId: config.googleServerClientId,
      );
      _initialized = true;
    } catch (e) {
      _initialized = false;
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Initialize error: $e');
      }
      _initError = const ApiException(
        errorCode: 'GOOGLE_INIT_FAILED',
        message:
            'Google Sign-In initialization failed. Please restart the app.',
      );
    }
  }

  @override
  Future<String?> signIn() async {
    final clientId = config.googleClientIdIos;
    if (clientId == null ||
        clientId.trim().isEmpty ||
        clientId == 'YOUR_IOS_GOOGLE_CLIENT_ID.apps.googleusercontent.com') {
      throw const ApiException(
        errorCode: 'GOOGLE_CONFIG_MISSING',
        message:
            'Google Sign-In is not configured. Please supply GOOGLE_CLIENT_ID_IOS in your .env or via --dart-define.',
      );
    }

    try {
      await _ensureInitialized();
      final account = await _adapter.authenticate();
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
      throw const ApiException(
        errorCode: 'GOOGLE_SIGN_IN_ERROR',
        message: 'Google Sign-In was not completed. Please try again.',
      );
    } on ApiException {
      rethrow;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Interactive sign-in error: $e');
      }
      throw const ApiException(
        errorCode: 'GOOGLE_SIGN_IN_ERROR',
        message: 'An unexpected error occurred during Google Sign-In.',
      );
    }
  }

  @override
  Future<void> signOut() async {
    try {
      await _ensureInitialized();
      await _adapter.signOut();
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
      await _adapter.disconnect();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Disconnect error: $e');
      }
    }
  }
}
