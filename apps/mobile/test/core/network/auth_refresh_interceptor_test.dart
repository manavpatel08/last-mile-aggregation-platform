import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_refresh_interceptor.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/network/dio_interceptors.dart';
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
    test(
      'Protected 401 triggers exactly one refresh and one retry',
      () async {
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
            expect(
              options.headers['Authorization'],
              'Bearer initial-expired-token',
            );
            return _res({'statusCode': 401, 'message': 'Token expired'}, 401);
          } else {
            expect(
              options.headers['Authorization'],
              'Bearer refreshed-jwt-token',
            );
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
      },
    );

    test(
      'coordinates concurrent 401s in single-flight without duplicate refresh calls',
      () async {
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

        final results = await Future.wait([
          dio.get(
            '/rides/1',
            options: Options(headers: {'Authorization': 'Bearer expired-token'}),
          ),
          dio.get(
            '/rides/2',
            options: Options(headers: {'Authorization': 'Bearer expired-token'}),
          ),
          dio.get(
            '/rides/3',
            options: Options(headers: {'Authorization': 'Bearer expired-token'}),
          ),
        ]);

        for (final res in results) {
          expect(res.statusCode, 200);
        }

        expect(repo.refreshCallCount, 1);
        expect(callCount, 6);
        expect(tokenStore.accessToken, 'shared-rotated-token');
        expect(await secureStorage.getRefreshToken(), 'shared-rotated-refresh');
      },
    );

    test(
      'Definitively invalid refresh token (401) clears credentials and triggers onSessionExpired',
      () async {
        final tokenStore = AuthTokenStore()
          ..setToken(accessToken: 'expired-token', expiresInSeconds: 900);
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'revoked-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            statusCode: 401,
            errorCode: 'UNAUTHORIZED',
            message: 'Invalid refresh token',
          ),
        );

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
          dio.get(
            '/users/profile',
            options: Options(headers: {'Authorization': 'Bearer expired-token'}),
          ),
          throwsA(isA<DioException>()),
        );

        expect(sessionExpiredFired, isTrue);
        expect(tokenStore.accessToken, isNull);
        expect(await secureStorage.getRefreshToken(), isNull);
      },
    );

    test(
      'Automatic refresh during a network failure preserves the refresh token',
      () async {
        final tokenStore = AuthTokenStore()
          ..setToken(accessToken: 'expired-token', expiresInSeconds: 900);
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'preserve-me-refresh-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            errorCode: 'NETWORK_UNAVAILABLE',
            message: 'Unable to reach the server. Check your network connection.',
          ),
        );

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
          dio.get(
            '/bookings/active',
            options: Options(headers: {'Authorization': 'Bearer expired-token'}),
          ),
          throwsA(isA<DioException>()),
        );

        // Network failure must NOT wipe the refresh token or expire the session!
        expect(sessionExpiredFired, isFalse);
        expect(
          await secureStorage.getRefreshToken(),
          'preserve-me-refresh-token',
        );
      },
    );

    test(
      'Automatic refresh during a temporary 5xx preserves the refresh token',
      () async {
        final tokenStore = AuthTokenStore()
          ..setToken(accessToken: 'expired-token', expiresInSeconds: 900);
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'preserve-on-503-token',
        });
        final repo = FakeAuthRepository(
          refreshException: const ApiException(
            statusCode: 503,
            errorCode: 'SERVICE_UNAVAILABLE',
            message: 'Database temporarily unavailable',
          ),
        );

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
          dio.get(
            '/bookings/active',
            options: Options(headers: {'Authorization': 'Bearer expired-token'}),
          ),
          throwsA(isA<DioException>()),
        );

        // 5xx error must NOT wipe the refresh token or trigger session expiration!
        expect(sessionExpiredFired, isFalse);
        expect(
          await secureStorage.getRefreshToken(),
          'preserve-on-503-token',
        );
      },
    );

    test(
      'Successful token rotation persists the refresh token before publishing the access token',
      () async {
        final tokenStore = AuthTokenStore()
          ..setToken(accessToken: 'expired-token', expiresInSeconds: 900);
        final secureStorage = SecureTokenStorage.inMemory({
          SecureTokenStorage.refreshTokenKey: 'old-refresh-token',
        });

        bool secureStorageSavedBeforeAccessTokenPublished = false;

        final repo = FakeAuthRepository(
          refreshResult: const RefreshSessionResult(
            accessToken: 'brand-new-access-token',
            refreshToken: 'brand-new-refresh-token',
            expiresIn: 900,
          ),
          onRefreshSession: () async {
            // While backend is working, tokenStore still holds old or no new token
            expect(tokenStore.accessToken, 'expired-token');
          },
        );

        final dio = Dio();
        dio.httpClientAdapter = _MockAdapter((options) async {
          if (options.headers['Authorization'] == 'Bearer expired-token') {
            return _res({'statusCode': 401}, 401);
          }
          // When retried with brand-new-access-token, verify refresh token is already persisted
          if (options.headers['Authorization'] == 'Bearer brand-new-access-token') {
            final stored = await secureStorage.getRefreshToken();
            if (stored == 'brand-new-refresh-token') {
              secureStorageSavedBeforeAccessTokenPublished = true;
            }
            return _res({'success': true}, 200);
          }
          return _res({'statusCode': 400}, 400);
        });

        final interceptor = AuthRefreshInterceptor(
          dio: dio,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
          authRepository: repo,
        );
        dio.interceptors.add(interceptor);

        final response = await dio.get<Map<String, dynamic>>(
          '/rides/active',
          options: Options(headers: {'Authorization': 'Bearer expired-token'}),
        );

        expect(response.statusCode, 200);
        expect(secureStorageSavedBeforeAccessTokenPublished, isTrue);
        expect(tokenStore.accessToken, 'brand-new-access-token');
        expect(await secureStorage.getRefreshToken(), 'brand-new-refresh-token');
      },
    );

    test(
      'Secure-storage write failure does not leave a partially active session',
      () async {
        final tokenStore = AuthTokenStore()
          ..setToken(accessToken: 'expired-token', expiresInSeconds: 900);
        final failingStorage = FailingSecureTokenStorage(
          failOnSave: true,
          initialData: {
            SecureTokenStorage.refreshTokenKey: 'old-refresh-token',
          },
        );
        final repo = FakeAuthRepository(
          refreshResult: const RefreshSessionResult(
            accessToken: 'rotated-access',
            refreshToken: 'rotated-refresh',
            expiresIn: 900,
          ),
        );

        bool sessionExpiredFired = false;
        final dio = Dio();
        dio.httpClientAdapter = _MockAdapter((options) async {
          return _res({'statusCode': 401}, 401);
        });

        final interceptor = AuthRefreshInterceptor(
          dio: dio,
          tokenStore: tokenStore,
          secureStorage: failingStorage,
          authRepository: repo,
          onSessionExpired: () {
            sessionExpiredFired = true;
          },
        );
        dio.interceptors.add(interceptor);

        await expectLater(
          dio.get(
            '/rides/active',
            options: Options(headers: {'Authorization': 'Bearer expired-token'}),
          ),
          throwsA(isA<DioException>()),
        );

        // Access token must NOT be published in tokenStore
        expect(tokenStore.accessToken, isNull);
        expect(sessionExpiredFired, isTrue);
      },
    );

    test('Public 401 does not trigger refresh', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'some-access-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'valid-refresh-token',
      });
      final repo = FakeAuthRepository();

      final dio = Dio();
      dio.httpClientAdapter = _MockAdapter((options) async {
        return _res({'statusCode': 401, 'message': 'Public auth failure'}, 401);
      });

      final interceptor = AuthRefreshInterceptor(
        dio: dio,
        tokenStore: tokenStore,
        secureStorage: secureStorage,
        authRepository: repo,
      );
      dio.interceptors.add(interceptor);

      // 1. Explicitly public request via metadata
      await expectLater(
        dio.get(
          '/pricing/estimate',
          options: Options(
            extra: {RequestMetadata.requiresAuth: false},
          ),
        ),
        throwsA(isA<DioException>()),
      );

      // 2. Request without Authorization header and without requiresAuth: true
      await expectLater(
        dio.get('/public/info'),
        throwsA(isA<DioException>()),
      );

      // Refresh must NOT be triggered for public endpoints
      expect(repo.refreshCallCount, 0);
      expect(tokenStore.accessToken, 'some-access-token');
      expect(await secureStorage.getRefreshToken(), 'valid-refresh-token');
    });

    test('403 from a protected endpoint preserves refresh token and does not trigger refresh', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'active-access-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'my-stored-refresh-token',
      });
      final repo = FakeAuthRepository();

      bool sessionExpiredFired = false;
      final dio = Dio();
      dio.httpClientAdapter = _MockAdapter((options) async {
        return _res({'statusCode': 403, 'message': 'Forbidden'}, 403);
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
        dio.get(
          '/admin/stats',
          options: Options(headers: {'Authorization': 'Bearer active-access-token'}),
        ),
        throwsA(isA<DioException>()),
      );

      // 403 Forbidden must NEVER trigger refresh, must NEVER expire session, and must preserve tokens
      expect(repo.refreshCallCount, 0);
      expect(sessionExpiredFired, isFalse);
      expect(await secureStorage.getRefreshToken(), 'my-stored-refresh-token');
      expect(tokenStore.accessToken, 'active-access-token');
    });

    test('403 from refresh endpoint preserves refresh token and does not call onSessionExpired', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'expired-token', expiresInSeconds: 900);
      final secureStorage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'preserve-on-403-token',
      });
      final repo = FakeAuthRepository(
        refreshException: const ApiException(
          statusCode: 403,
          errorCode: 'FORBIDDEN',
          message: 'Account access forbidden',
        ),
      );

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
        dio.get(
          '/rides/active',
          options: Options(headers: {'Authorization': 'Bearer expired-token'}),
        ),
        throwsA(isA<DioException>()),
      );

      // 403 indicates permission/status denial, NOT session invalidation -> MUST preserve refresh token!
      expect(sessionExpiredFired, isFalse);
      expect(await secureStorage.getRefreshToken(), 'preserve-on-403-token');
    });

    test('Authentication endpoints do not trigger refresh', () async {
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
      await expectLater(
        dio.post('/auth/refresh'),
        throwsA(isA<DioException>()),
      );
      await expectLater(
        dio.post('/auth/logout'),
        throwsA(isA<DioException>()),
      );

      expect(repo.refreshCallCount, 0);
    });
  });
}
