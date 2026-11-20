import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

/// Key in [RequestOptions.extra] controlling request metadata and headers.
abstract final class RequestMetadata {
  /// Extra key for `Idempotency-Key` header injection.
  static const String idempotencyKey = 'idempotencyKey';

  /// Extra key controlling whether a request requires authentication.
  ///
  /// - `true`: Request is protected. [ApiHeadersInterceptor] attaches the active
  ///   access token, and [AuthRefreshInterceptor] will coordinate refresh on 401.
  /// - `false`: Request is explicitly public. [ApiHeadersInterceptor] will NOT attach an
  ///   `Authorization` header, and [AuthRefreshInterceptor] will NEVER attempt token refresh.
  /// - `null`: Defaults to protected unless the request path is a known unauthenticated
  ///   auth endpoint (e.g. `/auth/google`, `/auth/refresh`).
  static const String requiresAuth = 'requiresAuth';
}

/// Callback hook allowing future authentication modules to supply the active
/// JWT access token without modifying the shared HTTP client foundation.
typedef AuthTokenProvider = Future<String?> Function();

/// Interceptor responsible for attaching standard API headers:
/// - `Authorization: Bearer <token>` when an auth token provider is registered and request is protected.
/// - `Idempotency-Key` when supplied via `options.extra['idempotencyKey']`.
class ApiHeadersInterceptor extends Interceptor {
  ApiHeadersInterceptor({this.tokenProvider});

  static const String idempotencyKeyExtra = RequestMetadata.idempotencyKey;
  static const String requiresAuthExtra = RequestMetadata.requiresAuth;

  final AuthTokenProvider? tokenProvider;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final requiresAuth = options.extra[RequestMetadata.requiresAuth];
    final isExplicitlyPublic = requiresAuth == false;

    // Attach access token if request is not explicitly public and not already authorized
    final existingAuth = options.headers['Authorization'];
    if (!isExplicitlyPublic && existingAuth == null && tokenProvider != null) {
      if (!_isPublicAuthEndpoint(options.path)) {
        final token = await tokenProvider!.call();
        if (token != null && token.trim().isNotEmpty) {
          options.headers['Authorization'] = 'Bearer ${token.trim()}';
          if (requiresAuth == null) {
            options.extra[RequestMetadata.requiresAuth] = true;
          }
        }
      }
    }

    final extraIdempotencyKey = options.extra[RequestMetadata.idempotencyKey] ??
        options.extra[idempotencyKeyExtra];
    if (extraIdempotencyKey is String &&
        extraIdempotencyKey.trim().isNotEmpty &&
        !options.headers.containsKey('Idempotency-Key')) {
      options.headers['Idempotency-Key'] = extraIdempotencyKey.trim();
    }

    handler.next(options);
  }

  static bool _isPublicAuthEndpoint(String path) {
    return path.endsWith('/auth/google') || path.endsWith('/auth/refresh');
  }
}

/// Safe debug-only request/response logger that never outputs secrets,
/// authorization tokens, or request bodies.
class SafeNetworkLogInterceptor extends Interceptor {
  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (kDebugMode) {
      debugPrint('[HTTP ->] ${options.method} ${options.path}');
    }
    handler.next(options);
  }

  @override
  void onResponse(
    Response<dynamic> response,
    ResponseInterceptorHandler handler,
  ) {
    if (kDebugMode) {
      debugPrint(
        '[HTTP <-] ${response.statusCode} ${response.requestOptions.method} '
        '${response.requestOptions.path}',
      );
    }
    handler.next(response);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    if (kDebugMode) {
      debugPrint(
        '[HTTP !!] ${err.response?.statusCode ?? err.type.name} '
        '${err.requestOptions.method} ${err.requestOptions.path}',
      );
    }
    handler.next(err);
  }
}
