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
  })  : _adapterFactory = adapterFactory ??
            (() => adapter ?? DefaultGoogleSignInAdapter(plugin: googleSignIn)),
        _adapter = adapter ??
            (googleSignIn != null
                ? DefaultGoogleSignInAdapter(plugin: googleSignIn)
                : null);

  final AppConfig config;
  final GoogleSignInAdapter Function() _adapterFactory;
  GoogleSignInAdapter? _adapter;

  bool _initialized = false;
  Future<void>? _initFuture;

  /// Ensures the Google Sign-In SDK is initialized before any interactive authentication.
  ///
  /// Concurrency:
  /// Concurrent callers share the same [_initFuture] so initialization runs at most once.
  ///
  /// Retry strategy:
  /// If initialization throws, the failed state is cleared, allowing subsequent sign-in
  /// attempts to recreate or re-initialize the adapter without being permanently locked.
  Future<void> _ensureInitialized() async {
    if (_initialized) return;

    if (_initFuture != null) {
      await _initFuture;
      if (!_initialized) {
        throw const ApiException(
          errorCode: 'GOOGLE_INIT_FAILED',
          message:
              'Google Sign-In initialization failed. Please restart the app or try again.',
        );
      }
      return;
    }

    _adapter ??= _adapterFactory();
    final future = _runInitialization();
    _initFuture = future;
    try {
      await future;
    } finally {
      _initFuture = null;
    }

    if (!_initialized) {
      throw const ApiException(
        errorCode: 'GOOGLE_INIT_FAILED',
        message:
            'Google Sign-In initialization failed. Please restart the app or try again.',
      );
    }
  }

  Future<void> _runInitialization() async {
    try {
      await _adapter!.initialize(
        clientId: config.googleClientIdIos,
        serverClientId: config.googleServerClientId,
      );
      _initialized = true;
    } catch (e) {
      _initialized = false;
      // Invalidate the adapter on failure so subsequent attempts recreate/retry
      _adapter = null;
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Initialize error: $e');
      }
      throw const ApiException(
        errorCode: 'GOOGLE_INIT_FAILED',
        message:
            'Google Sign-In initialization failed. Please restart the app or try again.',
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
      final account = await _adapter!.authenticate();
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
      final adapter = _adapter ?? _adapterFactory();
      await adapter.signOut();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Sign out error: $e');
      }
    }
  }

  @override
  Future<void> disconnect() async {
    try {
      final adapter = _adapter ?? _adapterFactory();
      await adapter.disconnect();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[GoogleSignInService] Disconnect error: $e');
      }
    }
  }
}
