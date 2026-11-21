import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/features/driver/models/accept_offer_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_dispatch_offer.dart';
import 'package:lastmile_mobile/features/driver/presentation/models/dispatch_offer_item.dart';

void main() {
  group('DriverPickupPoint', () {
    test('parses valid JSON successfully', () {
      final json = {'id': 'pnt-123', 'name': 'PDEU Gate 1'};
      final point = DriverPickupPoint.fromJson(json);

      expect(point.id, 'pnt-123');
      expect(point.name, 'PDEU Gate 1');
      expect(point.toJson(), json);
    });

    test('throws FormatException on missing or empty fields', () {
      expect(() => DriverPickupPoint.fromJson({'name': 'Gate 1'}), throwsFormatException);
      expect(() => DriverPickupPoint.fromJson({'id': '', 'name': 'Gate 1'}), throwsFormatException);
      expect(() => DriverPickupPoint.fromJson({'id': 'pnt-1'}), throwsFormatException);
      expect(() => DriverPickupPoint.fromJson({'id': 'pnt-1', 'name': '   '}), throwsFormatException);
    });
  });

  group('DriverDispatchOffer', () {
    final validJson = {
      'offerId': 'off-100',
      'dispatchAttemptId': 'att-200',
      'rideGroupId': 'grp-300',
      'groupVersion': 2,
      'pickupPoint': {
        'id': 'pnt-1',
        'name': 'High-Rise Gate',
      },
      'passengerCount': 4,
      'totalEstimatedFare': '64.00',
      'totalDistanceMeters': 3200,
      'totalDurationSec': 480,
      'offeredAt': '2026-11-21T18:00:00.000Z',
      'expiresAt': '2026-11-21T18:00:20.000Z',
      'remainingSeconds': 15,
    };

    test('parses valid JSON envelope and fields', () {
      final offer = DriverDispatchOffer.fromJson(validJson);

      expect(offer.offerId, 'off-100');
      expect(offer.dispatchAttemptId, 'att-200');
      expect(offer.rideGroupId, 'grp-300');
      expect(offer.groupVersion, 2);
      expect(offer.pickupPoint.name, 'High-Rise Gate');
      expect(offer.passengerCount, 4);
      expect(offer.totalEstimatedFare, '64.00');
      expect(offer.totalDistanceMeters, 3200);
      expect(offer.totalDurationSec, 480);
      expect(offer.offeredAt, DateTime.parse('2026-11-21T18:00:00.000Z'));
      expect(offer.expiresAt, DateTime.parse('2026-11-21T18:00:20.000Z'));
      expect(offer.remainingSeconds, 15);
    });

    test('converts to presentation DispatchOfferItem accurately', () {
      final futureDate = DateTime.now().add(const Duration(seconds: 30));
      final offer = DriverDispatchOffer.fromJson({
        ...validJson,
        'expiresAt': futureDate.toIso8601String(),
        'remainingSeconds': 20,
      });

      final item = offer.toPresentationItem();
      expect(item.id, 'off-100');
      expect(item.groupId, 'grp-300');
      expect(item.pickupLocationName, 'High-Rise Gate');
      expect(item.passengerCount, 4);
      expect(item.estimatedEarnings, '₹64.00');
      expect(item.estimatedDistance, '3.2 km');
      expect(item.status, DispatchOfferStatus.pending);
      expect(item.isExpired, isFalse);
    });

    test('isExpired returns true when past expiresAt or remainingSeconds <= 0', () {
      final pastDate = DateTime.now().subtract(const Duration(seconds: 5));
      final expiredOffer = DriverDispatchOffer.fromJson({
        ...validJson,
        'expiresAt': pastDate.toIso8601String(),
        'remainingSeconds': 0,
      });

      expect(expiredOffer.isExpired, isTrue);
      final item = expiredOffer.toPresentationItem();
      expect(item.status, DispatchOfferStatus.expired);
      expect(item.isExpired, isTrue);
    });

    test('throws FormatException on malformed fields', () {
      expect(() => DriverDispatchOffer.fromJson({...validJson, 'offerId': ''}), throwsFormatException);
      expect(() => DriverDispatchOffer.fromJson({...validJson, 'groupVersion': 'not-num'}), throwsFormatException);
      expect(() => DriverDispatchOffer.fromJson({...validJson, 'offeredAt': 'not-a-date'}), throwsFormatException);
      expect(() => DriverDispatchOffer.fromJson({...validJson, 'expiresAt': 'not-a-date'}), throwsFormatException);
      expect(() => DriverDispatchOffer.fromJson({...validJson, 'pickupPoint': 'invalid'}), throwsFormatException);
    });
  });

  group('AcceptOfferResponse', () {
    final validJson = {
      'assignmentId': 'asgn-1',
      'tripId': 'trip-1',
      'rideGroupId': 'grp-1',
      'passengerCount': 2,
      'totalEstimatedFare': '35.00',
      'navigationRoute': {
        'geometry': {'type': 'LineString'},
        'stops': [
          {
            'stopOrder': 1,
            'stopType': 'PICKUP',
            'latitude': 23.155,
            'longitude': 72.666,
          },
          {
            'stopOrder': 2,
            'stopType': 'DROPOFF',
            'latitude': 23.160,
            'longitude': 72.670,
          },
        ],
      },
    };

    test('parses valid JSON response and nested route stops', () {
      final response = AcceptOfferResponse.fromJson(validJson);

      expect(response.assignmentId, 'asgn-1');
      expect(response.tripId, 'trip-1');
      expect(response.rideGroupId, 'grp-1');
      expect(response.passengerCount, 2);
      expect(response.totalEstimatedFare, '35.00');
      expect(response.navigationRoute.stops.length, 2);
      expect(response.navigationRoute.stops[0].stopOrder, 1);
      expect(response.navigationRoute.stops[0].stopType, 'PICKUP');
      expect(response.navigationRoute.stops[0].latitude, 23.155);
    });

    test('throws FormatException on missing or malformed fields', () {
      expect(() => AcceptOfferResponse.fromJson({...validJson, 'assignmentId': ''}), throwsFormatException);
      expect(() => AcceptOfferResponse.fromJson({...validJson, 'tripId': null}), throwsFormatException);
      expect(() => AcceptOfferResponse.fromJson({...validJson, 'passengerCount': 'nan'}), throwsFormatException);
      expect(() => AcceptOfferResponse.fromJson({...validJson, 'navigationRoute': 'not-map'}), throwsFormatException);
    });
  });
}
