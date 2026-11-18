import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/network/auth_refresh_interceptor.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_session.dart';

import '../../helpers/test_fakes.dart';

class _MockAdapter implements HttpClientAdapter {
  _MockAdapter(this.handler);

  final Future<ResponseBody> Function(RequestOptions options) handler;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _res(Map<String, dynamic> data, int statusCode) {
  return ResponseBody.fromString(
    jsonEncode(data),
    statusCode,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );
}

void main() {
  group('AuthRefreshInterceptor', () {
    test('intercepts 401, calls refresh once, saves new tokens, and retries request', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'initial-expired-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'valid-refresh-token',
      });
      final repo = FakeAuthRepository(
        refreshResult: const RefreshSessionResult(
          accessToken: 'refreshed-jwt-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 900,
        ),
      );

      int attempts = 0;
      final dio = Dio();
      dio.httpClientAdapter = _MockAdapter((options) async {
        attempts++;
        if (attempts == 1) {
          // First attempt fails with 401
          expect(options.headers['Authorization'], 'Bearer initial-expired-token');
          return _res({'statusCode': 401, 'message': 'Token expired'}, 401);
        } else {
          // Retried attempt succeeds with new token
          expect(options.headers['Authorization'], 'Bearer refreshed-jwt-token');
          return _res({'success': true, 'data': 'protected-data'}, 200);
        }
      });

      final interceptor = AuthRefreshInterceptor(
        dio: dio,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
        authRepository: repo,
      );
      dio.interceptors.add(interceptor);

      final response = await dio.get<Map<String, dynamic>>(
        '/bookings/active',
        options: Options(
          headers: {'Authorization': 'Bearer initial-expired-token'},
        ),
      );

      expect(response.statusCode, 200);
      expect(response.data?['data'], 'protected-data');
      expect(repo.refreshCallCount, 1);
      expect(tokenStore.accessToken, 'refreshed-jwt-token');
      expect(await secureStorage.getRefreshToken(), 'rotated-refresh-token');
      expect(attempts, 2);
    });

    test('coordinates concurrent 401s in single-flight without duplicate refresh calls', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'expired-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'refresh-token',
      });
      final repo = FakeAuthRepository(
        refreshResult: const RefreshSessionResult(
          accessToken: 'shared-rotated-token',
          refreshToken: 'shared-rotated-refresh',
          expiresIn: 900,
        ),
      );

      final dio = Dio();
      int callCount = 0;
      dio.httpClientAdapter = _MockAdapter((options) async {
        callCount++;
        final authHeader = options.headers['Authorization'];
        if (authHeader == 'Bearer expired-token') {
          return _res({'statusCode': 401}, 401);
        }
        return _res({'success': true, 'path': options.path}, 200);
      });

      final interceptor = AuthRefreshInterceptor(
        dio: dio,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
        authRepository: repo,
      );
      dio.interceptors.add(interceptor);

      // Launch 3 simultaneous requests that all hit 401
      final results = await Future.wait([
        dio.get('/rides/1', options: Options(headers: {'Authorization': 'Bearer expired-token'})),
        dio.get('/rides/2', options: Options(headers: {'Authorization': 'Bearer expired-token'})),
        dio.get('/rides/3', options: Options(headers: {'Authorization': 'Bearer expired-token'})),
      ]);

      for (final res in results) {
        expect(res.statusCode, 200);
      }

      // Exactly ONE refresh call occurred across all 3 concurrent 401s!
      expect(repo.refreshCallCount, 1);
      expect(callCount, 6);
      expect(tokenStore.accessToken, 'shared-rotated-token');
      expect(await secureStorage.getRefreshToken(), 'shared-rotated-refresh');
    });

    test('when refresh fails, clears credentials and triggers onSessionExpired', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'expired-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'bad-refresh-token',
      });
      final repo = FakeAuthRepository(shouldThrowOnRefresh: true);

      bool sessionExpiredFired = false;
      final dio = Dio();
      dio.httpClientAdapter = _MockAdapter((options) async {
        return _res({'statusCode': 401}, 401);
      });

      final interceptor = AuthRefreshInterceptor(
        dio: dio,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
        authRepository: repo,
        onSessionExpired: () {
          sessionExpiredFired = true;
        },
      );
      dio.interceptors.add(interceptor);

      await expectLater(
        dio.get('/users/profile'),
        throwsA(isA<DioException>()),
      );

      expect(sessionExpiredFired, isTrue);
      expect(tokenStore.accessToken, isNull);
      expect(await secureStorage.getRefreshToken(), isNull);
    });

    test('does NOT attempt refresh on 403 Forbidden', () async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'refresh-token',
      });
      final repo = FakeAuthRepository();

      final dio = Dio();
      dio.httpClientAdapter = _MockAdapter((options) async {
        return _res({'statusCode': 403, 'message': 'Forbidden'}, 403);
      });

      final interceptor = AuthRefreshInterceptor(
        dio: dio,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
        authRepository: repo,
      );
      dio.interceptors.add(interceptor);

      await expectLater(
        dio.get('/admin/stats'),
        throwsA(isA<DioException>()),
      );

      expect(repo.refreshCallCount, 0);
    });

    test('does NOT attempt refresh on /auth endpoints', () async {
      final tokenStore = AuthTokenStore();
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'refresh-token',
      });
      final repo = FakeAuthRepository();

      final dio = Dio();
      dio.httpClientAdapter = _MockAdapter((options) async {
        return _res({'statusCode': 401, 'message': 'Unauthorized'}, 401);
      });

      final interceptor = AuthRefreshInterceptor(
        dio: dio,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
        authRepository: repo,
      );
      dio.interceptors.add(interceptor);

      await expectLater(
        dio.post('/auth/google'),
        throwsA(isA<DioException>()),
      );

      expect(repo.refreshCallCount, 0);
    });
  });
}
