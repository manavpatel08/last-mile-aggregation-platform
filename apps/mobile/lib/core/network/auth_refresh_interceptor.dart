import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../features/auth/data/auth_repository.dart';
import '../storage/secure_token_storage.dart';
import 'api_exception.dart';
import 'auth_token_store.dart';
import 'dio_interceptors.dart';

/// Callback triggered when a session cannot be refreshed and credentials are wiped.
typedef SessionExpiredCallback = void Function();

class _RefreshAttemptResult {
  const _RefreshAttemptResult.success() : error = null;
  const _RefreshAttemptResult.failure(this.error);

  final Object? error;
  bool get isSuccess => error == null;
}

/// Single-flight Dio interceptor that catches 401 responses on protected endpoints,
/// coordinates an atomic refresh call with the backend, updates tokens safely, and retries requests.
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

  Completer<_RefreshAttemptResult>? _refreshCompleter;

  static const String retryExtraKey = '_authRetry';

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final statusCode = err.response?.statusCode;
    final path = err.requestOptions.path;

    // 1. Only intercept 401 Unauthorized. Never refresh for 403 Forbidden or any non-401.
    if (statusCode != 401) {
      return handler.next(err);
    }

    // 2. Never attempt token refresh on authentication endpoints
    if (_isAuthEndpoint(path)) {
      return handler.next(err);
    }

    // 3. Public requests must never trigger refresh.
    // Check explicit metadata convention and presence of Authorization header.
    final requiresAuth = err.requestOptions.extra[RequestMetadata.requiresAuth];
    if (requiresAuth == false) {
      return handler.next(err);
    }

    final sentAuthHeader = err.requestOptions.headers['Authorization'] as String?;
    if (requiresAuth != true &&
        (sentAuthHeader == null || !sentAuthHeader.startsWith('Bearer '))) {
      // Unauthenticated or public request receiving 401
      return handler.next(err);
    }

    // 4. Never retry a request that has already been retried once
    if (err.requestOptions.extra[retryExtraKey] == true) {
      return handler.next(err);
    }

    try {
      // 5. Check if another concurrent request has already refreshed the token
      final currentAccessToken = tokenStore.accessToken;
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

      // 6. Otherwise perform or join single-flight refresh
      final refreshResult = await _performSingleFlightRefresh();
      if (!refreshResult.isSuccess) {
        final refreshError = refreshResult.error;
        final propagationException = _createRefreshDioException(
          requestOptions: err.requestOptions,
          error: refreshError ?? err,
          originalError: err,
        );
        return handler.reject(propagationException);
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
    } catch (e) {
      if (e is DioException) {
        return handler.reject(e);
      }
      return handler.reject(
        DioException(
          requestOptions: err.requestOptions,
          error: e,
          message: e.toString(),
        ),
      );
    }
  }

  Future<_RefreshAttemptResult> _performSingleFlightRefresh() async {
    // If a refresh is already in flight, await the existing future
    if (_refreshCompleter != null) {
      return _refreshCompleter!.future;
    }

    final completer = Completer<_RefreshAttemptResult>();
    _refreshCompleter = completer;

    try {
      final refreshToken = await secureStorage.getRefreshToken();
      if (refreshToken == null || refreshToken.trim().isEmpty) {
        await _handleDefinitiveSessionFailure();
        const failure = _RefreshAttemptResult.failure(
          ApiException(
            statusCode: 401,
            errorCode: 'UNAUTHORIZED',
            message: 'No active session or refresh token available.',
          ),
        );
        completer.complete(failure);
        return failure;
      }

      final refreshResult = await authRepository.refreshSession(
        refreshToken: refreshToken.trim(),
      );

      // Safe token rotation: Persist rotated refresh token successfully
      // BEFORE publishing access token to tokenStore!
      try {
        await secureStorage.saveRefreshToken(refreshResult.refreshToken);
      } catch (storageError) {
        if (kDebugMode) {
          debugPrint(
            '[AuthRefreshInterceptor] Failed to persist rotated refresh token: $storageError',
          );
        }
        // Unrecoverable state: backend burned old token, but device cannot persist new one
        await _handleDefinitiveSessionFailure();
        const failure = _RefreshAttemptResult.failure(
          ApiException(
            statusCode: 401,
            errorCode: 'STORAGE_WRITE_FAILURE',
            message: 'Failed to securely store authentication credentials.',
          ),
        );
        completer.complete(failure);
        return failure;
      }

      // Publish access token in RAM only after persistence succeeded
      tokenStore.setToken(
        accessToken: refreshResult.accessToken,
        expiresInSeconds: refreshResult.expiresIn,
      );

      const success = _RefreshAttemptResult.success();
      completer.complete(success);
      return success;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[AuthRefreshInterceptor] Token refresh failed: $e');
      }

      // Distinguish definitive refresh token rejection (401) vs permission (403) or transient failures
      if (_isInvalidRefreshTokenResponse(e)) {
        await _handleDefinitiveSessionFailure();
      } else {
        // Permission rejection (403), network timeout, connection error, 5xx server error:
        // PRESERVE the stored refresh token. Do not delete it and do not call onSessionExpired!
        if (kDebugMode) {
          debugPrint(
            '[AuthRefreshInterceptor] Preserving refresh token across non-definitive failure',
          );
        }
      }
      final failure = _RefreshAttemptResult.failure(e);
      completer.complete(failure);
      return failure;
    } finally {
      _refreshCompleter = null;
    }
  }

  DioException _createRefreshDioException({
    required RequestOptions requestOptions,
    required Object error,
    required DioException originalError,
  }) {
    if (error is DioException) {
      return error.copyWith(requestOptions: requestOptions);
    }
    if (error is ApiException) {
      return DioException(
        requestOptions: requestOptions,
        response: Response(
          requestOptions: requestOptions,
          statusCode: error.statusCode,
          data: {
            'statusCode': error.statusCode,
            'errorCode': error.errorCode,
            'message': error.message,
            'errors': error.errors,
            'path': error.path ?? requestOptions.path,
          },
        ),
        type: _dioTypeFromApiException(error),
        error: error,
        message: error.message,
      );
    }
    return DioException(
      requestOptions: requestOptions,
      error: error,
      message: error.toString(),
    );
  }

  DioExceptionType _dioTypeFromApiException(ApiException error) {
    if (error.errorCode == 'REQUEST_TIMEOUT') {
      return DioExceptionType.connectionTimeout;
    }
    if (error.errorCode == 'NETWORK_UNAVAILABLE') {
      return DioExceptionType.connectionError;
    }
    if (error.statusCode != null) {
      return DioExceptionType.badResponse;
    }
    return DioExceptionType.unknown;
  }

  Future<void> _handleDefinitiveSessionFailure() async {
    tokenStore.clear();
    try {
      await secureStorage.deleteRefreshToken();
    } catch (_) {}
    onSessionExpired?.call();
  }

  bool _isInvalidRefreshTokenResponse(Object error) {
    if (error is ApiException) {
      return error.isInvalidRefreshTokenResponse;
    }
    if (error is DioException) {
      final status = error.response?.statusCode;
      return status == 401;
    }
    return false;
  }

  static bool _isAuthEndpoint(String path) {
    return path.contains('/auth/google') ||
        path.contains('/auth/refresh') ||
        path.contains('/auth/logout');
  }
}
