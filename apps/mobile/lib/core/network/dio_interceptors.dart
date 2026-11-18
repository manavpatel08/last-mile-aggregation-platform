import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

/// Callback hook allowing future authentication modules to supply the active
/// JWT access token without modifying the shared HTTP client foundation.
typedef AuthTokenProvider = Future<String?> Function();

/// Interceptor responsible for attaching standard API headers:
/// - `Authorization: Bearer <token>` when an auth token provider is registered.
/// - `Idempotency-Key` when supplied via `options.extra['idempotencyKey']`.
class ApiHeadersInterceptor extends Interceptor {
  ApiHeadersInterceptor({this.tokenProvider});

  static const String idempotencyKeyExtra = 'idempotencyKey';

  final AuthTokenProvider? tokenProvider;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final existingAuth = options.headers['Authorization'];
    if (existingAuth == null && tokenProvider != null) {
      final token = await tokenProvider!.call();
      if (token != null && token.trim().isNotEmpty) {
        options.headers['Authorization'] = 'Bearer ${token.trim()}';
      }
    }

    final extraIdempotencyKey = options.extra[idempotencyKeyExtra];
    if (extraIdempotencyKey is String &&
        extraIdempotencyKey.trim().isNotEmpty &&
        !options.headers.containsKey('Idempotency-Key')) {
      options.headers['Idempotency-Key'] = extraIdempotencyKey.trim();
    }

    handler.next(options);
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
