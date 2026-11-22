import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_client.dart';
import 'package:lastmile_mobile/core/realtime/models/sync_models.dart';
import 'package:lastmile_mobile/core/realtime/sync_repository.dart';

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

  group('ApiSyncRepository', () {
    test('calls POST /sync with auth and parses passenger sync response', () async {
      late _FakeHttpClientAdapter adapter;
      adapter = _FakeHttpClientAdapter((options) async {
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'serverTimestamp': '2026-11-22T12:00:00.000Z',
            'role': 'PASSENGER',
            'reconciled': true,
            'passengerState': {
              'activeBooking': {
                'id': 'booking-1',
                'status': 'CONFIRMED',
                'passengerId': 'passenger-1',
                'pickupPointId': 'point-1',
                'fareQuotePaise': 3500,
                'createdAt': '2026-11-22T11:00:00.000Z',
                'updatedAt': '2026-11-22T11:05:00.000Z',
                'entityVersion': 2,
              },
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
        tokenProvider: () async => 'test-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repo = ApiSyncRepository(apiClient: apiClient);
      final response = await repo.syncState(
        const SyncRequestDto(activeBookingId: 'booking-1', lastKnownEntityVersion: 1),
      );

      expect(response.success, isTrue);
      expect(response.role, 'PASSENGER');
      expect(response.reconciled, isTrue);
      expect(response.passengerState?.activeBooking?.id, 'booking-1');
      expect(adapter.lastRequest?.path, '/sync');
      expect(adapter.lastRequest?.method, 'POST');
      expect(adapter.lastRequest?.headers['Authorization'], 'Bearer test-token');
      expect(adapter.lastRequest?.data, {
        'lastKnownEntityVersion': 1,
        'activeBookingId': 'booking-1',
      });
    });
  });
}
