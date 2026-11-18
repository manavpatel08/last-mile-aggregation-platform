import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/features/auth/data/api_auth_repository.dart';

class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this._handler);

  final Future<ResponseBody> Function(RequestOptions options) _handler;
  RequestOptions? lastRequest;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    lastRequest = options;
    return _handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _jsonResponse(Map<String, dynamic> data, {int statusCode = 200}) {
  return ResponseBody.fromString(
    jsonEncode(data),
    statusCode,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );
}

void main() {
  const config = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  group('ApiAuthRepository', () {
    test('authenticateWithGoogle sends POST /auth/google and parses session', () async {
      final tokenStore = AuthTokenStore();
      late _FakeAdapter adapter;

      adapter = _FakeAdapter((options) async {
        expect(options.path, '/auth/google');
        expect(options.method, 'POST');
        final body = options.data as Map<String, dynamic>;
        expect(body['idToken'], 'google-id-token-abc');

        return _jsonResponse({
          'success': true,
          'data': {
            'user': {
              'id': 'user-1',
              'email': 'user@pdeu.ac.in',
              'fullName': 'User One',
              'role': 'PASSENGER',
              'roles': ['PASSENGER'],
            },
            'accessToken': 'jwt-access-token',
            'refreshToken': 'uuid-refresh-token',
            'expiresIn': 900,
          },
        });
      });

      final dio = Dio()..httpClientAdapter = adapter;
      final repo = ApiAuthRepository(
        config: config,
        tokenStore: tokenStore,
        unauthenticatedDio: dio,
      );

      final session = await repo.authenticateWithGoogle(
        idToken: 'google-id-token-abc',
      );

      expect(session.user.email, 'user@pdeu.ac.in');
      expect(session.accessToken, 'jwt-access-token');
      expect(session.refreshToken, 'uuid-refresh-token');
    });

    test('refreshSession sends POST /auth/refresh and parses result', () async {
      final tokenStore = AuthTokenStore();
      late _FakeAdapter adapter;

      adapter = _FakeAdapter((options) async {
        expect(options.path, '/auth/refresh');
        expect(options.method, 'POST');
        final body = options.data as Map<String, dynamic>;
        expect(body['refreshToken'], 'old-refresh-token');

        return _jsonResponse({
          'success': true,
          'data': {
            'accessToken': 'new-jwt-access-token',
            'refreshToken': 'new-uuid-refresh-token',
            'expiresIn': 900,
          },
        });
      });

      final dio = Dio()..httpClientAdapter = adapter;
      final repo = ApiAuthRepository(
        config: config,
        tokenStore: tokenStore,
        unauthenticatedDio: dio,
      );

      final result = await repo.refreshSession(
        refreshToken: 'old-refresh-token',
      );

      expect(result.accessToken, 'new-jwt-access-token');
      expect(result.refreshToken, 'new-uuid-refresh-token');
    });

    test('logout attaches Authorization header and calls POST /auth/logout', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'active-jwt-token', expiresInSeconds: 900);

      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.path, '/auth/logout');
        expect(options.method, 'POST');
        expect(
          options.headers['Authorization'],
          'Bearer active-jwt-token',
        );

        return _jsonResponse({'success': true, 'message': 'Logged out'});
      });

      final dio = Dio()..httpClientAdapter = adapter;
      final repo = ApiAuthRepository(
        config: config,
        tokenStore: tokenStore,
        unauthenticatedDio: dio,
      );

      await expectLater(repo.logout(), completes);
    });

    test('getCurrentUser calls GET /users/me with token and parses AuthUser', () async {
      final tokenStore = AuthTokenStore()
        ..setToken(accessToken: 'active-jwt-token', expiresInSeconds: 900);

      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.path, '/users/me');
        expect(options.method, 'GET');
        expect(
          options.headers['Authorization'],
          'Bearer active-jwt-token',
        );

        return _jsonResponse({
          'success': true,
          'data': {
            'id': 'user-123',
            'email': 'driver@pdeu.ac.in',
            'fullName': 'PDEU Driver',
            'role': 'DRIVER',
            'roles': ['DRIVER'],
            'driverProfile': {
              'id': 'dp-1',
              'verificationStatus': 'APPROVED',
              'operationalStatus': 'AVAILABLE',
              'isOnline': true,
            },
          },
        });
      });

      final dio = Dio()..httpClientAdapter = adapter;
      final repo = ApiAuthRepository(
        config: config,
        tokenStore: tokenStore,
        unauthenticatedDio: dio,
      );

      final user = await repo.getCurrentUser();
      expect(user.id, 'user-123');
      expect(user.isDriver, isTrue);
      expect(user.isApprovedDriver, isTrue);
    });

    test('maps 401 error response to ApiException', () async {
      final tokenStore = AuthTokenStore();
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse(
          {
            'statusCode': 401,
            'errorCode': 'UNAUTHORIZED',
            'message': 'Invalid credentials',
          },
          statusCode: 401,
        );
      });

      final dio = Dio()..httpClientAdapter = adapter;
      final repo = ApiAuthRepository(
        config: config,
        tokenStore: tokenStore,
        unauthenticatedDio: dio,
      );

      expect(
        () => repo.authenticateWithGoogle(idToken: 'bad-token'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 401)
              .having((e) => e.errorCode, 'errorCode', 'UNAUTHORIZED'),
        ),
      );
    });
  });
}
