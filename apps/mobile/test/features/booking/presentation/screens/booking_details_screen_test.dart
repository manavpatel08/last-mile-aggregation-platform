import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';

import 'package:lastmile_mobile/core/theme/app_theme.dart';
import 'package:lastmile_mobile/features/booking/data/booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_cancellation_response.dart';
import 'package:lastmile_mobile/features/booking/models/booking_details.dart';
import 'package:lastmile_mobile/features/booking/models/booking_request.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/booking/models/booking_status_history.dart';
import 'package:lastmile_mobile/features/booking/models/cancellation_fee.dart';
import 'package:lastmile_mobile/features/booking/models/fare_quote.dart';
import 'package:lastmile_mobile/features/booking/models/location_validation.dart';
import 'package:lastmile_mobile/features/booking/models/pickup_point.dart';
import 'package:lastmile_mobile/features/booking/models/service_region.dart';
import 'package:lastmile_mobile/features/booking/presentation/screens/booking_details_screen.dart';
import 'package:lastmile_mobile/features/booking/state/booking_details_provider.dart';

class _FakeBookingRepository implements BookingRepository {
  BookingDetails? detailsToReturn;
  BookingCancellationResponse? cancellationToReturn;
  OutstandingCancellationFeesResponse? feesToReturn;
  Exception? errorToThrow;

  int getDetailsCalls = 0;
  int cancelCalls = 0;
  String? lastCancelReason;

  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async {
    getDetailsCalls++;
    if (errorToThrow != null) throw errorToThrow!;
    return detailsToReturn ??
        BookingDetails(
          bookingId: bookingId,
          status: 'CONFIRMED',
          agreedFareCeiling: '45.00',
          maxWaitDeadline: DateTime(2026, 11, 20, 12, 30),
          pickupPointName: 'PDEU Main Gate',
          requestedType: 'SHARED',
          minGroupPreference: 2,
          finalAllocatedFarePaise: 4000,
          createdAt: DateTime(2026, 11, 20, 12, 0),
          passengerPickupLocation: const BookingLocation(
            latitude: 23.1550,
            longitude: 72.6668,
          ),
          destinationLocation: const BookingLocation(
            latitude: 23.1800,
            longitude: 72.6500,
          ),
          statusHistory: [
            BookingStatusHistoryItem(
              previousStatus: 'REQUESTED',
              newStatus: 'CONFIRMED',
              reason: 'Driver accepted',
              transitionTime: DateTime(2026, 11, 20, 12, 5),
            ),
          ],
        );
  }

  @override
  Future<BookingCancellationResponse> cancelBooking({
    required String bookingId,
    String? reason,
    required String idempotencyKey,
  }) async {
    cancelCalls++;
    lastCancelReason = reason;
    if (errorToThrow != null) throw errorToThrow!;
    detailsToReturn = BookingDetails(
      bookingId: bookingId,
      status: 'CANCELLED',
      agreedFareCeiling: '45.00',
      maxWaitDeadline: DateTime(2026, 11, 20, 12, 30),
      cancellationReason: reason,
    );
    return cancellationToReturn ??
        BookingCancellationResponse(
          bookingId: bookingId,
          status: 'CANCELLED',
          cancellationFeeAssessedPaise: 3000,
          cancellationFeeStatus: 'OUTSTANDING',
        );
  }

  @override
  Future<OutstandingCancellationFeesResponse>
      getOutstandingCancellationFees() async {
    return feesToReturn ??
        const OutstandingCancellationFeesResponse(
          totalOutstandingPaise: 0,
          fees: [],
        );
  }

  @override
  Future<BookingResponse> createBooking({
    required BookingRequest request,
    required String idempotencyKey,
  }) =>
      throw UnimplementedError();

  @override
  Future<BookingResponse?> getActiveBooking() => throw UnimplementedError();

  @override
  Future<FareQuote> generateFareQuote({
    required String pickupPointId,
    required double destinationLatitude,
    required double destinationLongitude,
  }) =>
      throw UnimplementedError();

  @override
  Future<List<PickupPoint>> getPickupZones() => throw UnimplementedError();

  @override
  Future<List<ServiceRegion>> getServiceRegions() => throw UnimplementedError();

  @override
  Future<DestinationValidationResult> validateDestination({
    required double latitude,
    required double longitude,
  }) =>
      throw UnimplementedError();

  @override
  Future<PickupValidationResult> validatePickup({
    required String pickupPointId,
    required double latitude,
    required double longitude,
  }) =>
      throw UnimplementedError();
}

Widget _buildScreen({
  required BookingDetailsProvider provider,
  String bookingId = 'test-booking-123',
}) {
  return ChangeNotifierProvider<BookingDetailsProvider>.value(
    value: provider,
    child: MaterialApp(
      theme: AppTheme.lightTheme,
      home: BookingDetailsScreen(bookingId: bookingId),
    ),
  );
}

void main() {
  late _FakeBookingRepository repository;
  late BookingDetailsProvider provider;

  setUp(() {
    repository = _FakeBookingRepository();
    provider = BookingDetailsProvider(
      bookingRepository: repository,
      uuid: const Uuid(),
    );
  });

  group('BookingDetailsScreen Widget Tests', () {
    testWidgets('renders all booking details, history items, and cancellation button',
        (tester) async {
      await tester.pumpWidget(_buildScreen(provider: provider));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('booking_details_primary_card')), findsOneWidget);
      expect(find.byKey(const Key('booking_details_status_badge')), findsOneWidget);
      final badge = tester.widget<Text>(
        find.byKey(const Key('booking_details_status_badge')),
      );
      expect(badge.data, 'CONFIRMED');
      expect(find.byKey(const Key('booking_details_id_text')), findsOneWidget);
      expect(find.text('test-booking-123'), findsOneWidget);
      expect(find.text('PDEU Main Gate'), findsOneWidget);
      expect(find.text('SHARED'), findsOneWidget);
      expect(find.text('Min 2 passengers'), findsOneWidget);
      expect(find.text('₹45.00'), findsOneWidget);
      expect(find.text('₹40.00'), findsOneWidget);

      // Verify status transition history item
      expect(find.byKey(const Key('status_history_item_0')), findsOneWidget);
      expect(find.text('Driver accepted'), findsOneWidget);

      // Post-driver status shows ₹30 fee cancellation button
      final cancelBtn = find.byKey(const Key('cancel_booking_button'));
      expect(cancelBtn, findsOneWidget);
      expect(find.text('Cancel Ride (₹30 Fee)'), findsOneWidget);
    });

    testWidgets('renders ₹0 free cancellation button for pre-driver stages',
        (tester) async {
      repository.detailsToReturn = BookingDetails(
        bookingId: 'book-pre',
        status: 'MATCHING',
        agreedFareCeiling: '40.00',
        maxWaitDeadline: DateTime(2026, 11, 20, 12, 30),
      );

      await tester.pumpWidget(_buildScreen(provider: provider, bookingId: 'book-pre'));
      await tester.pumpAndSettle();

      expect(find.text('MATCHING'), findsOneWidget);
      expect(find.text('Cancel Ride (Free)'), findsOneWidget);
    });

    testWidgets('does not render cancel button for non-cancellable BOARDED status',
        (tester) async {
      repository.detailsToReturn = BookingDetails(
        bookingId: 'book-boarded',
        status: 'BOARDED',
        agreedFareCeiling: '40.00',
        maxWaitDeadline: DateTime(2026, 11, 20, 12, 30),
      );

      await tester.pumpWidget(_buildScreen(provider: provider, bookingId: 'book-boarded'));
      await tester.pumpAndSettle();

      expect(find.text('BOARDED'), findsOneWidget);
      expect(find.byKey(const Key('cancel_booking_button')), findsNothing);
    });

    testWidgets('tapping Cancel Ride opens dialog, allows optional reason, and confirms cancellation',
        (tester) async {
      await tester.pumpWidget(_buildScreen(provider: provider));
      await tester.pumpAndSettle();

      final cancelBtn = find.byKey(const Key('cancel_booking_button'));
      await tester.tap(cancelBtn);
      await tester.pumpAndSettle();

      // Verify dialog is open
      expect(find.text('Cancel Booking?'), findsOneWidget);
      expect(find.text('Late Cancellation Fee: ₹30.00'), findsOneWidget);
      expect(find.byKey(const Key('cancellation_reason_input')), findsOneWidget);

      // Enter optional reason
      await tester.enterText(
        find.byKey(const Key('cancellation_reason_input')),
        'Change of meeting location',
      );

      // Tap confirm cancellation
      final confirmBtn = find.byKey(const Key('confirm_cancellation_button'));
      await tester.tap(confirmBtn);
      await tester.pumpAndSettle();

      expect(repository.cancelCalls, 1);
      expect(repository.lastCancelReason, 'Change of meeting location');

      // Post-cancellation: verifies exact assessed fee is rendered
      expect(find.byKey(const Key('booking_details_assessed_fee_text')), findsOneWidget);
      expect(find.text('₹30.00 (OUTSTANDING)'), findsOneWidget);
    });

    testWidgets('renders reconciliationRequired banner with Check Booking Status button (retry button NOT visible)',
        (tester) async {
      await tester.pumpWidget(_buildScreen(provider: provider));
      await tester.pumpAndSettle();

      // Simulate ambiguous failure where automatic GET also failed
      repository.errorToThrow = Exception('Network offline');
      await provider.cancelBooking(reason: 'Offline');
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('pending_cancellation_banner')), findsOneWidget);
      expect(find.text('Cancellation Status Unconfirmed'), findsOneWidget);
      expect(find.byKey(const Key('check_cancellation_status_button')), findsOneWidget);
      // Retry button MUST NOT be present
      expect(find.byKey(const Key('retry_cancellation_button')), findsNothing);
    });

    testWidgets('renders outstanding fees notice when passenger has unpaid fees',
        (tester) async {
      repository.feesToReturn = OutstandingCancellationFeesResponse(
        totalOutstandingPaise: 3000,
        fees: [
          OutstandingFeeItem(
            id: 'fee-1',
            originalBookingId: 'book-old',
            amountPaise: 3000,
            createdAt: DateTime(2026, 11, 20, 10, 0),
          ),
        ],
      );

      await tester.pumpWidget(_buildScreen(provider: provider));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('outstanding_fees_notice')), findsOneWidget);
      expect(find.text('Passenger Outstanding Balance: ₹30.00'), findsOneWidget);
    });

    testWidgets('renders error banner and retry button when loading fails',
        (tester) async {
      repository.errorToThrow = Exception('Network error');

      await tester.pumpWidget(_buildScreen(provider: provider));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('booking_details_error_text')), findsOneWidget);
      final retryBtn = find.byKey(const Key('booking_details_retry_button'));
      expect(retryBtn, findsOneWidget);

      repository.errorToThrow = null;
      await tester.tap(retryBtn);
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('booking_details_primary_card')), findsOneWidget);
    });
  });
}
