import 'package:dio/dio.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/network/auth_token_store.dart';
import '../models/auth_session.dart';
import '../models/auth_user.dart';
import 'auth_repository.dart';

/// Concrete [AuthRepository] implementation communicating with backend NestJS API.
class ApiAuthRepository implements AuthRepository {
  ApiAuthRepository({
    required AppConfig config,
    required this.tokenStore,
    Dio? unauthenticatedDio,
  }) : _dio = unauthenticatedDio ??
            Dio(
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
            );

  final AuthTokenStore tokenStore;
  final Dio _dio;

  @override
  Future<AuthSession> authenticateWithGoogle({
    required String idToken,
    String? deviceFingerprint,
  }) async {
    try {
      final payload = <String, dynamic>{
        'idToken': idToken,
        if (deviceFingerprint != null && deviceFingerprint.isNotEmpty)
          'deviceFingerprint': deviceFingerprint,
      };

      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/google',
        data: payload,
      );

      final data = response.data?['data'];
      if (data is! Map<String, dynamic>) {
        throw const ApiException(
          errorCode: 'INVALID_AUTH_RESPONSE',
          message: 'Malformed response received during Google authentication.',
        );
      }

      return AuthSession.fromJson(data);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  @override
  Future<RefreshSessionResult> refreshSession({
    required String refreshToken,
    String? deviceFingerprint,
  }) async {
    try {
      final payload = <String, dynamic>{
        'refreshToken': refreshToken,
        if (deviceFingerprint != null && deviceFingerprint.isNotEmpty)
          'deviceFingerprint': deviceFingerprint,
      };

      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/refresh',
        data: payload,
      );

      final data = response.data?['data'];
      if (data is! Map<String, dynamic>) {
        throw const ApiException(
          errorCode: 'INVALID_REFRESH_RESPONSE',
          message: 'Malformed response received during session refresh.',
        );
      }

      return RefreshSessionResult.fromJson(data);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }

  @override
  Future<void> logout() async {
    try {
      final token = tokenStore.accessToken;
      final options = Options(
        headers: {
          if (token != null && token.isNotEmpty)
            'Authorization': 'Bearer $token',
        },
      );

      await _dio.post<Map<String, dynamic>>(
        '/auth/logout',
        options: options,
      );
    } on DioException catch (e) {
      // Best-effort logout; still propagate normalized exception for caller insight
      throw ApiException.fromDioException(e);
    }
  }

  @override
  Future<AuthUser> getCurrentUser() async {
    try {
      final token = tokenStore.accessToken;
      final options = Options(
        headers: {
          if (token != null && token.isNotEmpty)
            'Authorization': 'Bearer $token',
        },
      );

      final response = await _dio.get<Map<String, dynamic>>(
        '/users/me',
        options: options,
      );

      final data = response.data?['data'];
      if (data is! Map<String, dynamic>) {
        throw const ApiException(
          errorCode: 'INVALID_USER_PROFILE',
          message: 'Malformed profile received from /users/me.',
        );
      }

      return AuthUser.fromJson(data);
    } on DioException catch (e) {
      throw ApiException.fromDioException(e);
    }
  }
}
