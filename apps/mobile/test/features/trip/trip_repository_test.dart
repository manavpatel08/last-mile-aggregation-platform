import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_client.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/trip/data/api_trip_repository.dart';

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
    appEnv: 'test',
  );

  group('ApiTripRepository', () {
    test('getPassengerBoardingPass parses valid boarding pass payload',
        () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.path, '/bookings/book-123/boarding-pass');
        expect(options.method, 'GET');
        return _jsonResponse({
          'success': true,
          'data': {
            'bookingId': 'book-123',
            'passengerId': 'pass-456',
            'tripId': 'trip-789',
            'boardingOtp': '4821',
            'expiresAt': '2026-11-22T12:30:00.000Z',
            'bookingStatus': 'DRIVER_ASSIGNED',
            'driver': {
              'name': 'Ramesh Patel',
              'phoneNumber': '+919876543210',
              'vehicle': {
                'registrationNumber': 'GJ01AB1234',
                'makeModel': 'Mahindra Treo',
                'vehicleType': 'E_RICKSHAW',
              },
            },
          },
        });
      });

      final apiClient = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );
      final repo = ApiTripRepository(apiClient: apiClient);

      final pass = await repo.getPassengerBoardingPass('book-123');
      expect(pass.bookingId, 'book-123');
      expect(pass.passengerId, 'pass-456');
      expect(pass.tripId, 'trip-789');
      expect(pass.boardingOtp, '4821');
      expect(pass.bookingStatus, 'DRIVER_ASSIGNED');
      expect(pass.driver.name, 'Ramesh Patel');
      expect(pass.driver.phoneNumber, '+919876543210');
      expect(pass.driver.vehicle?.registrationNumber, 'GJ01AB1234');
      expect(pass.driver.vehicle?.makeModel, 'Mahindra Treo');
    });

    test('getPassengerBoardingPass throws ApiException on error response',
        () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse(
          {
            'success': false,
            'statusCode': 400,
            'errorCode': 'BOOKING_NOT_ASSIGNED',
            'message': 'Booking has not been assigned to a driver yet.',
          },
          statusCode: 400,
        );
      });

      final apiClient = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );
      final repo = ApiTripRepository(apiClient: apiClient);

      expect(
        () => repo.getPassengerBoardingPass('book-unassigned'),
        throwsA(isA<ApiException>().having(
          (e) => e.errorCode,
          'errorCode',
          'BOOKING_NOT_ASSIGNED',
        )),
      );
    });

    test('getTripDetails parses full trip manifest and passengers', () async {
      final adapter = _FakeAdapter((options) async {
        expect(options.path, '/trips/trip-789');
        expect(options.method, 'GET');
        return _jsonResponse({
          'success': true,
          'data': {
            'tripId': 'trip-789',
            'rideGroupId': 'grp-1',
            'activeDriverId': 'driver-99',
            'status': 'AT_PICKUP',
            'driverArrivedAt': '2026-11-22T10:00:00.000Z',
            'passengers': [
              {
                'id': 'tp-1',
                'passengerId': 'p-1',
                'bookingId': 'b-1',
                'status': 'ASSIGNED',
                'finalRideFarePaise': 3800,
                'waitingChargePaise': 0,
              },
              {
                'id': 'tp-2',
                'passengerId': 'p-2',
                'bookingId': 'b-2',
                'status': 'BOARDED',
                'finalRideFarePaise': 3800,
                'waitingChargePaise': 0,
                'boardedAt': '2026-11-22T10:02:00.000Z',
              },
            ],
          },
        });
      });

      final apiClient = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );
      final repo = ApiTripRepository(apiClient: apiClient);

      final trip = await repo.getTripDetails('trip-789');
      expect(trip.tripId, 'trip-789');
      expect(trip.status, 'AT_PICKUP');
      expect(trip.isAtPickup, isTrue);
      expect(trip.passengers.length, 2);
      expect(trip.passengers[0].status, 'ASSIGNED');
      expect(trip.passengers[1].status, 'BOARDED');
      expect(trip.passengers[1].isBoarded, isTrue);
    });

    test('arriveAtPickup sends Idempotency-Key and parses response', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.path, '/trips/trip-789/arrive-pickup');
        expect(options.method, 'POST');
        expect(options.headers['Idempotency-Key'], 'idem-arrive-key');
        return _jsonResponse({
          'success': true,
          'message': 'Driver arrival confirmed',
          'data': {
            'tripId': 'trip-789',
            'status': 'AT_PICKUP',
            'driverArrivedAt': '2026-11-22T10:05:00.000Z',
          },
        });
      });

      final apiClient = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );
      final repo = ApiTripRepository(apiClient: apiClient);

      final response = await repo.arriveAtPickup(
        tripId: 'trip-789',
        idempotencyKey: 'idem-arrive-key',
      );

      expect(response.tripId, 'trip-789');
      expect(response.status, 'AT_PICKUP');
      expect(response.driverArrivedAt, isNotNull);
    });

    test('verifyBoarding sends body and Idempotency-Key and parses success',
        () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.path, '/trips/trip-789/verify-boarding');
        expect(options.method, 'POST');
        expect(options.headers['Idempotency-Key'], 'idem-verify-key');
        final body = options.data as Map<String, dynamic>;
        expect(body['passengerId'], 'p-1');
        expect(body['otp'], '4821');

        return _jsonResponse({
          'success': true,
          'message': 'Passenger boarding verified',
          'data': {
            'passengerStatus': 'BOARDED',
            'waitingChargePaise': 0,
          },
        });
      });

      final apiClient = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );
      final repo = ApiTripRepository(apiClient: apiClient);

      final response = await repo.verifyBoarding(
        tripId: 'trip-789',
        passengerId: 'p-1',
        otp: '4821',
        idempotencyKey: 'idem-verify-key',
      );

      expect(response.success, isTrue);
      expect(response.passengerStatus, 'BOARDED');
      expect(response.waitingChargePaise, 0);
    });

    test('startTrip sends Idempotency-Key and parses response', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.path, '/trips/trip-789/start');
        expect(options.method, 'POST');
        expect(options.headers['Idempotency-Key'], 'idem-start-key');
        return _jsonResponse({
          'success': true,
          'message': 'Trip started',
          'data': {
            'tripId': 'trip-789',
            'status': 'IN_PROGRESS',
            'startedAt': '2026-11-22T10:10:00.000Z',
          },
        });
      });

      final apiClient = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );
      final repo = ApiTripRepository(apiClient: apiClient);

      final response = await repo.startTrip(
        tripId: 'trip-789',
        idempotencyKey: 'idem-start-key',
      );

      expect(response.tripId, 'trip-789');
      expect(response.status, 'IN_PROGRESS');
      expect(response.startedAt, isNotNull);
    });

    test('completePassengerDropOff sends Idempotency-Key and parses fare breakdown',
        () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.path, '/trips/trip-789/passengers/p-1/complete');
        expect(options.method, 'POST');
        expect(options.headers['Idempotency-Key'], 'idem-pass-key');
        return _jsonResponse({
          'success': true,
          'message': 'Passenger drop-off recorded',
          'data': {
            'passengerId': 'p-1',
            'status': 'COMPLETED',
            'rideFarePaise': 3800,
            'rideFare': '38.00',
            'waitingChargePaise': 500,
            'waitingCharge': '5.00',
            'totalCashToCollectPaise': 4300,
            'totalCashToCollect': '43.00',
          },
        });
      });

      final apiClient = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );
      final repo = ApiTripRepository(apiClient: apiClient);

      final response = await repo.completePassengerDropOff(
        tripId: 'trip-789',
        passengerId: 'p-1',
        idempotencyKey: 'idem-pass-key',
      );

      expect(response.passengerId, 'p-1');
      expect(response.status, 'COMPLETED');
      expect(response.rideFarePaise, 3800);
      expect(response.rideFare, '38.00');
      expect(response.waitingChargePaise, 500);
      expect(response.waitingCharge, '5.00');
      expect(response.totalCashToCollectPaise, 4300);
      expect(response.totalCashToCollect, '43.00');
    });

    test('completeTrip sends Idempotency-Key and parses final completion', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.path, '/trips/trip-789/complete');
        expect(options.method, 'POST');
        expect(options.headers['Idempotency-Key'], 'idem-complete-trip-key');
        return _jsonResponse({
          'success': true,
          'message': 'Trip marked as completed',
          'data': {
            'tripId': 'trip-789',
            'status': 'COMPLETED',
            'completedAt': '2026-11-22T10:30:00.000Z',
          },
        });
      });

      final apiClient = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );
      final repo = ApiTripRepository(apiClient: apiClient);

      final response = await repo.completeTrip(
        tripId: 'trip-789',
        idempotencyKey: 'idem-complete-trip-key',
      );

      expect(response.tripId, 'trip-789');
      expect(response.status, 'COMPLETED');
      expect(response.completedAt, isNotNull);
    });
  });
}
