import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_client.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/realtime/socket_ticket_provider.dart';

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

  group('ApiSocketTicketProvider', () {
    test('fetches single-use ticket with auth header from /auth/socket-ticket', () async {
      late _FakeHttpClientAdapter adapter;
      adapter = _FakeHttpClientAdapter((options) async {
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {
              'ticket': 'ticket-uuid-1234',
              'expiresIn': 60,
            },
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'test-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final provider = ApiSocketTicketProvider(apiClient: apiClient);
      final ticket = await provider.getTicket();

      expect(ticket.ticket, 'ticket-uuid-1234');
      expect(ticket.expiresIn, 60);
      expect(adapter.lastRequest?.path, '/auth/socket-ticket');
      expect(adapter.lastRequest?.headers['Authorization'], 'Bearer test-access-token');
    });

    test('propagates ApiException when backend returns 401 or error', () async {
      final adapter = _FakeHttpClientAdapter((options) async {
        return ResponseBody.fromString(
          jsonEncode({
            'statusCode': 401,
            'errorCode': 'UNAUTHORIZED',
            'message': 'Invalid session token',
          }),
          401,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'expired-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final provider = ApiSocketTicketProvider(apiClient: apiClient);

      expect(
        () => provider.getTicket(),
        throwsA(
          isA<ApiException>().having(
            (e) => e.statusCode,
            'statusCode',
            401,
          ),
        ),
      );
    });
  });
}
