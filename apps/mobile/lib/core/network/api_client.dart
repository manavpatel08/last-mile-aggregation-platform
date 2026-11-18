import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../config/app_config.dart';
import 'api_exception.dart';
import 'dio_interceptors.dart';

/// Reusable Dio HTTP client foundation configured from [AppConfig].
///
/// Feature modules consume this client when backend integration stages begin.
/// No live requests are executed during application startup.
class ApiClient {
  ApiClient({
    required AppConfig config,
    AuthTokenProvider? tokenProvider,
    HttpClientAdapter? httpClientAdapter,
    bool enableDebugLogging = kDebugMode,
  }) : _dio = Dio(
         BaseOptions(
           baseUrl: config.apiBaseUrl,
           connectTimeout: config.connectTimeout,
           receiveTimeout: config.receiveTimeout,
           sendTimeout: config.sendTimeout,
           headers: const <String, Object>{
             'Content-Type': 'application/json; charset=utf-8',
             'Accept': 'application/json',
           },
         ),
       ) {
    if (httpClientAdapter != null) {
      _dio.httpClientAdapter = httpClientAdapter;
    }

    _dio.interceptors.add(ApiHeadersInterceptor(tokenProvider: tokenProvider));

    if (enableDebugLogging) {
      _dio.interceptors.add(SafeNetworkLogInterceptor());
    }
  }

  final Dio _dio;

  /// Exposes the configured [Dio] instance for advanced usage or testing.
  Dio get dio => _dio;

  Future<Response<T>> get<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) async {
    try {
      return await _dio.get<T>(
        path,
        queryParameters: queryParameters,
        options: options,
        cancelToken: cancelToken,
      );
    } on DioException catch (exception) {
      throw ApiException.fromDioException(exception);
    }
  }

  Future<Response<T>> post<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    String? idempotencyKey,
    Options? options,
    CancelToken? cancelToken,
  }) async {
    try {
      return await _dio.post<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: _mergeIdempotencyOption(options, idempotencyKey),
        cancelToken: cancelToken,
      );
    } on DioException catch (exception) {
      throw ApiException.fromDioException(exception);
    }
  }

  Future<Response<T>> put<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    String? idempotencyKey,
    Options? options,
    CancelToken? cancelToken,
  }) async {
    try {
      return await _dio.put<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: _mergeIdempotencyOption(options, idempotencyKey),
        cancelToken: cancelToken,
      );
    } on DioException catch (exception) {
      throw ApiException.fromDioException(exception);
    }
  }

  Future<Response<T>> patch<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    String? idempotencyKey,
    Options? options,
    CancelToken? cancelToken,
  }) async {
    try {
      return await _dio.patch<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: _mergeIdempotencyOption(options, idempotencyKey),
        cancelToken: cancelToken,
      );
    } on DioException catch (exception) {
      throw ApiException.fromDioException(exception);
    }
  }

  Future<Response<T>> delete<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    String? idempotencyKey,
    Options? options,
    CancelToken? cancelToken,
  }) async {
    try {
      return await _dio.delete<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: _mergeIdempotencyOption(options, idempotencyKey),
        cancelToken: cancelToken,
      );
    } on DioException catch (exception) {
      throw ApiException.fromDioException(exception);
    }
  }

  Options? _mergeIdempotencyOption(Options? options, String? idempotencyKey) {
    if (idempotencyKey == null || idempotencyKey.trim().isEmpty) {
      return options;
    }

    final mergedExtra = Map<String, dynamic>.from(options?.extra ?? const {});
    mergedExtra[ApiHeadersInterceptor.idempotencyKeyExtra] = idempotencyKey;

    return (options ?? Options()).copyWith(extra: mergedExtra);
  }
}
