import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:uuid/uuid.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
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
import 'package:lastmile_mobile/features/booking/state/booking_details_provider.dart';

class _FakeBookingRepository implements BookingRepository {
  BookingDetails? bookingDetailsToReturn;
  BookingCancellationResponse? cancellationResponseToReturn;
  OutstandingCancellationFeesResponse? feesResponseToReturn;

  Exception? errorToThrowOnGetDetails;
  Exception? errorToThrowOnCancel;
  Exception? errorToThrowOnGetFees;
  Completer<BookingCancellationResponse>? cancelCompleter;

  int getBookingDetailsCalls = 0;
  int cancelBookingCalls = 0;
  int getFeesCalls = 0;

  String? lastCancelledBookingId;
  String? lastCancellationReason;
  String? lastCancellationIdempotencyKey;

  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async {
    getBookingDetailsCalls++;
    if (errorToThrowOnGetDetails != null) throw errorToThrowOnGetDetails!;
    return bookingDetailsToReturn ??
        BookingDetails(
          bookingId: bookingId,
          status: 'CONFIRMED',
          agreedFareCeiling: '45.00',
          maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
        );
  }

  @override
  Future<BookingCancellationResponse> cancelBooking({
    required String bookingId,
    String? reason,
    required String idempotencyKey,
  }) async {
    cancelBookingCalls++;
    lastCancelledBookingId = bookingId;
    lastCancellationReason = reason;
    lastCancellationIdempotencyKey = idempotencyKey;

    if (cancelCompleter != null) {
      return await cancelCompleter!.future;
    }

    if (errorToThrowOnCancel != null) throw errorToThrowOnCancel!;
    if (bookingDetailsToReturn != null) {
      bookingDetailsToReturn = BookingDetails(
        bookingId: bookingId,
        status: 'CANCELLED',
        agreedFareCeiling: bookingDetailsToReturn!.agreedFareCeiling,
        maxWaitDeadline: bookingDetailsToReturn!.maxWaitDeadline,
        cancellationReason: reason,
        createdAt: bookingDetailsToReturn!.createdAt,
        passengerId: bookingDetailsToReturn!.passengerId,
        pickupPointId: bookingDetailsToReturn!.pickupPointId,
        pickupPointName: bookingDetailsToReturn!.pickupPointName,
        requestedType: bookingDetailsToReturn!.requestedType,
        minGroupPreference: bookingDetailsToReturn!.minGroupPreference,
        finalAllocatedFarePaise: bookingDetailsToReturn!.finalAllocatedFarePaise,
        passengerPickupLocation:
            bookingDetailsToReturn!.passengerPickupLocation,
        destinationLocation: bookingDetailsToReturn!.destinationLocation,
        statusHistory: bookingDetailsToReturn!.statusHistory,
      );
    }
    return cancellationResponseToReturn ??
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
    getFeesCalls++;
    if (errorToThrowOnGetFees != null) throw errorToThrowOnGetFees!;
    return feesResponseToReturn ??
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

class _FixedUuid extends Uuid {
  _FixedUuid(this.fixedKey);
  final String fixedKey;

  @override
  String v4({Object? config, Map<String, dynamic>? options}) => fixedKey;
}

void main() {
  late _FakeBookingRepository repository;
  late BookingDetailsProvider provider;
  bool onCancellationConfirmedCalled = false;

  setUp(() {
    repository = _FakeBookingRepository();
    onCancellationConfirmedCalled = false;
    provider = BookingDetailsProvider(
      bookingRepository: repository,
      uuid: _FixedUuid('fixed-uuid-12345'),
      onCancellationConfirmed: () async {
        onCancellationConfirmedCalled = true;
      },
    );
  });

  group('BookingDetailsProvider Details Loading', () {
    test('loadBookingDetails loads details and kicks off outstanding fees fetch', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-1',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
        statusHistory: [
          BookingStatusHistoryItem(
            previousStatus: 'MATCHING',
            newStatus: 'CONFIRMED',
            transitionTime: DateTime(2026, 11, 20, 10, 0),
          ),
        ],
      );

      await provider.loadBookingDetails('book-1');

      expect(provider.isLoading, isFalse);
      expect(provider.error, isNull);
      expect(provider.bookingDetails?.bookingId, 'book-1');
      expect(provider.bookingDetails?.status, 'CONFIRMED');
      expect(repository.getBookingDetailsCalls, 1);
      expect(repository.getFeesCalls, 1);
    });

    test('loadBookingDetails surfaces error and leaves bookingDetails null', () async {
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: 404,
        errorCode: 'BOOKING_NOT_FOUND',
        message: 'Booking not found.',
      );

      await provider.loadBookingDetails('non-existent');

      expect(provider.isLoading, isFalse);
      expect(provider.bookingDetails, isNull);
      expect(provider.error, 'Booking not found.');
    });

    test('refreshBookingDetails updates bookingDetails and fees without clearing state', () async {
      await provider.loadBookingDetails('book-1');
      expect(repository.getBookingDetailsCalls, 1);

      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-1',
        status: 'DRIVER_ARRIVED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 4)),
      );

      await provider.refreshBookingDetails();

      expect(repository.getBookingDetailsCalls, 2);
      expect(provider.bookingDetails?.status, 'DRIVER_ARRIVED');
    });
  });

  group('BookingDetailsProvider Cancellation Flow & Retry Safety', () {
    setUp(() async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
      );
      await provider.loadBookingDetails('book-cancellable');
    });

    test('cancelBooking checks status validity before submitting', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-boarded',
        status: 'BOARDED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
      );
      await provider.loadBookingDetails('book-boarded');

      final success = await provider.cancelBooking(reason: 'Change of mind');
      expect(success, isFalse);
      expect(provider.cancellationError, contains('cannot be cancelled'));
      expect(repository.cancelBookingCalls, 0);
    });

    test('cancelBooking rejects reasons exceeding 500 characters', () async {
      final longReason = 'A' * 501;
      final success = await provider.cancelBooking(reason: longReason);
      expect(success, isFalse);
      expect(provider.cancellationError, contains('cannot exceed 500 characters'));
      expect(repository.cancelBookingCalls, 0);
    });

    test('cancelBooking succeeds, sets confirmedCancelled, and notifies active booking listener', () async {
      final success = await provider.cancelBooking(reason: 'Need to cancel');
      expect(success, isTrue);
      expect(repository.cancelBookingCalls, 1);
      expect(repository.lastCancelledBookingId, 'book-cancellable');
      expect(repository.lastCancellationReason, 'Need to cancel');
      expect(repository.lastCancellationIdempotencyKey, 'fixed-uuid-12345');
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.hasPendingCancellation, isFalse);
      expect(provider.cancellationResult?.status, 'CANCELLED');
      expect(provider.cancellationResult?.cancellationFeeAssessedPaise, 3000);
      expect(onCancellationConfirmedCalled, isTrue);
    });

    test('cancelBooking succeeds for MATCHED status with expected ₹0 fee', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-matched-1',
        status: 'MATCHED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
        createdAt: DateTime.now(),
      );
      await provider.loadBookingDetails('book-matched-1');

      expect(provider.isCancellable, isTrue);
      expect(provider.willIncurFee, isFalse);
      expect(provider.bookingDetails?.expectedCancellationFeePaise, 0);

      repository.cancellationResponseToReturn = const BookingCancellationResponse(
        bookingId: 'book-matched-1',
        status: 'CANCELLED',
        cancellationFeeAssessedPaise: 0,
        cancellationFeeStatus: 'NONE',
      );

      final success = await provider.cancelBooking(reason: 'Cancel matched group');
      expect(success, isTrue);
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.cancellationResult?.cancellationFeeAssessedPaise, 0);
      expect(provider.cancellationResult?.cancellationFeeStatus, 'NONE');
    });

    test('cancelBooking succeeds for DRIVER_ASSIGNED status with expected ₹30 fee', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-driver-assigned-1',
        status: 'DRIVER_ASSIGNED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
        createdAt: DateTime.now(),
      );
      await provider.loadBookingDetails('book-driver-assigned-1');

      expect(provider.isCancellable, isTrue);
      expect(provider.willIncurFee, isTrue);
      expect(provider.bookingDetails?.expectedCancellationFeePaise, 3000);

      repository.cancellationResponseToReturn = const BookingCancellationResponse(
        bookingId: 'book-driver-assigned-1',
        status: 'CANCELLED',
        cancellationFeeAssessedPaise: 3000,
        cancellationFeeStatus: 'OUTSTANDING',
      );

      final success = await provider.cancelBooking(reason: 'Cancel after driver assigned');
      expect(success, isTrue);
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.cancellationResult?.cancellationFeeAssessedPaise, 3000);
      expect(provider.cancellationResult?.cancellationFeeStatus, 'OUTSTANDING');
    });

    test('cancelBooking succeeds for DRIVER_ARRIVED status with expected ₹30 fee', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-driver-arrived-1',
        status: 'DRIVER_ARRIVED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
        createdAt: DateTime.now(),
      );
      await provider.loadBookingDetails('book-driver-arrived-1');

      expect(provider.isCancellable, isTrue);
      expect(provider.willIncurFee, isTrue);
      expect(provider.bookingDetails?.expectedCancellationFeePaise, 3000);

      repository.cancellationResponseToReturn = const BookingCancellationResponse(
        bookingId: 'book-driver-arrived-1',
        status: 'CANCELLED',
        cancellationFeeAssessedPaise: 3000,
        cancellationFeeStatus: 'OUTSTANDING',
      );

      final success = await provider.cancelBooking(reason: 'Cancel after driver arrived');
      expect(success, isTrue);
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.cancellationResult?.cancellationFeeAssessedPaise, 3000);
      expect(provider.cancellationResult?.cancellationFeeStatus, 'OUTSTANDING');
    });

    test('Timeout followed by automatic GET returning CANCELLED: retry cleared and blocked', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'The request timed out. Please try again.',
      );

      // Backend processed the cancel before timing out
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'CANCELLED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      final success = await provider.cancelBooking(reason: 'Timeout test');
      expect(success, isFalse);

      // Automatic GET succeeded and confirmed CANCELLED
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.hasPendingCancellation, isFalse);
      expect(provider.canRetry, isFalse);
      expect(onCancellationConfirmedCalled, isTrue);

      // Tapping retry is blocked
      final retryResult = await provider.retryCancellation();
      expect(retryResult, isFalse);
      expect(repository.cancelBookingCalls, 1); // No new POST
    });

    test('Timeout followed by automatic GET returning CONFIRMED: retry permitted with identical body and key', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'The request timed out. Please try again.',
      );

      // Backend still has CONFIRMED
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      final success = await provider.cancelBooking(reason: 'Timeout test');
      expect(success, isFalse);

      // Automatic reconciliation completed: state is retryEligible
      expect(provider.cancellationState, CancellationAttemptState.retryEligible);
      expect(provider.canRetry, isTrue);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
      expect(provider.pendingCancellationAttempt?.reason, 'Timeout test');

      // Now retry with backend restored
      repository.errorToThrowOnCancel = null;
      final retrySuccess = await provider.retryCancellation();
      expect(retrySuccess, isTrue);
      expect(repository.cancelBookingCalls, 2);
      expect(repository.lastCancellationIdempotencyKey, 'fixed-uuid-12345');
      expect(repository.lastCancellationReason, 'Timeout test');
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(onCancellationConfirmedCalled, isTrue);
    });

    test('Timeout followed by automatic GET returning DRIVER_ARRIVED: retry permitted with identical body and key', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'The request timed out. Please try again.',
      );

      // Backend still has DRIVER_ARRIVED (cancellable with fee)
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'DRIVER_ARRIVED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      final success = await provider.cancelBooking(reason: 'Driver arrived timeout');
      expect(success, isFalse);

      // Automatic reconciliation completed: state is retryEligible
      expect(provider.cancellationState, CancellationAttemptState.retryEligible);
      expect(provider.canRetry, isTrue);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
      expect(provider.pendingCancellationAttempt?.reason, 'Driver arrived timeout');

      // Now retry with backend restored
      repository.errorToThrowOnCancel = null;
      final retrySuccess = await provider.retryCancellation();
      expect(retrySuccess, isTrue);
      expect(repository.cancelBookingCalls, 2);
      expect(repository.lastCancellationIdempotencyKey, 'fixed-uuid-12345');
      expect(repository.lastCancellationReason, 'Driver arrived timeout');
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(onCancellationConfirmedCalled, isTrue);
    });

    test('Timeout followed by automatic GET returning BOARDED: retry blocked and cancellation POST count unchanged', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 503,
        errorCode: 'SERVICE_UNAVAILABLE',
        message: 'Backend unavailable',
      );

      // Backend transitioned to BOARDED
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'BOARDED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      await provider.cancelBooking(reason: 'Boarded test');

      expect(provider.cancellationState, CancellationAttemptState.cancellationBlocked);
      expect(provider.canRetry, isFalse);

      // Attempting to retry must fail and not issue another POST
      final retrySuccess = await provider.retryCancellation();
      expect(retrySuccess, isFalse);
      expect(repository.cancelBookingCalls, 1);
    });

    test('Timeout followed by automatic GET returning IN_PROGRESS: retry blocked', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 504,
        errorCode: 'GATEWAY_TIMEOUT',
        message: 'Gateway timeout',
      );

      // Backend transitioned to IN_PROGRESS
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'IN_PROGRESS',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      await provider.cancelBooking(reason: 'In progress test');

      expect(provider.cancellationState, CancellationAttemptState.cancellationBlocked);
      expect(provider.canRetry, isFalse);

      final retrySuccess = await provider.retryCancellation();
      expect(retrySuccess, isFalse);
      expect(repository.cancelBookingCalls, 1);
    });

    test('Timeout followed by automatic GET failure: snapshot preserved, retry disabled, reconciliation required', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Network offline',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Network offline',
      );

      await provider.cancelBooking(reason: 'Offline test');

      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.hasPendingCancellation, isTrue);
      expect(provider.canRetry, isFalse); // Retry disabled until GET succeeds!

      // Retrying while reconciliation is required is blocked
      final retrySuccess = await provider.retryCancellation();
      expect(retrySuccess, isFalse);
      expect(repository.cancelBookingCalls, 1);

      // Explicit reconciliation when network returns
      repository.errorToThrowOnGetDetails = null;
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      await provider.reconcileCancellation();
      expect(provider.cancellationState, CancellationAttemptState.retryEligible);
      expect(provider.canRetry, isTrue);
    });

    test('Malformed HTTP 200 (INVALID_RESPONSE) followed by GET returning CANCELLED: confirms cancellation and reconciles fee ledger', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 200,
        errorCode: 'INVALID_RESPONSE',
        message: 'Malformed response payload from cancellation endpoint',
      );

      // Backend actually committed the cancellation before response was corrupted
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'CANCELLED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
        createdAt: DateTime.now(),
      );

      final success = await provider.cancelBooking(reason: 'Malformed 200 test');
      expect(success, isFalse);

      // Automatic GET succeeded and confirmed CANCELLED
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.hasPendingCancellation, isFalse);
      expect(provider.canRetry, isFalse);
      expect(onCancellationConfirmedCalled, isTrue);

      // Further retry is blocked
      final retryResult = await provider.retryCancellation();
      expect(retryResult, isFalse);
      expect(repository.cancelBookingCalls, 1);
    });

    test('Malformed HTTP 200 (INVALID_RESPONSE) followed by GET returning cancellable status: sets retryEligible with identical key', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 200,
        errorCode: 'INVALID_RESPONSE',
        message: 'Malformed response payload from cancellation endpoint',
      );

      // Backend still has CONFIRMED
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-cancellable',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
        createdAt: DateTime.now(),
      );

      final success = await provider.cancelBooking(reason: 'Malformed 200 retry test');
      expect(success, isFalse);

      // Automatic reconciliation completed: state is retryEligible
      expect(provider.cancellationState, CancellationAttemptState.retryEligible);
      expect(provider.canRetry, isTrue);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
      expect(provider.pendingCancellationAttempt?.reason, 'Malformed 200 retry test');

      // Now retry with backend response fixed
      repository.errorToThrowOnCancel = null;
      final retrySuccess = await provider.retryCancellation();
      expect(retrySuccess, isTrue);
      expect(repository.cancelBookingCalls, 2);
      expect(repository.lastCancellationIdempotencyKey, 'fixed-uuid-12345');
      expect(repository.lastCancellationReason, 'Malformed 200 retry test');
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(onCancellationConfirmedCalled, isTrue);
    });

    test('Malformed HTTP 200 (INVALID_RESPONSE) followed by GET failure: retains snapshot, suppresses retry, requires reconciliation', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 200,
        errorCode: 'INVALID_RESPONSE',
        message: 'Malformed response payload from cancellation endpoint',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: 500,
        errorCode: 'SERVER_ERROR',
        message: 'Internal server error on status check',
      );

      final success = await provider.cancelBooking(reason: 'Malformed 200 get fail test');
      expect(success, isFalse);

      // Preserves snapshot, requires reconciliation, suppresses retry
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.hasPendingCancellation, isTrue);
      expect(provider.canRetry, isFalse);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');

      // Retry blocked while reconciliation required
      final retrySuccess = await provider.retryCancellation();
      expect(retrySuccess, isFalse);
      expect(repository.cancelBookingCalls, 1);
    });
  });

  group('Definitive Backend Error Handling', () {
    setUp(() async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-test-def',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
      );
      await provider.loadBookingDetails('book-test-def');
    });

    test('BOOKING_ALREADY_CANCELLED followed by successful GET reconciles confirmed cancelled', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 400,
        errorCode: 'BOOKING_ALREADY_CANCELLED',
        message: 'This booking has already been cancelled.',
      );
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-test-def',
        status: 'CANCELLED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      final success = await provider.cancelBooking(reason: 'Already cancelled');
      expect(success, isTrue);
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.hasPendingCancellation, isFalse);
      expect(onCancellationConfirmedCalled, isTrue);
    });

    test('BOOKING_ALREADY_CANCELLED followed by failed GET preserves reconciliationRequired and blocks new cancel', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 400,
        errorCode: 'BOOKING_ALREADY_CANCELLED',
        message: 'This booking has already been cancelled.',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: 500,
        errorCode: 'INTERNAL_ERROR',
        message: 'Server error',
      );

      final success = await provider.cancelBooking(reason: 'Already cancelled fail get');
      expect(success, isFalse);
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.hasPendingCancellation, isTrue);

      // Attempting to create a new cancellation is BLOCKED
      final newCancelSuccess = await provider.cancelBooking(reason: 'Try again with new key');
      expect(newCancelSuccess, isFalse);
      expect(provider.cancellationError, contains('Please verify server booking status'));
      expect(repository.cancelBookingCalls, 1);
    });

    test('CANNOT_CANCEL_IN_CURRENT_STATUS followed by GET returning BOARDED blocks cancellation', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 400,
        errorCode: 'CANNOT_CANCEL_IN_CURRENT_STATUS',
        message: 'Cannot cancel booking in status BOARDED.',
      );
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-test-def',
        status: 'BOARDED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      final success = await provider.cancelBooking(reason: 'Cannot cancel test');
      expect(success, isFalse);
      expect(provider.cancellationState, CancellationAttemptState.cancellationBlocked);
      expect(provider.hasPendingCancellation, isFalse);
      expect(provider.canCancel, isFalse);
    });

    test('CANNOT_CANCEL_IN_CURRENT_STATUS followed by failed GET preserves reconciliationRequired and blocks new cancel', () async {
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: 400,
        errorCode: 'CANNOT_CANCEL_IN_CURRENT_STATUS',
        message: 'Cannot cancel booking in status IN_PROGRESS.',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: 500,
        errorCode: 'SERVER_ERROR',
        message: 'Details fetch failed',
      );

      final success = await provider.cancelBooking(reason: 'Cannot cancel test');
      expect(success, isFalse);
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.hasPendingCancellation, isTrue);

      // New cancel POST blocked
      final newCancel = await provider.cancelBooking(reason: 'New cancel');
      expect(newCancel, isFalse);
      expect(repository.cancelBookingCalls, 1);
    });
  });

  group('Amount Handling and Lost Response Fee Recovery', () {
    test('Lost response with matching outstanding fee recovers exact fee item, not aggregate total', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-lost-match',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-lost-match');

      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'Timeout',
      );

      // On GET reconciliation, booking is confirmed CANCELLED
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-lost-match',
        status: 'CANCELLED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      // Outstanding fees contains an unrelated previous fee + matching fee for this booking
      repository.feesResponseToReturn = OutstandingCancellationFeesResponse(
        totalOutstandingPaise: 6000, // Aggregate total is 6000 paise (₹60.00)
        fees: [
          OutstandingFeeItem(
            id: 'fee-other',
            originalBookingId: 'book-other',
            amountPaise: 3000,
            createdAt: DateTime(2026, 11, 19, 10, 0),
          ),
          OutstandingFeeItem(
            id: 'fee-match',
            originalBookingId: 'book-lost-match',
            amountPaise: 3000, // Matching fee is 3000 paise (₹30.00)
            createdAt: DateTime(2026, 11, 20, 10, 0),
          ),
        ],
      );

      await provider.cancelBooking(reason: 'Lost match test');

      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.recoveredAssessedFee?.amountPaise, 3000);
      expect(provider.recoveredAssessedFee?.amountInRupees, 30.0);
      // Confirms we display the 3000 paise matching fee, NOT the 6000 aggregate total!
      expect(provider.recoveredAssessedFee?.amountPaise != provider.outstandingFees?.totalOutstandingPaise, isTrue);
      expect(provider.isAssessedFeeUnavailable, isFalse);
    });

    test('Lost response without matching fee in ledger marks fee unavailable (does not assume ₹0 or free)', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-lost-nomatch',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-lost-nomatch');

      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'Timeout',
      );

      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-lost-nomatch',
        status: 'CANCELLED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      // Ledger has 0 fees or no matching fee for this booking
      repository.feesResponseToReturn = const OutstandingCancellationFeesResponse(
        totalOutstandingPaise: 0,
        fees: [],
      );

      await provider.cancelBooking(reason: 'No match test');

      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.recoveredAssessedFee, isNull);
      expect(provider.isAssessedFeeUnavailable, isTrue); // Does NOT assume zero or free!
    });

    test('Failed fee refresh does not erase confirmed booking details', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-fail-fee',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-fail-fee');

      repository.errorToThrowOnGetFees = const ApiException(
        statusCode: 500,
        errorCode: 'SERVER_ERROR',
        message: 'Ledger unavailable',
      );

      final success = await provider.cancelBooking(reason: 'Fee fail test');
      expect(success, isTrue);
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.bookingDetails?.bookingId, 'book-fail-fee');
      expect(provider.bookingDetails?.status, 'CANCELLED'); // Details NOT erased!
      expect(provider.feesError, contains('Ledger unavailable'));
    });
  });

  group('Cancellation State Machine and Refresh Resilience', () {
    test('Calling cancelBooking() again during reconciliationRequired must not issue another POST or generate a new key', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-recon-block',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-recon-block');

      // Ambiguous failure and GET fails, putting provider in reconciliationRequired
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Network offline',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Cannot reach server',
      );

      final firstResult = await provider.cancelBooking(reason: 'Initial cancel');
      expect(firstResult, isFalse);
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
      expect(repository.cancelBookingCalls, 1);

      // Attempting cancelBooking() again while in reconciliationRequired
      final secondResult = await provider.cancelBooking(reason: 'Bypass cancel');
      expect(secondResult, isFalse);
      expect(repository.cancelBookingCalls, 1); // No new POST issued!
      expect(provider.cancellationError, contains('Please verify server booking status'));
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345'); // Preserved
    });

    test('Calling cancelBooking() in retryEligible must not bypass retryCancellation()', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-retry-elig',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-retry-elig');

      // Ambiguous failure, but GET succeeds and returns CONFIRMED -> retryEligible
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'Timeout',
      );

      final cancelRes = await provider.cancelBooking(reason: 'Initial cancel');
      expect(cancelRes, isFalse);
      expect(provider.cancellationState, CancellationAttemptState.retryEligible);
      expect(provider.canRetry, isTrue);
      expect(repository.cancelBookingCalls, 1);

      // Calling cancelBooking() again instead of retryCancellation() must be rejected
      final bypassRes = await provider.cancelBooking(reason: 'New cancel attempt');
      expect(bypassRes, isFalse);
      expect(repository.cancelBookingCalls, 1); // Still 1! No new POST
      expect(provider.cancellationError, contains('use retryCancellation()'));
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
    });

    test('Refreshing the same booking during reconciliationRequired preserves the original snapshot and key', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-preserve-key',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-preserve-key');

      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Offline',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Server unreachable',
      );

      await provider.cancelBooking(reason: 'Preserve test');
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');

      // Now server is reachable and still returns CONFIRMED
      repository.errorToThrowOnGetDetails = null;
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-preserve-key',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      // Refreshing booking details for the same booking
      await provider.refreshBookingDetails();

      // State transitions to retryEligible, preserving snapshot and original idempotency key
      expect(provider.cancellationState, CancellationAttemptState.retryEligible);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
      expect(provider.pendingCancellationAttempt?.reason, 'Preserve test');
      expect(provider.canRetry, isTrue);
    });

    test('Refresh GET failure preserves the pending snapshot and suppresses retry', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-fail-refresh',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-fail-refresh');

      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Offline',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Server unreachable',
      );

      await provider.cancelBooking(reason: 'Suppression test');
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.canRetry, isFalse);

      // Another refresh attempt fails
      await provider.refreshBookingDetails();

      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.canRetry, isFalse);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
      expect(provider.hasPendingCancellation, isTrue);
    });

    test('Refresh GET returning CANCELLED clears the snapshot only after confirmation', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-reconcile-cancelled',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-reconcile-cancelled');

      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Offline',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Server unreachable',
      );

      await provider.cancelBooking(reason: 'Clear after confirm');
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.pendingCancellationAttempt, isNotNull);

      // Later, refresh GET discovers that the cancellation actually went through!
      repository.errorToThrowOnGetDetails = null;
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-reconcile-cancelled',
        status: 'CANCELLED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      await provider.refreshBookingDetails();

      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.pendingCancellationAttempt, isNull);
      expect(provider.bookingDetails?.status, 'CANCELLED');
      expect(onCancellationConfirmedCalled, isTrue);
    });

    test('Refresh GET returning a cancellable status permits retry with the original key', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-permit-retry',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-permit-retry');

      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Offline',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Server unreachable',
      );

      await provider.cancelBooking(reason: 'Retry with orig key');
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);

      // Later, loadBookingDetails for the same booking succeeds and reports DRIVER_ASSIGNED
      repository.errorToThrowOnGetDetails = null;
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-permit-retry',
        status: 'DRIVER_ASSIGNED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      await provider.loadBookingDetails('book-permit-retry');

      expect(provider.cancellationState, CancellationAttemptState.retryEligible);
      expect(provider.canRetry, isTrue);
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');

      // Now call retryCancellation()
      repository.errorToThrowOnCancel = null;
      final retrySuccess = await provider.retryCancellation();

      expect(retrySuccess, isTrue);
      expect(repository.cancelBookingCalls, 2);
      expect(repository.lastCancellationIdempotencyKey, 'fixed-uuid-12345'); // Exact same key reused!
      expect(repository.lastCancellationReason, 'Retry with orig key');
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.pendingCancellationAttempt, isNull);
    });

    test('Pending attempt for booking A, followed by a request to load booking B: A\'s snapshot, key, booking details, and reconciliation state must not be overwritten or stranded', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-A',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-A');

      // Ambiguous cancellation failure + failed GET leaves pending attempt in reconciliationRequired
      repository.errorToThrowOnCancel = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Offline',
      );
      repository.errorToThrowOnGetDetails = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Server unreachable',
      );

      final cancelRes = await provider.cancelBooking(reason: 'Reason A');
      expect(cancelRes, isFalse);
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      expect(provider.pendingCancellationAttempt?.bookingId, 'book-A');
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
      expect(provider.pendingCancellationAttempt?.reason, 'Reason A');
      expect(provider.bookingDetails?.bookingId, 'book-A');

      final initialGetCalls = repository.getBookingDetailsCalls;

      // Attempting to load booking B while booking A's attempt is unresolved
      await provider.loadBookingDetails('book-B');

      // Provider rejects loading B, keeps A's details, snapshot, key, and reconciliation state
      expect(provider.error, contains('Cannot load booking book-B'));
      expect(provider.error, contains('book-A'));
      expect(provider.bookingDetails?.bookingId, 'book-A');
      expect(provider.pendingCancellationAttempt?.bookingId, 'book-A');
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
      expect(provider.pendingCancellationAttempt?.reason, 'Reason A');
      expect(provider.cancellationState, CancellationAttemptState.reconciliationRequired);
      // Ensure no network GET was issued for book-B
      expect(repository.getBookingDetailsCalls, initialGetCalls);

      // Now verify refresh still resolves booking A
      repository.errorToThrowOnGetDetails = null;
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-A',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      await provider.refreshBookingDetails();
      expect(provider.cancellationState, CancellationAttemptState.retryEligible);
      expect(provider.bookingDetails?.bookingId, 'book-A');
      expect(provider.pendingCancellationAttempt?.bookingId, 'book-A');
      expect(provider.pendingCancellationAttempt?.idempotencyKey, 'fixed-uuid-12345');
    });

    test('Cancellation POST held in-flight while a refresh GET returns a cancellable status: state must remain submitting, retryCancellation() must return false, and cancellation POST count must remain one', () async {
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-in-flight',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );
      await provider.loadBookingDetails('book-in-flight');

      final cancelCompleter = Completer<BookingCancellationResponse>();
      repository.cancelCompleter = cancelCompleter;

      // Kick off cancellation POST (held in-flight by cancelCompleter)
      final cancelFuture = provider.cancelBooking(reason: 'In flight test');

      // State is submitting
      expect(provider.cancellationState, CancellationAttemptState.submitting);
      expect(provider.isCancelling, isTrue);
      expect(repository.cancelBookingCalls, 1);

      // Independent refresh GET returns cancellable status (CONFIRMED)
      repository.bookingDetailsToReturn = BookingDetails(
        bookingId: 'book-in-flight',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now(),
      );

      await provider.refreshBookingDetails();

      // State MUST remain submitting, NOT transition to retryEligible
      expect(provider.cancellationState, CancellationAttemptState.submitting);
      expect(provider.canRetry, isFalse);

      // Attempting to retry cancellation while POST is still in flight must return false
      final retryResult = await provider.retryCancellation();
      expect(retryResult, isFalse);
      expect(repository.cancelBookingCalls, 1); // Still exactly 1!

      // Attempting a second cancelBooking() while in-flight must also return false
      final secondCancelResult = await provider.cancelBooking(reason: 'Duplicate attempt');
      expect(secondCancelResult, isFalse);
      expect(repository.cancelBookingCalls, 1); // Still exactly 1!

      // Now let the original POST settle
      cancelCompleter.complete(
        const BookingCancellationResponse(
          bookingId: 'book-in-flight',
          status: 'CANCELLED',
          cancellationFeeAssessedPaise: 3000,
          cancellationFeeStatus: 'OUTSTANDING',
        ),
      );

      final cancelResult = await cancelFuture;
      expect(cancelResult, isTrue);
      expect(provider.cancellationState, CancellationAttemptState.confirmedCancelled);
      expect(provider.pendingCancellationAttempt, isNull);
    });
  });
}
