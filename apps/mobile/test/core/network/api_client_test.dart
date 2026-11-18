import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_client.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';

class _FakeHttpClientAdapter implements HttpClientAdapter {
  _FakeHttpClientAdapter(this._handler);

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

void main() {
  const testConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  group('ApiClient', () {
    test(
      'configures baseUrl, JSON headers, auth header, and Idempotency-Key',
      () async {
        final adapter = _FakeHttpClientAdapter((options) async {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': {'ok': true}}),
            200,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          );
        });

        final client = ApiClient(
          config: testConfig,
          tokenProvider: () async => 'sample-jwt-token',
          httpClientAdapter: adapter,
          enableDebugLogging: false,
        );

        final response = await client.post<Map<String, dynamic>>(
          '/test-endpoint',
          data: {'ping': true},
          idempotencyKey: 'idem-123',
        );

        expect(response.statusCode, 200);
        expect(adapter.lastRequest?.baseUrl, 'http://localhost:3000/api/v1');
        expect(adapter.lastRequest?.path, '/test-endpoint');
        expect(
          adapter.lastRequest?.headers['Authorization'],
          'Bearer sample-jwt-token',
        );
        expect(adapter.lastRequest?.headers['Idempotency-Key'], 'idem-123');
        expect(adapter.lastRequest?.headers['Accept'], 'application/json');
      },
    );

    test('maps standard API error envelope into ApiException', () async {
      final adapter = _FakeHttpClientAdapter((options) async {
        return ResponseBody.fromString(
          jsonEncode({
            'success': false,
            'statusCode': 409,
            'errorCode': 'BOOKING_ALREADY_ACTIVE',
            'message': 'Passenger already has an active booking in progress.',
            'errors': [],
            'timestamp': '2026-11-18T12:00:00.000Z',
            'path': '/api/v1/bookings',
          }),
          409,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      final client = ApiClient(
        config: testConfig,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      await expectLater(
        () => client.get<Map<String, dynamic>>('/bookings'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 409)
              .having((e) => e.errorCode, 'errorCode', 'BOOKING_ALREADY_ACTIVE')
              .having(
                (e) => e.message,
                'message',
                'Passenger already has an active booking in progress.',
              )
              .having((e) => e.path, 'path', '/api/v1/bookings'),
        ),
      );
    });
  });
}
