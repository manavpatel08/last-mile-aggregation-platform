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

    test('updateStatus sends PATCH request to /drivers/status with isOnline and returns DriverStatusResponse', () async {
      final adapter = _FakeAdapter((options) async {
        expect(options.method, 'PATCH');
        expect(options.path, '/drivers/status');
        expect(options.headers['Authorization'], 'Bearer driver-access-token');

        final body = options.data as Map<String, dynamic>;
        expect(body['isOnline'], true);

        return _jsonResponse({
          'success': true,
          'message': 'Driver operational status updated successfully',
          'data': {
            'id': 'dp-123',
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
      final response = await repository.updateStatus(isOnline: true);

      expect(response.id, 'dp-123');
      expect(response.verificationStatus, 'APPROVED');
      expect(response.operationalStatus, 'AVAILABLE');
      expect(response.isOnline, isTrue);
    });

    test('updateStatus maps 409 Conflict to ApiException', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': false,
          'statusCode': 409,
          'errorCode': 'CONFLICT',
          'message': 'Cannot go offline while driver has an active or reserved assignment',
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
        repository.updateStatus(isOnline: false),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 409)
              .having((e) => e.message, 'message', contains('Cannot go offline')),
        ),
      );
    });

    test('reportLocation sends POST request to /drivers/location with coordinates and heading', () async {
      final adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        expect(options.path, '/drivers/location');
        expect(options.headers['Authorization'], 'Bearer driver-access-token');

        final body = options.data as Map<String, dynamic>;
        expect(body['latitude'], 23.1550);
        expect(body['longitude'], 72.6668);
        expect(body['heading'], 180.5);
        expect(body['speed'], 25.0);

        return _jsonResponse({
          'success': true,
          'message': 'Driver location recorded successfully',
          'data': {
            'driverId': 'dp-123',
            'latitude': 23.1550,
            'longitude': 72.6668,
            'heading': 180.5,
            'speed': 25.0,
            'updatedAt': '2026-11-21T18:00:00.000Z',
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
      await repository.reportLocation(
        latitude: 23.1550,
        longitude: 72.6668,
        heading: 180.5,
        speed: 25.0,
      );

      expect(adapter.lastRequest, isNotNull);
    });

    test('getPendingOffers sends GET request to /drivers/offers/pending and parses multiple offers', () async {
      final adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/drivers/offers/pending');
        expect(options.headers['Authorization'], 'Bearer driver-access-token');

        return _jsonResponse({
          'success': true,
          'data': [
            {
              'offerId': 'off-1',
              'dispatchAttemptId': 'att-1',
              'rideGroupId': 'grp-1',
              'groupVersion': 1,
              'pickupPoint': {
                'id': 'pnt-1',
                'name': 'PDEU Gate 1',
              },
              'passengerCount': 2,
              'totalEstimatedFare': '32.00',
              'totalDistanceMeters': 1800,
              'totalDurationSec': 240,
              'offeredAt': '2026-11-21T18:00:00.000Z',
              'expiresAt': '2026-11-21T18:00:20.000Z',
              'remainingSeconds': 18,
            },
            {
              'offerId': 'off-2',
              'dispatchAttemptId': 'att-2',
              'rideGroupId': 'grp-2',
              'groupVersion': 1,
              'pickupPoint': {
                'id': 'pnt-2',
                'name': 'PDEU High-Rise Gate',
              },
              'passengerCount': 3,
              'totalEstimatedFare': '48.00',
              'totalDistanceMeters': 2400,
              'totalDurationSec': 320,
              'offeredAt': '2026-11-21T18:00:05.000Z',
              'expiresAt': '2026-11-21T18:00:25.000Z',
              'remainingSeconds': 20,
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
      final offers = await repository.getPendingOffers();

      expect(offers.length, 2);
      expect(offers[0].offerId, 'off-1');
      expect(offers[0].pickupPoint.name, 'PDEU Gate 1');
      expect(offers[0].passengerCount, 2);
      expect(offers[0].totalEstimatedFare, '32.00');
      expect(offers[1].offerId, 'off-2');
      expect(offers[1].pickupPoint.name, 'PDEU High-Rise Gate');
    });

    test('getPendingOffers throws ApiException when item is malformed', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': [
            {'malformed': 'offer'},
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

      await expectLater(
        repository.getPendingOffers(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.errorCode, 'errorCode', 'INVALID_RESPONSE')
              .having((e) => e.message, 'message', contains('Malformed offer item')),
        ),
      );
    });

    test('acceptOffer sends POST request with Idempotency-Key and returns AcceptOfferResponse', () async {
      final adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        expect(options.path, '/drivers/offers/off-123/accept');
        expect(options.headers['Authorization'], 'Bearer driver-access-token');
        expect(options.headers['Idempotency-Key'], 'idemp-uuid-1234');

        return _jsonResponse({
          'success': true,
          'data': {
            'assignmentId': 'asgn-456',
            'tripId': 'trip-789',
            'rideGroupId': 'grp-123',
            'passengerCount': 3,
            'totalEstimatedFare': '48.00',
            'navigationRoute': {
              'geometry': {'type': 'LineString'},
              'stops': [
                {
                  'stopOrder': 1,
                  'stopType': 'PICKUP',
                  'latitude': 23.1550,
                  'longitude': 72.6668,
                },
                {
                  'stopOrder': 2,
                  'stopType': 'DROPOFF',
                  'latitude': 23.1600,
                  'longitude': 72.6700,
                },
              ],
            },
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
      final response = await repository.acceptOffer(
        offerId: 'off-123',
        idempotencyKey: 'idemp-uuid-1234',
      );

      expect(response.assignmentId, 'asgn-456');
      expect(response.tripId, 'trip-789');
      expect(response.rideGroupId, 'grp-123');
      expect(response.passengerCount, 3);
      expect(response.totalEstimatedFare, '48.00');
      expect(response.navigationRoute.stops.length, 2);
    });

    test('acceptOffer maps 409 OFFER_EXPIRED error to ApiException', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': false,
          'statusCode': 409,
          'errorCode': 'OFFER_EXPIRED',
          'message': 'Offer has expired',
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
        repository.acceptOffer(
          offerId: 'off-123',
          idempotencyKey: 'idemp-uuid-1234',
        ),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 409)
              .having((e) => e.errorCode, 'errorCode', 'OFFER_EXPIRED'),
        ),
      );
    });

    test('rejectOffer sends POST request with Idempotency-Key and optional reason', () async {
      final adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        expect(options.path, '/drivers/offers/off-123/reject');
        expect(options.headers['Authorization'], 'Bearer driver-access-token');
        expect(options.headers['Idempotency-Key'], 'idemp-uuid-5678');

        final body = options.data as Map<String, dynamic>;
        expect(body['reason'], 'Taking a lunch break');

        return _jsonResponse({
          'success': true,
          'message': 'Offer rejected successfully',
        });
      });

      final apiClient = ApiClient(
        config: testConfig,
        tokenProvider: () async => 'driver-access-token',
        httpClientAdapter: adapter,
        enableDebugLogging: false,
      );

      final repository = ApiDriverRepository(apiClient: apiClient);
      await repository.rejectOffer(
        offerId: 'off-123',
        idempotencyKey: 'idemp-uuid-5678',
        reason: 'Taking a lunch break',
      );

      expect(adapter.lastRequest, isNotNull);
    });

    test('rejectOffer maps 409 OFFER_NOT_PENDING error to ApiException', () async {
      final adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': false,
          'statusCode': 409,
          'errorCode': 'OFFER_NOT_PENDING',
          'message': 'Offer cannot be rejected in status WITHDRAWN',
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
        repository.rejectOffer(
          offerId: 'off-123',
          idempotencyKey: 'idemp-uuid-5678',
        ),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 409)
              .having((e) => e.errorCode, 'errorCode', 'OFFER_NOT_PENDING'),
        ),
      );
    });
  });
}
