import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/realtime/models/realtime_event.dart';
import 'package:lastmile_mobile/core/realtime/models/sync_models.dart';

void main() {
  group('StandardRealtimeEvent Strict Parsing', () {
    final validJson = {
      'eventId': 'ev-1234',
      'event': 'driver.location.updated',
      'entityType': 'DRIVER',
      'entityId': 'drv-5678',
      'entityVersion': 1,
      'occurredAt': '2026-11-22T12:00:00.000Z',
      'data': {'foo': 'bar'},
    };

    test('parses valid canonical event envelope', () {
      final envelope =
          StandardRealtimeEvent<Map<String, dynamic>>.fromJson(validJson);

      expect(envelope.eventId, 'ev-1234');
      expect(envelope.event, 'driver.location.updated');
      expect(envelope.entityType, 'DRIVER');
      expect(envelope.entityId, 'drv-5678');
      expect(envelope.entityVersion, 1);
      expect(envelope.occurredAt.isUtc, isTrue);
      expect(envelope.data['foo'], 'bar');
    });

    test('rejects missing or empty eventId', () {
      final json1 = Map<String, dynamic>.from(validJson)..remove('eventId');
      expect(() => StandardRealtimeEvent.fromJson(json1),
          throwsA(isA<FormatException>()));

      final json2 = Map<String, dynamic>.from(validJson)..['eventId'] = '   ';
      expect(() => StandardRealtimeEvent.fromJson(json2),
          throwsA(isA<FormatException>()));
    });

    test('rejects missing or empty event name', () {
      final json1 = Map<String, dynamic>.from(validJson)..remove('event');
      expect(() => StandardRealtimeEvent.fromJson(json1),
          throwsA(isA<FormatException>()));

      final json2 = Map<String, dynamic>.from(validJson)..['event'] = '';
      expect(() => StandardRealtimeEvent.fromJson(json2),
          throwsA(isA<FormatException>()));
    });

    test('rejects missing or empty entityType and entityId', () {
      final json1 = Map<String, dynamic>.from(validJson)..['entityType'] = '';
      expect(() => StandardRealtimeEvent.fromJson(json1),
          throwsA(isA<FormatException>()));

      final json2 = Map<String, dynamic>.from(validJson)..['entityId'] = ' ';
      expect(() => StandardRealtimeEvent.fromJson(json2),
          throwsA(isA<FormatException>()));
    });

    test('rejects non-positive, fractional or non-integer entityVersion', () {
      final zeroVersion = Map<String, dynamic>.from(validJson)
        ..['entityVersion'] = 0;
      expect(() => StandardRealtimeEvent.fromJson(zeroVersion),
          throwsA(isA<FormatException>()));

      final negativeVersion = Map<String, dynamic>.from(validJson)
        ..['entityVersion'] = -1;
      expect(() => StandardRealtimeEvent.fromJson(negativeVersion),
          throwsA(isA<FormatException>()));

      final fractionalVersion = Map<String, dynamic>.from(validJson)
        ..['entityVersion'] = 1.5;
      expect(() => StandardRealtimeEvent.fromJson(fractionalVersion),
          throwsA(isA<FormatException>()));

      final stringVersion = Map<String, dynamic>.from(validJson)
        ..['entityVersion'] = '1';
      expect(() => StandardRealtimeEvent.fromJson(stringVersion),
          throwsA(isA<FormatException>()));
    });

    test('rejects invalid or missing occurredAt timestamp', () {
      final missingTime = Map<String, dynamic>.from(validJson)
        ..remove('occurredAt');
      expect(() => StandardRealtimeEvent.fromJson(missingTime),
          throwsA(isA<FormatException>()));

      final invalidTime = Map<String, dynamic>.from(validJson)
        ..['occurredAt'] = 'not-a-timestamp';
      expect(() => StandardRealtimeEvent.fromJson(invalidTime),
          throwsA(isA<FormatException>()));
    });

    test('rejects missing data field', () {
      final missingData = Map<String, dynamic>.from(validJson)..remove('data');
      expect(() => StandardRealtimeEvent.fromJson(missingData),
          throwsA(isA<FormatException>()));
    });
  });

  group('DriverLocationBroadcastData Strict Parsing', () {
    final validJson = {
      'driverId': 'drv-uuid',
      'tripId': 'trip-uuid',
      'latitude': 23.185,
      'longitude': 72.630,
      'heading': 180.0,
      'speed': 25.0,
      'updatedAt': '2026-11-22T12:05:00.000Z',
    };

    test('parses valid GPS telemetry payload', () {
      final data = DriverLocationBroadcastData.fromJson(validJson);
      expect(data.driverId, 'drv-uuid');
      expect(data.tripId, 'trip-uuid');
      expect(data.latitude, 23.185);
      expect(data.longitude, 72.630);
      expect(data.heading, 180.0);
      expect(data.speed, 25.0);
    });

    test('rejects missing or empty driverId', () {
      final json = Map<String, dynamic>.from(validJson)..['driverId'] = ' ';
      expect(() => DriverLocationBroadcastData.fromJson(json),
          throwsA(isA<FormatException>()));
    });

    test('rejects latitude out of [-90, 90]', () {
      final high = Map<String, dynamic>.from(validJson)..['latitude'] = 90.001;
      expect(() => DriverLocationBroadcastData.fromJson(high),
          throwsA(isA<FormatException>()));

      final low = Map<String, dynamic>.from(validJson)..['latitude'] = -90.001;
      expect(() => DriverLocationBroadcastData.fromJson(low),
          throwsA(isA<FormatException>()));

      final nonNum = Map<String, dynamic>.from(validJson)
        ..['latitude'] = '23.185';
      expect(() => DriverLocationBroadcastData.fromJson(nonNum),
          throwsA(isA<FormatException>()));
    });

    test('rejects longitude out of [-180, 180]', () {
      final high = Map<String, dynamic>.from(validJson)..['longitude'] = 180.1;
      expect(() => DriverLocationBroadcastData.fromJson(high),
          throwsA(isA<FormatException>()));

      final low = Map<String, dynamic>.from(validJson)..['longitude'] = -180.1;
      expect(() => DriverLocationBroadcastData.fromJson(low),
          throwsA(isA<FormatException>()));
    });

    test('rejects invalid or missing updatedAt timestamp', () {
      final json = Map<String, dynamic>.from(validJson)..['updatedAt'] = 'bad';
      expect(() => DriverLocationBroadcastData.fromJson(json),
          throwsA(isA<FormatException>()));
    });
  });

  group('RoomSubscriptionAck Strict Parsing', () {
    test('parses valid success and error responses', () {
      final ack = RoomSubscriptionAck.fromJson({'success': true, 'room': 'trip:1'});
      expect(ack.success, isTrue);
      expect(ack.room, 'trip:1');
    });

    test('rejects non-boolean success', () {
      expect(() => RoomSubscriptionAck.fromJson({'success': 'true'}),
          throwsA(isA<FormatException>()));
    });
  });

  group('Sync Models Strict Parsing', () {
    test('SyncRequestDto serializes optional query filters', () {
      const dto = SyncRequestDto(
        lastKnownEntityVersion: 2,
        activeBookingId: 'bk-123',
        activeTripId: 'tr-456',
      );

      final json = dto.toJson();
      expect(json['lastKnownEntityVersion'], 2);
      expect(json['activeBookingId'], 'bk-123');
      expect(json['activeTripId'], 'tr-456');

      const emptyDto = SyncRequestDto();
      expect(emptyDto.toJson(), isEmpty);
    });

    test('SyncResponseDto parses passenger state snapshot with nullable fields', () {
      final json = {
        'success': true,
        'serverTimestamp': '2026-11-22T12:00:00.000Z',
        'role': 'PASSENGER',
        'reconciled': true,
        'passengerState': {
          'activeBooking': {
            'id': 'booking-uuid',
            'status': 'CONFIRMED',
            'passengerId': 'passenger-uuid',
            'pickupPointId': 'pdeu-main-gate',
            'dropoffAddress': null,
            'fareQuotePaise': 3500,
            'createdAt': '2026-11-22T11:50:00.000Z',
            'updatedAt': '2026-11-22T11:55:00.000Z',
            'entityVersion': 2,
          },
          'activeGroup': {
            'id': 'group-uuid',
            'status': 'ASSIGNED',
            'groupVersion': 2,
            'pickupPointId': 'pdeu-main-gate',
            'memberCount': 3,
          },
          'activeTrip': {
            'id': 'trip-uuid',
            'status': 'IN_PROGRESS',
            'tripVersion': 2,
            'activeDriverId': 'driver-uuid',
            'driverName': 'Ramesh Kumar',
            'vehicleNumber': 'GJ-01-AB-1234',
            'driverLocation': {
              'latitude': 23.188,
              'longitude': 72.632,
              'updatedAt': '2026-11-22T11:59:00.000Z',
            },
            'etaSeconds': 120,
            'currentStopOrder': 1,
            'farePaise': 3000,
          },
          'outstandingCancellationFees': [
            {
              'id': 'fee-1',
              'feeAmountPaise': 3000,
              'reason': 'Late cancellation',
              'assessedAt': '2026-11-20T10:00:00.000Z',
            }
          ],
        },
      };

      final response = SyncResponseDto.fromJson(json);

      expect(response.success, isTrue);
      expect(response.role, 'PASSENGER');
      expect(response.reconciled, isTrue);
      expect(response.passengerState, isNotNull);
      expect(response.passengerState?.activeBooking?.id, 'booking-uuid');
      expect(response.passengerState?.activeBooking?.status, 'CONFIRMED');
      expect(response.passengerState?.activeBooking?.dropoffAddress, isNull);
      expect(response.passengerState?.activeTrip?.driverName, 'Ramesh Kumar');
      expect(response.passengerState?.activeTrip?.driverLocation?.latitude, 23.188);
      expect(response.passengerState?.outstandingCancellationFees.length, 1);
    });

    test('SyncResponseDto preserves null activeBooking and null activeTrip in passenger state', () {
      final json = {
        'success': true,
        'serverTimestamp': '2026-11-22T12:00:00.000Z',
        'role': 'PASSENGER',
        'reconciled': true,
        'passengerState': {
          'activeBooking': null,
          'activeGroup': null,
          'activeTrip': null,
          'outstandingCancellationFees': [],
        },
      };

      final response = SyncResponseDto.fromJson(json);
      expect(response.passengerState?.activeBooking, isNull);
      expect(response.passengerState?.activeGroup, isNull);
      expect(response.passengerState?.activeTrip, isNull);
      expect(response.passengerState?.outstandingCancellationFees, isEmpty);
    });

    test('SyncResponseDto parses driver state snapshot without pickupOtp', () {
      final json = {
        'success': true,
        'serverTimestamp': '2026-11-22T12:00:00.000Z',
        'role': 'DRIVER',
        'reconciled': false,
        'driverState': {
          'driverProfile': {
            'id': 'driver-profile-uuid',
            'verificationStatus': 'APPROVED',
            'operationalStatus': 'AVAILABLE',
            'isOnline': true,
          },
          'activeOffer': {
            'id': 'offer-uuid',
            'rideGroupId': 'group-uuid',
            'groupVersion': 1,
            'expiresAt': '2026-11-22T12:01:00.000Z',
            'status': 'PENDING',
          },
          'activeTrip': {
            'id': 'trip-uuid',
            'status': 'DRIVER_ARRIVED',
            'tripVersion': 1,
            'rideGroupId': 'group-uuid',
            'currentStopOrder': 0,
            'passengerManifest': [
              {
                'passengerId': 'passenger-1',
                'bookingId': 'booking-1',
                'status': 'WAITING',
              },
              {
                'passengerId': 'passenger-2',
                'bookingId': 'booking-2',
                'status': 'BOARDED',
              }
            ],
          },
        },
      };

      final response = SyncResponseDto.fromJson(json);

      expect(response.success, isTrue);
      expect(response.role, 'DRIVER');
      expect(response.reconciled, isFalse);
      expect(response.driverState, isNotNull);
      expect(response.driverState?.driverProfile.verificationStatus, 'APPROVED');
      expect(response.driverState?.activeOffer?.id, 'offer-uuid');
      expect(response.driverState?.activeTrip?.passengerManifest.length, 2);
      expect(response.driverState?.activeTrip?.passengerManifest[0].status, 'WAITING');
    });

    test('SyncResponseDto rejects missing required fields with FormatException', () {
      final missingRole = {
        'success': true,
        'serverTimestamp': '2026-11-22T12:00:00.000Z',
        'reconciled': true,
      };
      expect(() => SyncResponseDto.fromJson(missingRole),
          throwsA(isA<FormatException>()));

      final missingProfile = {
        'success': true,
        'serverTimestamp': '2026-11-22T12:00:00.000Z',
        'role': 'DRIVER',
        'reconciled': false,
        'driverState': {
          'activeOffer': null,
          'activeTrip': null,
        },
      };
      expect(() => SyncResponseDto.fromJson(missingProfile),
          throwsA(isA<FormatException>()));

      final badBookingVersion = {
        'id': 'bk-1',
        'status': 'CONFIRMED',
        'passengerId': 'p-1',
        'pickupPointId': 'zone-1',
        'fareQuotePaise': 3500,
        'createdAt': '2026-11-22T12:00:00.000Z',
        'updatedAt': '2026-11-22T12:00:00.000Z',
        'entityVersion': 0, // invalid: < 1
      };
      expect(() => SyncActiveBooking.fromJson(badBookingVersion),
          throwsA(isA<FormatException>()));
    });
  });
}
