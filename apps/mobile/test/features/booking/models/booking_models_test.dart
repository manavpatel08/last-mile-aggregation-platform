import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/features/booking/models/booking_request.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/booking/models/fare_quote.dart';
import 'package:lastmile_mobile/features/booking/models/location_validation.dart';
import 'package:lastmile_mobile/features/booking/models/pickup_point.dart';
import 'package:lastmile_mobile/features/booking/models/service_region.dart';

void main() {
  group('Booking Feature Models', () {
    test('PickupPoint fromJson and toJson', () {
      final json = {
        'id': 'p1-uuid',
        'name': 'PDEU Main Gate',
        'serviceZoneId': 'z1-uuid',
        'radiusMeters': 150.0,
        'latitude': 23.1550,
        'longitude': 72.6668,
        'isActive': true,
      };

      final point = PickupPoint.fromJson(json);
      expect(point.id, 'p1-uuid');
      expect(point.name, 'PDEU Main Gate');
      expect(point.radiusMeters, 150.0);
      expect(point.latitude, 23.1550);
      expect(point.longitude, 72.6668);
      expect(point.isActive, isTrue);

      final serialized = point.toJson();
      expect(serialized['name'], 'PDEU Main Gate');
      expect(serialized['radiusMeters'], 150.0);
    });

    test('ServiceRegion parses Polygon GeoJSON into LatLng coordinates', () {
      final json = {
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
      };

      final region = ServiceRegion.fromJson(json);
      expect(region.id, 'reg-1');
      expect(region.name, 'Gandhinagar Service Region');
      expect(region.isActive, isTrue);

      final coords = region.polygonCoordinates;
      expect(coords.length, 5);
      expect(coords[0].latitude, 23.12);
      expect(coords[0].longitude, 72.58);
      expect(coords[2].latitude, 23.30);
      expect(coords[2].longitude, 72.72);
    });

    test('DestinationValidationResult fromJson', () {
      final json = {
        'isInsideServiceRegion': true,
        'matchedZoneId': 'zone-123',
        'matchedZoneName': 'Gandhinagar',
      };

      final res = DestinationValidationResult.fromJson(json);
      expect(res.isInsideServiceRegion, isTrue);
      expect(res.matchedZoneId, 'zone-123');
      expect(res.matchedZoneName, 'Gandhinagar');
    });

    test('PickupValidationResult fromJson', () {
      final json = {
        'isValid': true,
        'distanceMeters': 42.5,
        'allowedRadiusMeters': 150,
        'pickupPoint': {
          'id': 'p1',
          'name': 'PDEU Main Gate',
        },
      };

      final res = PickupValidationResult.fromJson(json);
      expect(res.isValid, isTrue);
      expect(res.distanceMeters, 42.5);
      expect(res.allowedRadiusMeters, 150.0);
      expect(res.pickupPointName, 'PDEU Main Gate');
    });

    test('FareQuote fromJson, countdown, and expiry calculation', () {
      final now = DateTime.now();
      final expiresAt = now.add(const Duration(minutes: 2));

      final json = {
        'quoteId': 'quote-uuid',
        'pickupPointId': 'pickup-uuid',
        'pickupPointName': 'PDEU Main Gate',
        'directDistanceMeters': 2500,
        'directDurationSec': 360,
        'privateEstimatedFare': '45.00',
        'sharedEstimatedRange': {
          'minFare': '20.00',
          'maxFare': '45.00',
        },
        'agreedFareCeiling': '45.00',
        'tariffVersion': 1,
        'expiresAt': expiresAt.toIso8601String(),
      };

      final quote = FareQuote.fromJson(json);
      expect(quote.quoteId, 'quote-uuid');
      expect(quote.directDistanceMeters, 2500);
      expect(quote.directDurationSec, 360);
      expect(quote.privateEstimatedFare, '45.00');
      expect(quote.sharedEstimatedRange.minFare, '20.00');
      expect(quote.sharedEstimatedRange.maxFare, '45.00');
      expect(quote.agreedFareCeiling, '45.00');
      expect(quote.tariffVersion, 1);
      expect(quote.isExpired, isFalse);
      expect(quote.remainingDuration.inSeconds, greaterThan(0));

      final expiredQuote = FareQuote.fromJson({
        ...json,
        'expiresAt': now.subtract(const Duration(seconds: 10)).toIso8601String(),
      });
      expect(expiredQuote.isExpired, isTrue);
      expect(expiredQuote.remainingDuration, Duration.zero);
    });

    test('BookingRequest toJson serializes required fields', () {
      final req = BookingRequest(
        quoteId: 'quote-uuid',
        requestedType: 'SHARED',
        minGroupPreference: 2,
        passengerPickupLocation: const BookingLocation(
          latitude: 23.1550,
          longitude: 72.6668,
        ),
        upfrontConsentAgreed: true,
      );

      final json = req.toJson();
      expect(json['quoteId'], 'quote-uuid');
      expect(json['requestedType'], 'SHARED');
      expect(json['minGroupPreference'], 2);
      expect(json['upfrontConsentAgreed'], isTrue);
      expect(json['passengerPickupLocation']['latitude'], 23.1550);
      expect(json['passengerPickupLocation']['longitude'], 72.6668);
    });

    test('BookingResponse fromJson parses active booking', () {
      final json = {
        'bookingId': 'book-uuid',
        'status': 'REQUESTED',
        'agreedFareCeiling': '45.00',
        'maxWaitDeadline': '2026-11-20T22:30:00.000Z',
        'requestedType': 'SHARED',
        'minGroupPreference': 2,
        'pickupPointName': 'PDEU Main Gate',
      };

      final resp = BookingResponse.fromJson(json);
      expect(resp.bookingId, 'book-uuid');
      expect(resp.status, 'REQUESTED');
      expect(resp.agreedFareCeiling, '45.00');
      expect(resp.requestedType, 'SHARED');
      expect(resp.isActive, isTrue);
    });
  });
}
