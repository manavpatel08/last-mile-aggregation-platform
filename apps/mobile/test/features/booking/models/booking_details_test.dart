import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/features/booking/models/booking_cancellation_response.dart';
import 'package:lastmile_mobile/features/booking/models/booking_details.dart';
import 'package:lastmile_mobile/features/booking/models/booking_status_history.dart';
import 'package:lastmile_mobile/features/booking/models/cancellation_fee.dart';

void main() {
  group('BookingDetails Model Parsing & Strict Validation', () {
    test('BookingStatusHistoryItem throws FormatException on missing or malformed required fields', () {
      // Missing newStatus
      expect(
        () => BookingStatusHistoryItem.fromJson({
          'previousStatus': 'REQUESTED',
          'transitionTime': '2026-11-20T10:00:00.000Z',
        }),
        throwsFormatException,
      );

      // Missing transitionTime (never falls back to DateTime.now())
      expect(
        () => BookingStatusHistoryItem.fromJson({
          'previousStatus': 'REQUESTED',
          'newStatus': 'MATCHING',
        }),
        throwsFormatException,
      );

      // Malformed transitionTime string
      expect(
        () => BookingStatusHistoryItem.fromJson({
          'previousStatus': 'REQUESTED',
          'newStatus': 'MATCHING',
          'transitionTime': 'not-a-date',
        }),
        throwsFormatException,
      );

      // Null previousStatus is allowed (e.g. initial state transition)
      final item = BookingStatusHistoryItem.fromJson({
        'previousStatus': null,
        'newStatus': 'REQUESTED',
        'transitionTime': '2026-11-20T10:00:00.000Z',
      });
      expect(item.previousStatus, isNull);
      expect(item.newStatus, 'REQUESTED');
    });

    test('BookingDetails.fromJson rejects missing required timestamps and fields without fallbacks', () {
      final validBase = {
        'bookingId': 'book-uuid-1',
        'status': 'CONFIRMED',
        'agreedFareCeilingPaise': 4500,
        'maxWaitDeadline': '2026-11-20T12:00:00.000Z',
        'createdAt': '2026-11-20T11:45:00.000Z',
      };

      // Missing bookingId
      expect(
        () => BookingDetails.fromJson({
          ...validBase,
          'bookingId': null,
          'id': null,
        }),
        throwsFormatException,
      );

      // Empty bookingId
      expect(
        () => BookingDetails.fromJson({
          ...validBase,
          'bookingId': '   ',
        }),
        throwsFormatException,
      );

      // Missing status (must not invent REQUESTED)
      expect(
        () => BookingDetails.fromJson({
          ...validBase,
          'status': null,
        }),
        throwsFormatException,
      );

      // Missing monetary ceiling (must not invent 0.00)
      expect(
        () => BookingDetails.fromJson({
          'bookingId': 'b-1',
          'status': 'CONFIRMED',
          'maxWaitDeadline': '2026-11-20T12:00:00.000Z',
          'createdAt': '2026-11-20T11:45:00.000Z',
        }),
        throwsFormatException,
      );

      // Missing maxWaitDeadline (must not fall back to DateTime.now())
      expect(
        () => BookingDetails.fromJson({
          'bookingId': 'b-1',
          'status': 'CONFIRMED',
          'agreedFareCeilingPaise': 3500,
          'createdAt': '2026-11-20T11:45:00.000Z',
        }),
        throwsFormatException,
      );

      // Malformed maxWaitDeadline
      expect(
        () => BookingDetails.fromJson({
          ...validBase,
          'maxWaitDeadline': 'invalid-date',
        }),
        throwsFormatException,
      );

      // Missing createdAt (must not fall back to DateTime.now())
      expect(
        () => BookingDetails.fromJson({
          'bookingId': 'b-1',
          'status': 'CONFIRMED',
          'agreedFareCeilingPaise': 3500,
          'maxWaitDeadline': '2026-11-20T12:00:00.000Z',
        }),
        throwsFormatException,
      );

      // Malformed createdAt
      expect(
        () => BookingDetails.fromJson({
          ...validBase,
          'createdAt': 'invalid-date',
        }),
        throwsFormatException,
      );
    });

    test('BookingCancellationResponse throws FormatException on missing, malformed, or fabricated values', () {
      final validBase = {
        'bookingId': 'book-uuid-1',
        'status': 'CANCELLED',
        'cancellationFeeAssessedPaise': 3000,
        'cancellationFeeStatus': 'OUTSTANDING',
      };

      // Missing bookingId (no '' fallback)
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'bookingId': null,
        }),
        throwsFormatException,
      );

      // Empty bookingId
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'bookingId': '',
        }),
        throwsFormatException,
      );
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'bookingId': '   ',
        }),
        throwsFormatException,
      );

      // Missing status (no 'CANCELLED' fallback)
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'status': null,
        }),
        throwsFormatException,
      );

      // Empty status
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'status': '',
        }),
        throwsFormatException,
      );

      // Non-CANCELLED status
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'status': 'CONFIRMED',
        }),
        throwsFormatException,
      );
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'status': 'COMPLETED',
        }),
        throwsFormatException,
      );

      // Missing fee amount (must not default to 0)
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'cancellationFeeAssessedPaise': null,
        }),
        throwsFormatException,
      );

      // Negative assessed fee
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'cancellationFeeAssessedPaise': -3000,
        }),
        throwsFormatException,
      );

      // Non-integer assessed fee
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'cancellationFeeAssessedPaise': 30.5,
        }),
        throwsFormatException,
      );

      // Missing fee status (must not default to NONE)
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'cancellationFeeStatus': null,
        }),
        throwsFormatException,
      );

      // Unexpected cancellation fee status (only NONE and OUTSTANDING are accepted)
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'cancellationFeeStatus': 'WAIVED',
        }),
        throwsFormatException,
      );
      expect(
        () => BookingCancellationResponse.fromJson({
          ...validBase,
          'cancellationFeeStatus': 'UNKNOWN_STATUS',
        }),
        throwsFormatException,
      );
    });

    test('OutstandingFeeItem and Response throw FormatException on missing fields and parse createdAt', () {
      // Missing amount in fee item
      expect(
        () => OutstandingFeeItem.fromJson({
          'id': 'fee-1',
          'originalBookingId': 'book-1',
          'createdAt': '2026-11-20T10:00:00.000Z',
        }),
        throwsFormatException,
      );

      // Missing createdAt in fee item (never falls back to DateTime.now())
      expect(
        () => OutstandingFeeItem.fromJson({
          'id': 'fee-1',
          'originalBookingId': 'book-1',
          'amountPaise': 3000,
        }),
        throwsFormatException,
      );

      // Missing totalOutstandingPaise
      expect(
        () => OutstandingCancellationFeesResponse.fromJson({
          'fees': [],
        }),
        throwsFormatException,
      );

      // Missing fees list
      expect(
        () => OutstandingCancellationFeesResponse.fromJson({
          'totalOutstandingPaise': 3000,
        }),
        throwsFormatException,
      );

      // Null fees list (reject instead of converting to empty list)
      expect(
        () => OutstandingCancellationFeesResponse.fromJson({
          'totalOutstandingPaise': 3000,
          'fees': null,
        }),
        throwsFormatException,
      );

      // Wrongly typed fees list
      expect(
        () => OutstandingCancellationFeesResponse.fromJson({
          'totalOutstandingPaise': 3000,
          'fees': 'not-a-list',
        }),
        throwsFormatException,
      );
      expect(
        () => OutstandingCancellationFeesResponse.fromJson({
          'totalOutstandingPaise': 3000,
          'fees': 12345,
        }),
        throwsFormatException,
      );

      // Wrongly typed fee item in fees list
      expect(
        () => OutstandingCancellationFeesResponse.fromJson({
          'totalOutstandingPaise': 3000,
          'fees': ['not-a-map'],
        }),
        throwsFormatException,
      );

      // Non-empty list parsed using exact backend contract (createdAt, amountPaise, id, originalBookingId)
      final parsed = OutstandingCancellationFeesResponse.fromJson({
        'totalOutstandingPaise': 3000,
        'fees': [
          {
            'id': 'fee-uuid-1',
            'originalBookingId': 'booking-uuid-99',
            'amountPaise': 3000,
            'createdAt': '2026-11-20T10:00:00.000Z',
          },
        ],
      });
      expect(parsed.totalOutstandingPaise, 3000);
      expect(parsed.totalOutstandingInRupees, 30.0);
      expect(parsed.fees.length, 1);
      final fee = parsed.fees.first;
      expect(fee.id, 'fee-uuid-1');
      expect(fee.originalBookingId, 'booking-uuid-99');
      expect(fee.amountPaise, 3000);
      expect(fee.amountInRupees, 30.0);
      expect(fee.createdAt, DateTime.parse('2026-11-20T10:00:00.000Z'));
    });

    test('BookingDetails parses full JSON and formats allocated fare', () {
      final json = {
        'bookingId': 'book-det-1234',
        'passengerId': 'pass-1',
        'pickupPointId': 'hub-pdeu',
        'pickupPointName': 'PDEU Main Gate',
        'requestedType': 'SHARED',
        'minGroupPreference': 2,
        'status': 'CONFIRMED',
        'agreedFareCeilingPaise': 4500,
        'finalAllocatedFarePaise': 3800,
        'maxWaitDeadline': '2026-11-20T12:00:00.000Z',
        'cancellationReason': null,
        'cancelledAt': null,
        'createdAt': '2026-11-20T11:50:00.000Z',
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
            'previousStatus': 'MATCHING',
            'newStatus': 'CONFIRMED',
            'reason': 'Driver assigned',
            'transitionTime': '2026-11-20T11:52:00.000Z',
          },
          {
            'previousStatus': 'REQUESTED',
            'newStatus': 'MATCHING',
            'reason': 'Matching started',
            'transitionTime': '2026-11-20T11:50:00.000Z',
          },
        ],
      };

      final details = BookingDetails.fromJson(json);
      expect(details.bookingId, 'book-det-1234');
      expect(details.passengerId, 'pass-1');
      expect(details.pickupPointName, 'PDEU Main Gate');
      expect(details.requestedType, 'SHARED');
      expect(details.minGroupPreference, 2);
      expect(details.status, 'CONFIRMED');
      expect(details.agreedFareCeiling, '45.00');
      expect(details.finalAllocatedFarePaise, 3800);
      expect(details.finalAllocatedFareInRupees, '38.00');
      expect(details.passengerPickupLocation?.latitude, 23.1550);
      expect(details.passengerPickupLocation?.longitude, 72.6668);
      expect(details.statusHistory.length, 2);

      // Verify sortedStatusHistory orders earliest first
      final sorted = details.sortedStatusHistory;
      expect(sorted.first.newStatus, 'MATCHING');
      expect(sorted.last.newStatus, 'CONFIRMED');
    });

    test('BookingDetails safely preserves unknown future status strings', () {
      final json = {
        'bookingId': 'book-future-1',
        'status': 'FUTURE_PLATFORM_STAGE_UNKNOWN',
        'agreedFareCeilingPaise': 5000,
        'maxWaitDeadline': '2026-11-20T12:00:00.000Z',
        'createdAt': '2026-11-20T11:45:00.000Z',
      };

      final details = BookingDetails.fromJson(json);
      expect(details.status, 'FUTURE_PLATFORM_STAGE_UNKNOWN');
      expect(details.isCancellable, isFalse);
      expect(details.willIncurCancellationFee, isFalse);
    });

    test('Exact cancellation policy evaluation on all 7 cancellable and all non-cancellable statuses', () {
      // 1. Pre-driver stages: Cancellable = true, Expected fee = ₹0 (0 paise)
      const preDriverStatuses = ['REQUESTED', 'MATCHING', 'MATCHED', 'DISPATCHING'];
      for (final st in preDriverStatuses) {
        final b = BookingDetails(
          bookingId: 'b-pre-$st',
          status: st,
          agreedFareCeiling: '40.00',
          maxWaitDeadline: DateTime.parse('2026-11-20T12:00:00.000Z'),
          createdAt: DateTime.parse('2026-11-20T11:45:00.000Z'),
        );
        expect(b.isCancellable, isTrue, reason: '$st must be cancellable');
        expect(b.isAfterDriverAssignment, isFalse, reason: '$st is before driver assignment');
        expect(b.willIncurCancellationFee, isFalse, reason: '$st must have ₹0 fee');
        expect(b.expectedCancellationFeePaise, 0, reason: '$st expected fee must be 0 paise');
        expect(b.expectedCancellationFeeInRupees, 0.0, reason: '$st expected fee must be ₹0.00');
      }

      // Explicit verification: MATCHED is cancellable with ₹0 fee
      final matchedBooking = BookingDetails(
        bookingId: 'b-matched',
        status: 'MATCHED',
        agreedFareCeiling: '40.00',
        maxWaitDeadline: DateTime.parse('2026-11-20T12:00:00.000Z'),
        createdAt: DateTime.parse('2026-11-20T11:45:00.000Z'),
      );
      expect(matchedBooking.isCancellable, isTrue);
      expect(matchedBooking.willIncurCancellationFee, isFalse);
      expect(matchedBooking.expectedCancellationFeePaise, 0);
      expect(matchedBooking.expectedCancellationFeeInRupees, 0.0);

      // 2. Post-driver stages: Cancellable = true, Expected fee = ₹30 (3000 paise)
      const postDriverStatuses = ['CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED'];
      for (final st in postDriverStatuses) {
        final b = BookingDetails(
          bookingId: 'b-post-$st',
          status: st,
          agreedFareCeiling: '40.00',
          maxWaitDeadline: DateTime.parse('2026-11-20T12:00:00.000Z'),
          createdAt: DateTime.parse('2026-11-20T11:45:00.000Z'),
        );
        expect(b.isCancellable, isTrue, reason: '$st must be cancellable');
        expect(b.isAfterDriverAssignment, isTrue, reason: '$st is after driver assignment');
        expect(b.willIncurCancellationFee, isTrue, reason: '$st must incur ₹30 fee');
        expect(b.expectedCancellationFeePaise, 3000, reason: '$st expected fee must be 3000 paise');
        expect(b.expectedCancellationFeeInRupees, 30.0, reason: '$st expected fee must be ₹30.00');
      }

      // Explicit verification: DRIVER_ASSIGNED is cancellable with ₹30 fee
      final driverAssignedBooking = BookingDetails(
        bookingId: 'b-driver-assigned',
        status: 'DRIVER_ASSIGNED',
        agreedFareCeiling: '40.00',
        maxWaitDeadline: DateTime.parse('2026-11-20T12:00:00.000Z'),
        createdAt: DateTime.parse('2026-11-20T11:45:00.000Z'),
      );
      expect(driverAssignedBooking.isCancellable, isTrue);
      expect(driverAssignedBooking.willIncurCancellationFee, isTrue);
      expect(driverAssignedBooking.expectedCancellationFeePaise, 3000);
      expect(driverAssignedBooking.expectedCancellationFeeInRupees, 30.0);

      // Explicit verification: DRIVER_ARRIVED is cancellable with ₹30 fee
      final driverArrivedBooking = BookingDetails(
        bookingId: 'b-driver-arrived',
        status: 'DRIVER_ARRIVED',
        agreedFareCeiling: '40.00',
        maxWaitDeadline: DateTime.parse('2026-11-20T12:00:00.000Z'),
        createdAt: DateTime.parse('2026-11-20T11:45:00.000Z'),
      );
      expect(driverArrivedBooking.isCancellable, isTrue);
      expect(driverArrivedBooking.willIncurCancellationFee, isTrue);
      expect(driverArrivedBooking.expectedCancellationFeePaise, 3000);
      expect(driverArrivedBooking.expectedCancellationFeeInRupees, 30.0);

      // 3. Non-cancellable stages: isCancellable = false
      const nonCancellableStatuses = [
        'BOARDED',
        'IN_PROGRESS',
        'COMPLETED',
        'CANCELLED',
        'NO_SHOW',
        'ABORTED',
        'INTERRUPTED',
        'EXPIRED',
        'UNKNOWN_FUTURE_STATUS',
      ];
      for (final st in nonCancellableStatuses) {
        final b = BookingDetails(
          bookingId: 'b-non-$st',
          status: st,
          agreedFareCeiling: '40.00',
          maxWaitDeadline: DateTime.parse('2026-11-20T12:00:00.000Z'),
          createdAt: DateTime.parse('2026-11-20T11:45:00.000Z'),
        );
        expect(b.isCancellable, isFalse, reason: '$st must not be cancellable');
        expect(b.willIncurCancellationFee, isFalse, reason: '$st willIncurCancellationFee must be false');
      }
    });

    test('BookingCancellationResponse parses response accurately', () {
      final freeJson = {
        'bookingId': 'book-free',
        'status': 'CANCELLED',
        'cancellationFeeAssessedPaise': 0,
        'cancellationFeeStatus': 'NONE',
      };
      final freeResp = BookingCancellationResponse.fromJson(freeJson);
      expect(freeResp.bookingId, 'book-free');
      expect(freeResp.status, 'CANCELLED');
      expect(freeResp.cancellationFeeAssessedPaise, 0);
      expect(freeResp.cancellationFeeStatus, 'NONE');
      expect(freeResp.feeInRupees, 0.0);
      expect(freeResp.feeInRupeesFormatted, '0.00');
      expect(freeResp.hasFee, isFalse);

      final lateJson = {
        'bookingId': 'book-late',
        'status': 'CANCELLED',
        'cancellationFeeAssessedPaise': 3000,
        'cancellationFeeStatus': 'OUTSTANDING',
      };
      final lateResp = BookingCancellationResponse.fromJson(lateJson);
      expect(lateResp.bookingId, 'book-late');
      expect(lateResp.status, 'CANCELLED');
      expect(lateResp.cancellationFeeAssessedPaise, 3000);
      expect(lateResp.cancellationFeeStatus, 'OUTSTANDING');
      expect(lateResp.feeInRupees, 30.0);
      expect(lateResp.feeInRupeesFormatted, '30.00');
      expect(lateResp.hasFee, isTrue);
    });
  });
}
