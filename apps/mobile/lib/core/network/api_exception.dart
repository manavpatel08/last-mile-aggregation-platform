import 'package:dio/dio.dart';

/// Normalized HTTP error representation aligned with the standard error
/// envelope documented in `docs/API_SPECIFICATION.md` Section 1.3.
class ApiException implements Exception {
  const ApiException({
    required this.errorCode,
    required this.message,
    this.statusCode,
    this.errors = const [],
    this.path,
    this.timestamp,
  });

  factory ApiException.fromDioException(DioException exception) {
    final response = exception.response;
    final data = response?.data;

    if (data is Map<String, dynamic>) {
      final rawStatusCode = data['statusCode'];
      final rawErrorCode = data['errorCode'];
      final rawMessage = data['message'];
      final rawErrors = data['errors'];
      final rawPath = data['path'];
      final rawTimestamp = data['timestamp'];

      return ApiException(
        statusCode: rawStatusCode is int ? rawStatusCode : response?.statusCode,
        errorCode: rawErrorCode is String && rawErrorCode.isNotEmpty
            ? rawErrorCode
            : _defaultCodeForType(exception.type, response?.statusCode),
        message: rawMessage is String && rawMessage.isNotEmpty
            ? rawMessage
            : _defaultMessageForType(exception.type),
        errors: rawErrors is List ? List<dynamic>.unmodifiable(rawErrors) : const [],
        path: rawPath is String ? rawPath : exception.requestOptions.path,
        timestamp: rawTimestamp is String ? rawTimestamp : null,
      );
    }

    return ApiException(
      statusCode: response?.statusCode,
      errorCode: _defaultCodeForType(exception.type, response?.statusCode),
      message: _defaultMessageForType(exception.type),
      path: exception.requestOptions.path,
    );
  }

  final int? statusCode;
  final String errorCode;
  final String message;
  final List<dynamic> errors;
  final String? path;
  final String? timestamp;

  static String _defaultCodeForType(DioExceptionType type, int? statusCode) {
    switch (type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.transformTimeout:
        return 'REQUEST_TIMEOUT';
      case DioExceptionType.connectionError:
        return 'NETWORK_UNAVAILABLE';
      case DioExceptionType.cancel:
        return 'REQUEST_CANCELLED';
      case DioExceptionType.badCertificate:
        return 'BAD_CERTIFICATE';
      case DioExceptionType.badResponse:
        if (statusCode == 401) return 'UNAUTHORIZED';
        if (statusCode == 403) return 'FORBIDDEN';
        if (statusCode == 503) return 'SERVICE_UNAVAILABLE';
        return 'HTTP_ERROR';
      case DioExceptionType.unknown:
        return 'UNKNOWN_ERROR';
    }
  }

  static String _defaultMessageForType(DioExceptionType type) {
    switch (type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.transformTimeout:
        return 'The request timed out. Please try again.';
      case DioExceptionType.connectionError:
        return 'Unable to reach the server. Check your network connection.';
      case DioExceptionType.cancel:
        return 'The request was cancelled.';
      case DioExceptionType.badCertificate:
        return 'Server certificate verification failed.';
      case DioExceptionType.badResponse:
        return 'The server returned an unexpected error response.';
      case DioExceptionType.unknown:
        return 'An unexpected network error occurred.';
    }
  }

  @override
  String toString() =>
      'ApiException(statusCode: $statusCode, errorCode: $errorCode, message: $message)';
}
