import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_client.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/driver/data/api_driver_repository.dart';
import 'package:lastmile_mobile/features/driver/models/driver_onboarding_request.dart';

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
  const testConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const testRequest = DriverOnboardingRequest(
    licenseNumber: 'GJ-01-2023-0012345',
    vehicle: VehicleDetails(
      registrationNumber: 'GJ-01-AA-1234',
      vehicleType: 'E_RICKSHAW',
      passengerCapacity: 4,
      makeModel: 'Mahindra Treo',
    ),
  );

  group('ApiDriverRepository', () {
    test('onboardDriver sends POST request with exact payload and auth header', () async {
      late _FakeAdapter adapter;

      adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        // When baseUrl has /api/v1, path is /drivers/onboard
        expect(options.path, '/drivers/onboard');
        expect(options.headers['Authorization'], 'Bearer driver-access-token');

        final body = options.data as Map<String, dynamic>;
        expect(body['licenseNumber'], 'GJ-01-2023-0012345');
        expect(body['vehicle']['registrationNumber'], 'GJ-01-AA-1234');
        expect(body['vehicle']['vehicleType'], 'E_RICKSHAW');
        expect(body['vehicle']['passengerCapacity'], 4);
        expect(body['vehicle']['makeModel'], 'Mahindra Treo');

        return _jsonResponse({
          'success': true,
          'message': 'Driver onboarding application submitted successfully',
          'data': {
            'driverProfile': {
              'id': 'dp-123',
              'userId': 'usr-456',
              'licenseNumber': 'GJ-01-2023-0012345',
              'verificationStatus': 'PENDING',
              'operationalStatus': 'OFFLINE',
              'isOnline': false,
            },
            'vehicle': {
              'id': 'veh-789',
              'registrationNumber': 'GJ-01-AA-1234',
              'vehicleType': 'E_RICKSHAW',
              'passengerCapacity': 4,
              'makeModel': 'Mahindra Treo',
              'isActive': true,
            },
          },
        }, statusCode: 201);
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);
      final response = await repository.onboardDriver(testRequest);

      expect(response.driverProfile.id, 'dp-123');
      expect(response.driverProfile.verificationStatus, 'PENDING');
      expect(response.driverProfile.operationalStatus, 'OFFLINE');
      expect(response.vehicle['registrationNumber'], 'GJ-01-AA-1234');
    });

    test('onboardDriver maps 409 Conflict error to ApiException', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': false,
          'statusCode': 409,
          'errorCode': 'CONFLICT',
          'message': 'Driver profile already registered for this user',
        }, statusCode: 409);
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);

      await expectLater(
        repository.onboardDriver(testRequest),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 409)
              .having((e) => e.errorCode, 'errorCode', 'CONFLICT')
              .having((e) => e.message, 'message', contains('already registered')),
        ),
      );
    });

    test('getDriverStatus sends GET request to /drivers/status with auth header', () async {
      final adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/drivers/status');
        expect(options.headers['Authorization'], 'Bearer driver-access-token');

        return _jsonResponse({
          'success': true,
          'data': {
            'id': 'dp-999',
            'verificationStatus': 'APPROVED',
            'operationalStatus': 'AVAILABLE',
            'isOnline': true,
            'vehiclesCount': 1,
          },
        });
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);
      final status = await repository.getDriverStatus();

      expect(status.id, 'dp-999');
      expect(status.verificationStatus, 'APPROVED');
      expect(status.operationalStatus, 'AVAILABLE');
      expect(status.isOnline, isTrue);
      expect(status.vehiclesCount, 1);
    });

    test('getDriverStatus throws ApiException on malformed status payload', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': {
            'id': 'dp-999',
            'verificationStatus': null, // missing required string
          },
        });
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);

      await expectLater(
        repository.getDriverStatus(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.errorCode, 'errorCode', 'INVALID_RESPONSE')
              .having((e) => e.message, 'message', contains('Malformed driver status response')),
        ),
      );
    });

    test('getDriverStatus maps 403 Forbidden to ApiException', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': false,
          'statusCode': 403,
          'errorCode': 'FORBIDDEN',
          'message': 'Driver operational status is not approved (current status: PENDING)',
        }, statusCode: 403);
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);

      await expectLater(
        repository.getDriverStatus(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 403)
              .having((e) => e.errorCode, 'errorCode', 'FORBIDDEN')
              .having((e) => e.message, 'message', contains('not approved')),
        ),
      );
    });

    test('getVehicles sends GET request to /drivers/vehicles with auth header', () async {
      final adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/drivers/vehicles');
        expect(options.headers['Authorization'], 'Bearer driver-access-token');

        return _jsonResponse({
          'success': true,
          'data': [
            {
              'id': 'veh-1',
              'driverProfileId': 'dp-999',
              'registrationNumber': 'GJ-01-AB-1234',
              'vehicleType': 'E_RICKSHAW',
              'passengerCapacity': 4,
              'makeModel': 'Mahindra Treo',
              'isActive': true,
              'createdAt': '2026-11-20T10:00:00.000Z',
            },
            {
              'id': 'veh-2',
              'driverProfileId': 'dp-999',
              'registrationNumber': 'GJ-01-CD-5678',
              'vehicleType': 'E_AUTO',
              'passengerCapacity': 3,
              'makeModel': 'Bajaj RE',
              'isActive': false,
            },
          ],
        });
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);
      final vehicles = await repository.getVehicles();

      expect(vehicles.length, 2);
      expect(vehicles[0].registrationNumber, 'GJ-01-AB-1234');
      expect(vehicles[0].isActive, isTrue);
      expect(vehicles[1].registrationNumber, 'GJ-01-CD-5678');
      expect(vehicles[1].isActive, isFalse);
    });

    test('getVehicles returns empty list when backend returns empty array', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': [],
        });
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);
      final vehicles = await repository.getVehicles();

      expect(vehicles, isEmpty);
    });

    test('getVehicles throws ApiException when response data is not a list', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': {'not': 'a list'},
        });
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);

      await expectLater(
        repository.getVehicles(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.errorCode, 'errorCode', 'INVALID_RESPONSE')
              .having((e) => e.message, 'message', contains('Invalid vehicles list structure')),
        ),
      );
    });
  });
}
