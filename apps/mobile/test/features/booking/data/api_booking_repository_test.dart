import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_client.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/booking/data/api_booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_request.dart';

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

  group('ApiBookingRepository', () {
    test('getPickupZones parses list of transit pickup hubs', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/locations/pickup-zones');
        return _jsonResponse({
          'success': true,
          'data': [
            {
              'id': 'hub-1',
              'name': 'PDEU Main Gate',
              'serviceZoneId': 'zone-1',
              'radiusMeters': 150,
              'latitude': 23.1550,
              'longitude': 72.6668,
              'isActive': true,
            },
          ],
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      final zones = await repo.getPickupZones();
      expect(zones.length, 1);
      expect(zones.first.name, 'PDEU Main Gate');
      expect(zones.first.radiusMeters, 150.0);
    });

    test('getServiceRegions parses region boundary polygons', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/locations/service-regions');
        return _jsonResponse({
          'success': true,
          'data': [
            {
              'id': 'reg-1',
              'name': 'Gandhinagar Service Region',
              'isActive': true,
              'boundaryGeoJson': {
                'type': 'Polygon',
                'coordinates': [
                  [
                    [72.58, 23.12],
                    [72.72, 23.12],
                    [72.72, 23.30],
                    [72.58, 23.30],
                    [72.58, 23.12],
                  ],
                ],
              },
            },
          ],
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      final regions = await repo.getServiceRegions();
      expect(regions.length, 1);
      expect(regions.first.name, 'Gandhinagar Service Region');
      expect(regions.first.polygonCoordinates.length, 5);
    });

    test(
        'validateDestination sends coordinates, requires authentication, and receives validation',
        () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        expect(options.path, '/locations/validate-destination');
        expect(options.headers['Authorization'], 'Bearer mock-jwt-token');
        final body = options.data as Map<String, dynamic>;
        expect(body['latitude'], 23.1885);
        expect(body['longitude'], 72.6288);
        return _jsonResponse({
          'success': true,
          'data': {
            'isInsideServiceRegion': true,
            'matchedZoneId': 'reg-1',
            'matchedZoneName': 'Gandhinagar Service Region',
          },
        });
      });

      final client = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        tokenProvider: () async => 'mock-jwt-token',
      );
      final repo = ApiBookingRepository(apiClient: client);

      final res = await repo.validateDestination(
        latitude: 23.1885,
        longitude: 72.6288,
      );
      expect(res.isInsideServiceRegion, isTrue);
      expect(res.matchedZoneName, 'Gandhinagar Service Region');
    });

    test('validatePickup validates 150m geofence distance', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        expect(options.path, '/locations/validate-pickup');
        final body = options.data as Map<String, dynamic>;
        expect(body['pickupPointId'], 'hub-1');
        return _jsonResponse({
          'success': true,
          'data': {
            'isValid': true,
            'distanceMeters': 35.0,
            'allowedRadiusMeters': 150.0,
            'pickupPoint': {
              'id': 'hub-1',
              'name': 'PDEU Main Gate',
            },
          },
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      final res = await repo.validatePickup(
        pickupPointId: 'hub-1',
        latitude: 23.1551,
        longitude: 72.6669,
      );
      expect(res.isValid, isTrue);
      expect(res.distanceMeters, 35.0);
    });

    test('generateFareQuote creates 2-minute binding quote', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        expect(options.path, '/fares/quotes');
        return _jsonResponse({
          'success': true,
          'data': {
            'quoteId': 'quote-123',
            'pickupPointId': 'hub-1',
            'pickupPointName': 'PDEU Main Gate',
            'directDistanceMeters': 3200,
            'directDurationSec': 480,
            'privateEstimatedFare': '52.00',
            'sharedEstimatedRange': {
              'minFare': '20.00',
              'maxFare': '52.00',
            },
            'agreedFareCeiling': '52.00',
            'tariffVersion': 1,
            'expiresAt': '2026-11-20T23:59:00.000Z',
          },
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      final quote = await repo.generateFareQuote(
        pickupPointId: 'hub-1',
        destinationLatitude: 23.1885,
        destinationLongitude: 72.6288,
      );
      expect(quote.quoteId, 'quote-123');
      expect(quote.agreedFareCeiling, '52.00');
      expect(quote.directDistanceMeters, 3200);
      expect(quote.tariffVersion, 1);
    });

    test('createBooking transmits Idempotency-Key header and request payload',
        () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        expect(options.path, '/bookings');
        expect(options.headers['Idempotency-Key'], 'idemp-key-uuid-1');

        final body = options.data as Map<String, dynamic>;
        expect(body['quoteId'], 'quote-123');
        expect(body['requestedType'], 'SHARED');
        expect(body['minGroupPreference'], 3);
        expect(body['upfrontConsentAgreed'], isTrue);

        return _jsonResponse(
          {
            'success': true,
            'data': {
              'bookingId': 'book-uuid-99',
              'status': 'REQUESTED',
              'agreedFareCeiling': '52.00',
              'maxWaitDeadline': '2026-11-20T23:55:00.000Z',
            },
          },
          statusCode: 201,
        );
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      final response = await repo.createBooking(
        request: const BookingRequest(
          quoteId: 'quote-123',
          requestedType: 'SHARED',
          minGroupPreference: 3,
          passengerPickupLocation: BookingLocation(
            latitude: 23.1550,
            longitude: 72.6668,
          ),
          upfrontConsentAgreed: true,
        ),
        idempotencyKey: 'idemp-key-uuid-1',
      );

      expect(response.bookingId, 'book-uuid-99');
      expect(response.status, 'REQUESTED');
      expect(response.agreedFareCeiling, '52.00');
    });

    test('getActiveBooking returns null when passenger has no active ride',
        () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/bookings/active');
        return _jsonResponse({
          'success': true,
          'data': null,
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      final booking = await repo.getActiveBooking();
      expect(booking, isNull);
    });

    test('getActiveBooking parses active booking when present', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/bookings/active');
        return _jsonResponse({
          'success': true,
          'data': {
            'id': 'booking-active-1',
            'status': 'MATCHING',
            'agreedFareCeilingPaise': 4500,
            'maxWaitDeadline': '2026-11-20T23:50:00.000Z',
            'pickupPointName': 'PDEU Main Gate',
          },
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      final booking = await repo.getActiveBooking();
      expect(booking, isNotNull);
      expect(booking!.bookingId, 'booking-active-1');
      expect(booking.status, 'MATCHING');
      expect(booking.agreedFareCeiling, '45.00');
      expect(booking.isActive, isTrue);
    });

    test('maps 409 conflict when active booking already exists', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        return _jsonResponse(
          {
            'statusCode': 409,
            'errorCode': 'ACTIVE_BOOKING_EXISTS',
            'message': 'Passenger already has an active booking in progress.',
          },
          statusCode: 409,
        );
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      expect(
        () => repo.createBooking(
          request: const BookingRequest(
            quoteId: 'quote-123',
            requestedType: 'SHARED',
            minGroupPreference: 2,
            passengerPickupLocation: BookingLocation(
              latitude: 23.1550,
              longitude: 72.6668,
            ),
            upfrontConsentAgreed: true,
          ),
          idempotencyKey: 'key-1',
        ),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 409)
              .having((e) => e.errorCode, 'errorCode', 'ACTIVE_BOOKING_EXISTS'),
        ),
      );
    });

    test('getBookingDetails fetches booking details and status history with auth', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/bookings/book-uuid-123');
        expect(options.headers['Authorization'], 'Bearer test-token');
        return _jsonResponse({
          'success': true,
          'data': {
            'bookingId': 'book-uuid-123',
            'passengerId': 'passenger-7',
            'pickupPointId': 'hub-1',
            'pickupPointName': 'PDEU Main Gate',
            'requestedType': 'SHARED',
            'minGroupPreference': 2,
            'status': 'CONFIRMED',
            'agreedFareCeilingPaise': 4500,
            'finalAllocatedFarePaise': 4000,
            'maxWaitDeadline': '2026-11-20T12:00:00.000Z',
            'cancellationReason': null,
            'cancelledAt': null,
            'createdAt': '2026-11-20T11:45:00.000Z',
            'passengerPickupLocation': {
              'latitude': 23.1550,
              'longitude': 72.6668,
            },
            'destinationLocation': {
              'latitude': 23.1800,
              'longitude': 72.6500,
            },
            'statusHistory': [
              {
                'previousStatus': 'REQUESTED',
                'newStatus': 'CONFIRMED',
                'reason': 'Assigned directly',
                'transitionTime': '2026-11-20T11:46:00.000Z',
              },
            ],
          },
        });
      });

      final client = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        tokenProvider: () async => 'test-token',
      );
      final repo = ApiBookingRepository(apiClient: client);

      final details = await repo.getBookingDetails('book-uuid-123');
      expect(details.bookingId, 'book-uuid-123');
      expect(details.status, 'CONFIRMED');
      expect(details.finalAllocatedFareInRupees, '40.00');
      expect(details.statusHistory.length, 1);
      expect(details.statusHistory.first.newStatus, 'CONFIRMED');
    });

    test('cancelBooking submits idempotent cancellation with optional reason', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'POST');
        expect(options.path, '/bookings/book-uuid-123/cancel');
        expect(options.headers['Authorization'], 'Bearer test-token');
        expect(options.headers['Idempotency-Key'], 'idemp-key-999');
        expect(options.data, {'reason': 'Emergency cancellation'});
        return _jsonResponse({
          'success': true,
          'data': {
            'bookingId': 'book-uuid-123',
            'status': 'CANCELLED',
            'cancellationFeeAssessedPaise': 3000,
            'cancellationFeeStatus': 'OUTSTANDING',
          },
        });
      });

      final client = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        tokenProvider: () async => 'test-token',
      );
      final repo = ApiBookingRepository(apiClient: client);

      final result = await repo.cancelBooking(
        bookingId: 'book-uuid-123',
        reason: 'Emergency cancellation',
        idempotencyKey: 'idemp-key-999',
      );

      expect(result.bookingId, 'book-uuid-123');
      expect(result.status, 'CANCELLED');
      expect(result.cancellationFeeAssessedPaise, 3000);
      expect(result.feeInRupees, 30.0);
      expect(result.cancellationFeeStatus, 'OUTSTANDING');
    });

    test('cancelBooking with null or empty reason sends empty map', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.data, isEmpty);
        return _jsonResponse({
          'success': true,
          'data': {
            'bookingId': 'book-uuid-123',
            'status': 'CANCELLED',
            'cancellationFeeAssessedPaise': 0,
            'cancellationFeeStatus': 'NONE',
          },
        });
      });

      final client = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        tokenProvider: () async => 'test-token',
      );
      final repo = ApiBookingRepository(apiClient: client);

      final result = await repo.cancelBooking(
        bookingId: 'book-uuid-123',
        reason: '   ',
        idempotencyKey: 'idemp-key-none',
      );

      expect(result.cancellationFeeAssessedPaise, 0);
      expect(result.cancellationFeeStatus, 'NONE');
    });

    test('getOutstandingCancellationFees retrieves passenger outstanding fees with auth', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        expect(options.method, 'GET');
        expect(options.path, '/passengers/cancellation-fees/outstanding');
        expect(options.headers['Authorization'], 'Bearer test-token');
        return _jsonResponse({
          'success': true,
          'data': {
            'totalOutstandingPaise': 3000,
            'fees': [
              {
                'id': 'fee-1',
                'originalBookingId': 'book-old-1',
                'amountPaise': 3000,
                'createdAt': '2026-11-20T10:00:00.000Z',
              },
            ],
          },
        });
      });

      final client = ApiClient(
        config: config,
        httpClientAdapter: adapter,
        tokenProvider: () async => 'test-token',
      );
      final repo = ApiBookingRepository(apiClient: client);

      final response = await repo.getOutstandingCancellationFees();
      expect(response.totalOutstandingPaise, 3000);
      expect(response.totalOutstandingInRupees, 30.0);
      expect(response.fees.length, 1);
      expect(response.fees.first.id, 'fee-1');
    });

    test('cancelBooking throws ApiException with INVALID_RESPONSE on malformed fee response', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': {
            'bookingId': 'book-uuid-123',
            'status': 'CANCELLED',
            // Missing cancellationFeeAssessedPaise
            'cancellationFeeStatus': 'OUTSTANDING',
          },
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      expect(
        () => repo.cancelBooking(
          bookingId: 'book-uuid-123',
          idempotencyKey: 'idemp-key-1',
        ),
        throwsA(
          isA<ApiException>()
              .having((e) => e.errorCode, 'errorCode', 'INVALID_RESPONSE'),
        ),
      );
    });

    test('cancelBooking throws ApiException with INVALID_RESPONSE when response bookingId does not match requested bookingId', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': {
            'bookingId': 'book-DIFFERENT-id',
            'status': 'CANCELLED',
            'cancellationFeeAssessedPaise': 3000,
            'cancellationFeeStatus': 'OUTSTANDING',
          },
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      expect(
        () => repo.cancelBooking(
          bookingId: 'book-uuid-123',
          idempotencyKey: 'idemp-key-1',
        ),
        throwsA(
          isA<ApiException>()
              .having((e) => e.errorCode, 'errorCode', 'INVALID_RESPONSE')
              .having((e) => e.message, 'message', contains('does not match requested booking ID')),
        ),
      );
    });

    test('cancelBooking throws ApiException with INVALID_RESPONSE when response status is not CANCELLED', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': {
            'bookingId': 'book-uuid-123',
            'status': 'CONFIRMED',
            'cancellationFeeAssessedPaise': 0,
            'cancellationFeeStatus': 'NONE',
          },
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      expect(
        () => repo.cancelBooking(
          bookingId: 'book-uuid-123',
          idempotencyKey: 'idemp-key-1',
        ),
        throwsA(
          isA<ApiException>()
              .having((e) => e.errorCode, 'errorCode', 'INVALID_RESPONSE'),
        ),
      );
    });

    test('getOutstandingCancellationFees throws ApiException on malformed fee item date', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': {
            'totalOutstandingPaise': 3000,
            'fees': [
              {
                'id': 'fee-1',
                'originalBookingId': 'book-old-1',
                'amountPaise': 3000,
                'createdAt': 'not-a-valid-date',
              },
            ],
          },
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      expect(
        () => repo.getOutstandingCancellationFees(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.errorCode, 'errorCode', 'INVALID_RESPONSE'),
        ),
      );
    });

    test('getBookingDetails throws ApiException with INVALID_RESPONSE on missing required createdAt or maxWaitDeadline', () async {
      late _FakeAdapter adapter;
      adapter = _FakeAdapter((options) async {
        return _jsonResponse({
          'success': true,
          'data': {
            'bookingId': 'book-uuid-123',
            'status': 'CONFIRMED',
            'agreedFareCeilingPaise': 4500,
            // Missing maxWaitDeadline and createdAt
          },
        });
      });

      final client = ApiClient(config: config, httpClientAdapter: adapter);
      final repo = ApiBookingRepository(apiClient: client);

      expect(
        () => repo.getBookingDetails('book-uuid-123'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.errorCode, 'errorCode', 'INVALID_RESPONSE'),
        ),
      );
    });
  });
}
