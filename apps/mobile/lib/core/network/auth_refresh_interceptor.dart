import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../features/auth/data/auth_repository.dart';
import '../storage/secure_token_storage.dart';
import 'auth_token_store.dart';

/// Callback triggered when a session cannot be refreshed and credentials are wiped.
typedef SessionExpiredCallback = void Function();

/// Single-flight Dio interceptor that catches 401 responses, coordinates an atomic
/// refresh call with the backend, updates tokens, and retries pending requests.
///
/// Prevents token family revocation caused by concurrent refresh attempts.
class AuthRefreshInterceptor extends Interceptor {
  AuthRefreshInterceptor({
    required this.dio,
    required this.tokenStore,
    required this.secureStorage,
    required this.authRepository,
    this.onSessionExpired,
  });

  final Dio dio;
  final AuthTokenStore tokenStore;
  final SecureTokenStorage secureStorage;
  final AuthRepository authRepository;
  final SessionExpiredCallback? onSessionExpired;

  Completer<bool>? _refreshCompleter;

  static const String retryExtraKey = '_authRetry';

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final statusCode = err.response?.statusCode;
    final path = err.requestOptions.path;

    // 1. Only intercept 401 Unauthorized
    if (statusCode != 401) {
      return handler.next(err);
    }

    // 2. Never attempt token refresh on authentication endpoints
    if (path.contains('/auth/google') ||
        path.contains('/auth/refresh') ||
        path.contains('/auth/logout')) {
      return handler.next(err);
    }

    // 3. Never retry a request that has already been retried
    if (err.requestOptions.extra[retryExtraKey] == true) {
      return handler.next(err);
    }

    try {
      // 4. Check if another concurrent request has already refreshed the token
      final currentAccessToken = tokenStore.accessToken;
      final sentAuthHeader = err.requestOptions.headers['Authorization'] as String?;
      final tokenAlreadyRefreshed = currentAccessToken != null &&
          currentAccessToken.isNotEmpty &&
          sentAuthHeader != null &&
          sentAuthHeader != 'Bearer $currentAccessToken';

      if (tokenAlreadyRefreshed) {
        // Immediate retry with the already-rotated token
        final requestOptions = err.requestOptions;
        requestOptions.extra[retryExtraKey] = true;
        requestOptions.headers['Authorization'] = 'Bearer $currentAccessToken';

        final retryResponse = await dio.fetch(requestOptions);
        return handler.resolve(retryResponse);
      }

      // 5. Otherwise perform or join single-flight refresh
      final refreshSuccess = await _performSingleFlightRefresh();
      if (!refreshSuccess) {
        return handler.next(err);
      }

      // Retry the failed request with the rotated access token
      final newAccessToken = tokenStore.accessToken;
      final requestOptions = err.requestOptions;
      requestOptions.extra[retryExtraKey] = true;
      if (newAccessToken != null && newAccessToken.isNotEmpty) {
        requestOptions.headers['Authorization'] = 'Bearer $newAccessToken';
      }

      final retryResponse = await dio.fetch(requestOptions);
      return handler.resolve(retryResponse);
    } catch (_) {
      return handler.next(err);
    }
  }

  Future<bool> _performSingleFlightRefresh() async {
    // If a refresh is already in flight, await the existing future
    if (_refreshCompleter != null) {
      return _refreshCompleter!.future;
    }

    final completer = Completer<bool>();
    _refreshCompleter = completer;

    try {
      final refreshToken = await secureStorage.getRefreshToken();
      if (refreshToken == null || refreshToken.trim().isEmpty) {
        _handleSessionFailure();
        completer.complete(false);
        return false;
      }

      final refreshResult = await authRepository.refreshSession(
        refreshToken: refreshToken.trim(),
      );

      // Atomically update memory and persistent secure storage
      tokenStore.setToken(
        accessToken: refreshResult.accessToken,
        expiresInSeconds: refreshResult.expiresIn,
      );
      await secureStorage.saveRefreshToken(refreshResult.refreshToken);

      completer.complete(true);
      return true;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[AuthRefreshInterceptor] Token refresh failed: $e');
      }
      _handleSessionFailure();
      completer.complete(false);
      return false;
    } finally {
      _refreshCompleter = null;
    }
  }

  void _handleSessionFailure() {
    tokenStore.clear();
    // Delete refresh token so we don't attempt to reuse an invalid token
    secureStorage.deleteRefreshToken();
    onSessionExpired?.call();
  }
}
