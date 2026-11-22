import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/realtime/models/realtime_event.dart';
import 'package:lastmile_mobile/core/realtime/models/sync_models.dart';

void main() {
  group('Realtime Event Models', () {
    test('StandardRealtimeEvent parses canonical event envelope', () {
      final json = {
        'eventId': 'ev-1234',
        'event': 'driver.location.updated',
        'entityType': 'DRIVER',
        'entityId': 'drv-5678',
        'entityVersion': 1,
        'occurredAt': '2026-11-22T12:00:00.000Z',
        'data': {
          'driverId': 'drv-5678',
          'latitude': 23.188,
          'longitude': 72.632,
          'heading': 90.0,
          'speed': 15.5,
          'updatedAt': '2026-11-22T12:00:00.000Z',
        },
      };

      final envelope = StandardRealtimeEvent<Map<String, dynamic>>.fromJson(json);

      expect(envelope.eventId, 'ev-1234');
      expect(envelope.event, 'driver.location.updated');
      expect(envelope.entityType, 'DRIVER');
      expect(envelope.entityId, 'drv-5678');
      expect(envelope.entityVersion, 1);
      expect(envelope.occurredAt.isUtc, isTrue);
      expect(envelope.data['latitude'], 23.188);
    });

    test('DriverLocationBroadcastData parses GPS telemetry payload', () {
      final json = {
        'driverId': 'drv-uuid',
        'tripId': 'trip-uuid',
        'latitude': 23.185,
        'longitude': 72.630,
        'heading': 180.0,
        'speed': 25.0,
        'updatedAt': '2026-11-22T12:05:00.000Z',
      };

      final data = DriverLocationBroadcastData.fromJson(json);

      expect(data.driverId, 'drv-uuid');
      expect(data.tripId, 'trip-uuid');
      expect(data.latitude, 23.185);
      expect(data.longitude, 72.630);
      expect(data.heading, 180.0);
      expect(data.speed, 25.0);
    });

    test('RoomSubscriptionAck parses success and error responses', () {
      final successJson = {
        'success': true,
        'room': 'trip:trip-123',
      };
      final successAck = RoomSubscriptionAck.fromJson(successJson);
      expect(successAck.success, isTrue);
      expect(successAck.room, 'trip:trip-123');
      expect(successAck.error, isNull);

      final errorJson = {
        'success': false,
        'error': 'FORBIDDEN',
        'message': 'Not authorized for trip room',
      };
      final errorAck = RoomSubscriptionAck.fromJson(errorJson);
      expect(errorAck.success, isFalse);
      expect(errorAck.error, 'FORBIDDEN');
      expect(errorAck.message, contains('Not authorized'));
    });
  });

  group('Sync Models', () {
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

    test('SyncResponseDto parses passenger state snapshot', () {
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
      expect(response.passengerState?.activeTrip?.driverName, 'Ramesh Kumar');
      expect(response.passengerState?.activeTrip?.vehicleNumber, 'GJ-01-AB-1234');
      expect(response.passengerState?.activeTrip?.driverLocation?.latitude, 23.188);
      expect(response.passengerState?.outstandingCancellationFees.length, 1);
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
  });
}
