import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../../../core/network/api_exception.dart';
import '../data/booking_repository.dart';
import '../models/booking_cancellation_response.dart';
import '../models/booking_details.dart';
import '../models/cancellation_fee.dart';

/// Immutable snapshot representing an in-flight or pending cancellation attempt.
@immutable
class CancellationSnapshot {
  const CancellationSnapshot({
    required this.bookingId,
    this.reason,
    required this.idempotencyKey,
  });

  final String bookingId;
  final String? reason;
  final String idempotencyKey;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CancellationSnapshot &&
          runtimeType == other.runtimeType &&
          bookingId == other.bookingId &&
          reason == other.reason &&
          idempotencyKey == other.idempotencyKey;

  @override
  int get hashCode => Object.hash(bookingId, reason, idempotencyKey);
}

/// Explicit lifecycle states for a booking cancellation attempt.
enum CancellationAttemptState {
  /// No cancellation attempt is active.
  idle,

  /// A cancellation request is actively in-flight.
  submitting,

  /// An ambiguous failure or unresolved response occurred; authoritative GET reconciliation is required.
  reconciliationRequired,

  /// Authoritative GET succeeded and confirmed the booking is still cancellable; safe to retry.
  retryEligible,

  /// Cancellation has been definitively confirmed on the backend.
  confirmedCancelled,

  /// Authoritative backend state indicates cancellation is no longer permitted (e.g. BOARDED, IN_PROGRESS).
  cancellationBlocked,
}

/// Provider managing single booking details, lifecycle history, cancellation state machine,
/// idempotent retries, and passenger outstanding fee tracking.
class BookingDetailsProvider extends ChangeNotifier {
  BookingDetailsProvider({
    required this.bookingRepository,
    Uuid? uuid,
    this.onCancellationConfirmed,
  }) : _uuid = uuid ?? const Uuid();

  final BookingRepository bookingRepository;
  final Uuid _uuid;

  /// Optional callback invoked when a cancellation is definitively confirmed
  /// (used to reconcile active bookings on passenger home without tight coupling).
  final Future<void> Function()? onCancellationConfirmed;

  // Booking details state
  bool _isLoading = false;
  bool _isRefreshing = false;
  String? _error;
  BookingDetails? _bookingDetails;

  // Cancellation state machine
  CancellationAttemptState _cancellationState = CancellationAttemptState.idle;
  String? _cancellationError;
  BookingCancellationResponse? _cancellationResult;
  CancellationSnapshot? _pendingCancellationAttempt;
  OutstandingFeeItem? _recoveredAssessedFee;
  bool _isAssessedFeeUnavailable = false;

  // Outstanding fees state
  bool _isLoadingFees = false;
  String? _feesError;
  OutstandingCancellationFeesResponse? _outstandingFees;

  // Getters
  bool get isLoading => _isLoading;
  bool get isRefreshing => _isRefreshing;
  String? get error => _error;
  BookingDetails? get bookingDetails => _bookingDetails;

  CancellationAttemptState get cancellationState => _cancellationState;
  bool get isCancelling =>
      _cancellationState == CancellationAttemptState.submitting;
  String? get cancellationError => _cancellationError;
  BookingCancellationResponse? get cancellationResult => _cancellationResult;
  CancellationSnapshot? get pendingCancellationAttempt =>
      _pendingCancellationAttempt;
  bool get hasPendingCancellation => _pendingCancellationAttempt != null;

  OutstandingFeeItem? get recoveredAssessedFee => _recoveredAssessedFee;
  bool get isAssessedFeeUnavailable => _isAssessedFeeUnavailable;

  bool get isLoadingFees => _isLoadingFees;
  String? get feesError => _feesError;
  OutstandingCancellationFeesResponse? get outstandingFees => _outstandingFees;

  /// Whether a brand-new cancellation request can be submitted.
  bool get canCancel =>
      _bookingDetails != null &&
      _bookingDetails!.isCancellable &&
      _cancellationState == CancellationAttemptState.idle &&
      _pendingCancellationAttempt == null;

  /// Whether the current attempt is strictly eligible for retry.
  bool get canRetry =>
      _cancellationState == CancellationAttemptState.retryEligible &&
      _pendingCancellationAttempt != null &&
      _bookingDetails != null &&
      _bookingDetails!.isCancellable;

  /// Convenience getters delegating to current booking details
  bool get isCancellable => _bookingDetails?.isCancellable ?? false;
  bool get willIncurFee => _bookingDetails?.willIncurCancellationFee ?? false;

  /// Loads full booking details and kicks off outstanding fees fetch.
  Future<void> loadBookingDetails(String bookingId) async {
    // 1. Guard against switching bookings while a cancellation attempt is unresolved
    if (_pendingCancellationAttempt != null &&
        _pendingCancellationAttempt!.bookingId != bookingId) {
      _error =
          'Cannot load booking $bookingId while cancellation attempt for ${_pendingCancellationAttempt!.bookingId} is unresolved.';
      notifyListeners();
      return;
    }

    final isSameBooking = (_bookingDetails?.bookingId == bookingId) ||
        (_pendingCancellationAttempt?.bookingId == bookingId);

    // Reset state only when safely loading a different booking and no unresolved cancellation attempt would be lost
    if (!isSameBooking && _pendingCancellationAttempt == null) {
      _bookingDetails = null;
      _cancellationState = CancellationAttemptState.idle;
      _pendingCancellationAttempt = null;
      _cancellationError = null;
      _cancellationResult = null;
      _recoveredAssessedFee = null;
      _isAssessedFeeUnavailable = false;
    }

    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      final fresh = await bookingRepository.getBookingDetails(bookingId);
      _error = null;
      await _applyReconciledBooking(fresh, bookingId);
    } catch (e) {
      _error = e is ApiException
          ? e.message
          : 'Failed to load booking details: ${e.toString()}';

      // If GET fails, preserve reconciliationRequired and the pending snapshot!
      if (_pendingCancellationAttempt != null &&
          _pendingCancellationAttempt!.bookingId == bookingId) {
        _cancellationState = CancellationAttemptState.reconciliationRequired;
      }
    } finally {
      _isLoading = false;
      notifyListeners();
    }

    loadOutstandingFees();
  }

  /// Refreshes booking details without showing fullscreen loading spinner.
  Future<void> refreshBookingDetails() async {
    final bookingId = _pendingCancellationAttempt?.bookingId ??
        _bookingDetails?.bookingId;
    if (bookingId == null || _isRefreshing) return;

    _isRefreshing = true;
    notifyListeners();

    try {
      final updated = await bookingRepository.getBookingDetails(bookingId);
      _error = null;
      await _applyReconciledBooking(updated, bookingId);
    } catch (e) {
      _error = e is ApiException
          ? e.message
          : 'Failed to refresh booking details: ${e.toString()}';

      if (_pendingCancellationAttempt != null &&
          _pendingCancellationAttempt!.bookingId == bookingId) {
        _cancellationState = CancellationAttemptState.reconciliationRequired;
      }
    } finally {
      _isRefreshing = false;
      notifyListeners();
    }

    loadOutstandingFees();
  }

  Future<void> _applyReconciledBooking(
    BookingDetails updated,
    String bookingId,
  ) async {
    // If a pending cancellation attempt exists for a different booking,
    // do not apply this booking's details or touch cancellation state.
    if (_pendingCancellationAttempt != null &&
        _pendingCancellationAttempt!.bookingId != bookingId) {
      return;
    }

    _bookingDetails = updated;

    // While an active cancellation POST is in flight, preserve submitting state
    // and do not alter the pending snapshot or transition to retryEligible.
    if (_cancellationState == CancellationAttemptState.submitting) {
      return;
    }

    if (_pendingCancellationAttempt != null &&
        _pendingCancellationAttempt!.bookingId == bookingId) {
      if (updated.status == 'CANCELLED') {
        _cancellationState = CancellationAttemptState.confirmedCancelled;
        _pendingCancellationAttempt = null;
        _cancellationError = null;
        await _reconcileOutstandingFeesForCancelledBooking(bookingId);
        _notifyCancellationConfirmed();
      } else if (updated.isCancellable) {
        _cancellationState = CancellationAttemptState.retryEligible;
        _cancellationError =
            'Server confirmed booking is still ${updated.status}. You may safely retry cancellation.';
      } else {
        _cancellationState = CancellationAttemptState.cancellationBlocked;
        _pendingCancellationAttempt = null;
        _cancellationError =
            'Booking transitioned to ${updated.status}. Cancellation is no longer permitted.';
      }
    } else {
      if (updated.status == 'CANCELLED') {
        _cancellationState = CancellationAttemptState.confirmedCancelled;
      } else if (!updated.isCancellable) {
        _cancellationState = CancellationAttemptState.cancellationBlocked;
      } else if (_cancellationState != CancellationAttemptState.submitting) {
        _cancellationState = CancellationAttemptState.idle;
      }
    }
  }

  /// Loads outstanding cancellation fees for the authenticated passenger.
  Future<void> loadOutstandingFees() async {
    _isLoadingFees = true;
    _feesError = null;
    notifyListeners();

    try {
      _outstandingFees =
          await bookingRepository.getOutstandingCancellationFees();
      _feesError = null;
    } catch (e) {
      _feesError = e is ApiException
          ? e.message
          : 'Failed to load outstanding fees: ${e.toString()}';
    } finally {
      _isLoadingFees = false;
      notifyListeners();
    }
  }

  /// Cancels the booking using a freshly generated idempotency key and immutable snapshot.
  Future<bool> cancelBooking({String? reason}) async {
    // 1. Guard against duplicate submission while request is in flight
    if (_cancellationState == CancellationAttemptState.submitting) {
      return false;
    }

    // 2. In retryEligible, require the caller to use retryCancellation()
    if (_cancellationState == CancellationAttemptState.retryEligible) {
      _cancellationError =
          'An unresolved cancellation attempt exists. Please use retryCancellation() to retry.';
      notifyListeners();
      return false;
    }

    // 3. Reject fresh cancellation whenever _pendingCancellationAttempt already exists
    // or when authoritative verification is required
    if (_cancellationState ==
            CancellationAttemptState.reconciliationRequired ||
        _pendingCancellationAttempt != null) {
      _cancellationError =
          'Please verify server booking status before submitting another cancellation.';
      notifyListeners();
      return false;
    }

    // 4. Block if already cancelled or blocked
    if (_cancellationState == CancellationAttemptState.confirmedCancelled) {
      _cancellationError = 'This booking has already been cancelled.';
      notifyListeners();
      return false;
    }
    if (_cancellationState == CancellationAttemptState.cancellationBlocked) {
      _cancellationError =
          'Booking is in a non-cancellable status and cannot be cancelled.';
      notifyListeners();
      return false;
    }

    if (_bookingDetails == null || !_bookingDetails!.isCancellable) {
      _cancellationError =
          'Booking in status ${_bookingDetails?.status ?? 'UNKNOWN'} cannot be cancelled.';
      notifyListeners();
      return false;
    }

    final trimmedReason = reason?.trim();
    if (trimmedReason != null && trimmedReason.length > 500) {
      _cancellationError = 'Cancellation reason cannot exceed 500 characters.';
      notifyListeners();
      return false;
    }

    final idempotencyKey = _uuid.v4();
    final snapshot = CancellationSnapshot(
      bookingId: _bookingDetails!.bookingId,
      reason: trimmedReason?.isNotEmpty == true ? trimmedReason : null,
      idempotencyKey: idempotencyKey,
    );

    _pendingCancellationAttempt = snapshot;
    return _dispatchCancellation(snapshot);
  }

  /// Retries an uncertain cancellation attempt using the exact same snapshot and idempotency key.
  ///
  /// CRITICAL INVARIANT: Permitted ONLY when authoritative GET has verified that the booking
  /// is still in a cancellable status (`CancellationAttemptState.retryEligible`).
  Future<bool> retryCancellation() async {
    // 1. Multiple retry taps while submitting are blocked
    if (_cancellationState == CancellationAttemptState.submitting) {
      return false;
    }

    // 2. Retry blocked unless authoritatively verified as retry-eligible
    if (_cancellationState != CancellationAttemptState.retryEligible) {
      _cancellationError =
          'Cancellation cannot be retried until booking status is verified with the server.';
      notifyListeners();
      return false;
    }

    if (_pendingCancellationAttempt == null) {
      _cancellationError = 'No pending cancellation attempt to retry.';
      notifyListeners();
      return false;
    }

    if (_bookingDetails == null || !_bookingDetails!.isCancellable) {
      _cancellationState = CancellationAttemptState.cancellationBlocked;
      _cancellationError =
          'Booking is no longer eligible for cancellation (${_bookingDetails?.status ?? 'UNKNOWN'}).';
      notifyListeners();
      return false;
    }

    return _dispatchCancellation(_pendingCancellationAttempt!);
  }

  /// Reconciles ambiguous cancellation state by querying authoritative booking details.
  Future<void> reconcileCancellation() async {
    if (_cancellationState == CancellationAttemptState.submitting) return;

    final bookingId = _pendingCancellationAttempt?.bookingId ??
        _bookingDetails?.bookingId;
    if (bookingId == null) return;

    _isLoading = true;
    _cancellationError = null;
    notifyListeners();

    try {
      final fresh = await bookingRepository.getBookingDetails(bookingId);
      _cancellationError = null;
      await _applyReconciledBooking(fresh, bookingId);
    } catch (e) {
      _cancellationError = e is ApiException
          ? e.message
          : 'Failed to verify booking status: ${e.toString()}';
      if (_pendingCancellationAttempt != null) {
        _cancellationState = CancellationAttemptState.reconciliationRequired;
      }
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<bool> _dispatchCancellation(CancellationSnapshot snapshot) async {
    _cancellationState = CancellationAttemptState.submitting;
    _cancellationError = null;
    notifyListeners();

    try {
      final response = await bookingRepository.cancelBooking(
        bookingId: snapshot.bookingId,
        reason: snapshot.reason,
        idempotencyKey: snapshot.idempotencyKey,
      );

      _cancellationResult = response;
      _cancellationState = CancellationAttemptState.confirmedCancelled;
      _pendingCancellationAttempt = null;
      _cancellationError = null;
      _recoveredAssessedFee = null;
      _isAssessedFeeUnavailable = false;

      // Authoritatively update details and fees
      try {
        final updated =
            await bookingRepository.getBookingDetails(snapshot.bookingId);
        _bookingDetails = updated;
      } catch (_) {
        // If details refresh fails, do NOT invent a cancellation timestamp!
        // Preserve the confirmed booking response fields with confirmed CANCELLED status.
        if (_bookingDetails != null) {
          _bookingDetails = BookingDetails(
            bookingId: _bookingDetails!.bookingId,
            status: 'CANCELLED',
            agreedFareCeiling: _bookingDetails!.agreedFareCeiling,
            maxWaitDeadline: _bookingDetails!.maxWaitDeadline,
            passengerId: _bookingDetails!.passengerId,
            pickupPointId: _bookingDetails!.pickupPointId,
            pickupPointName: _bookingDetails!.pickupPointName,
            requestedType: _bookingDetails!.requestedType,
            minGroupPreference: _bookingDetails!.minGroupPreference,
            finalAllocatedFarePaise: _bookingDetails!.finalAllocatedFarePaise,
            cancellationReason: snapshot.reason,
            cancelledAt: null, // No fabricated timestamp
            createdAt: _bookingDetails!.createdAt,
            passengerPickupLocation: _bookingDetails!.passengerPickupLocation,
            destinationLocation: _bookingDetails!.destinationLocation,
            statusHistory: _bookingDetails!.statusHistory,
          );
        }
      }

      await loadOutstandingFees();
      _notifyCancellationConfirmed();
      return true;
    } on ApiException catch (e) {
      if (e.errorCode == 'BOOKING_ALREADY_CANCELLED') {
        // Server confirms already cancelled: reconcile authoritatively via GET
        return _handleBookingAlreadyCancelled(snapshot);
      }

      if (e.errorCode == 'CANNOT_CANCEL_IN_CURRENT_STATUS') {
        // Server rejected due to state transition: reconcile authoritatively via GET
        return _handleCannotCancelInCurrentStatus(snapshot, e.message);
      }

      final isAmbiguous = e.errorCode == 'NETWORK_UNAVAILABLE' ||
          e.errorCode == 'REQUEST_TIMEOUT' ||
          e.errorCode == 'IDEMPOTENCY_IN_PROGRESS' ||
          e.errorCode == 'INVALID_RESPONSE' ||
          (e.statusCode != null && e.statusCode! >= 500);

      if (isAmbiguous) {
        // Retain snapshot, mark reconciliationRequired, and immediately execute automatic reconciliation
        _pendingCancellationAttempt = snapshot;
        _cancellationState = CancellationAttemptState.reconciliationRequired;
        _cancellationError = e.message;
        notifyListeners();

        await _runAutomaticReconciliation(snapshot);
        return false;
      } else {
        // Definite client-side or permissions error (403 Forbidden, 404 Not Found)
        _pendingCancellationAttempt = null;
        _cancellationState = CancellationAttemptState.idle;
        _cancellationError = e.message;
        notifyListeners();
        return false;
      }
    } catch (e) {
      // Non-ApiException network/socket error: ambiguous failure
      _pendingCancellationAttempt = snapshot;
      _cancellationState = CancellationAttemptState.reconciliationRequired;
      _cancellationError = 'Cancellation network error: ${e.toString()}';
      notifyListeners();

      await _runAutomaticReconciliation(snapshot);
      return false;
    }
  }

  /// Automatically reconciles an ambiguous cancellation attempt via GET /bookings/:id.
  Future<void> _runAutomaticReconciliation(
    CancellationSnapshot snapshot,
  ) async {
    try {
      final fresh =
          await bookingRepository.getBookingDetails(snapshot.bookingId);
      _bookingDetails = fresh;

      if (fresh.status == 'CANCELLED') {
        _cancellationState = CancellationAttemptState.confirmedCancelled;
        _pendingCancellationAttempt = null;
        _cancellationError = null;

        await _reconcileOutstandingFeesForCancelledBooking(snapshot.bookingId);
        _notifyCancellationConfirmed();
      } else if (fresh.isCancellable) {
        _cancellationState = CancellationAttemptState.retryEligible;
        _cancellationError =
            'Cancellation was interrupted, but booking is still ${fresh.status}. You may retry cancellation.';
      } else {
        _cancellationState = CancellationAttemptState.cancellationBlocked;
        _pendingCancellationAttempt = null;
        _cancellationError =
            'Booking transitioned to ${fresh.status} and can no longer be cancelled.';
      }
    } catch (getError) {
      // Automatic GET also failed: retain snapshot, require explicit status check, block retry
      _cancellationState = CancellationAttemptState.reconciliationRequired;
      _cancellationError =
          'Cancellation response was interrupted and status check failed: ${getError is ApiException ? getError.message : getError.toString()}. Please check status.';
    } finally {
      notifyListeners();
    }
  }

  /// Handles BOOKING_ALREADY_CANCELLED by reconciling authoritatively.
  Future<bool> _handleBookingAlreadyCancelled(
    CancellationSnapshot snapshot,
  ) async {
    _cancellationState = CancellationAttemptState.reconciliationRequired;
    notifyListeners();

    try {
      final fresh =
          await bookingRepository.getBookingDetails(snapshot.bookingId);
      _bookingDetails = fresh;
      _cancellationState = CancellationAttemptState.confirmedCancelled;
      _pendingCancellationAttempt = null;
      _cancellationError = null;

      await _reconcileOutstandingFeesForCancelledBooking(snapshot.bookingId);
      _notifyCancellationConfirmed();
      notifyListeners();
      return true;
    } catch (e) {
      // If GET fails, retain snapshot to block new attempts and allow status retry
      _pendingCancellationAttempt = snapshot;
      _cancellationState = CancellationAttemptState.reconciliationRequired;
      _cancellationError =
          'Booking is already cancelled on server, but refreshing details failed. Please check booking status.';
      notifyListeners();
      return false;
    }
  }

  /// Handles CANNOT_CANCEL_IN_CURRENT_STATUS by reconciling authoritatively.
  Future<bool> _handleCannotCancelInCurrentStatus(
    CancellationSnapshot snapshot,
    String backendErrorMessage,
  ) async {
    _cancellationState = CancellationAttemptState.reconciliationRequired;
    notifyListeners();

    try {
      final fresh =
          await bookingRepository.getBookingDetails(snapshot.bookingId);
      _bookingDetails = fresh;
      _cancellationState = CancellationAttemptState.cancellationBlocked;
      _pendingCancellationAttempt = null;
      _cancellationError = backendErrorMessage;
      notifyListeners();
      return false;
    } catch (e) {
      // If GET fails, retain snapshot in reconciliationRequired to block new cancel POSTs
      _pendingCancellationAttempt = snapshot;
      _cancellationState = CancellationAttemptState.reconciliationRequired;
      _cancellationError =
          'Cannot cancel in current status. Status check failed: ${e is ApiException ? e.message : e.toString()}. Please check status.';
      notifyListeners();
      return false;
    }
  }

  /// Recovers the exact assessed fee when the POST response was lost, without inventing an amount.
  Future<void> _reconcileOutstandingFeesForCancelledBooking(
    String bookingId,
  ) async {
    try {
      final feesResponse =
          await bookingRepository.getOutstandingCancellationFees();
      _outstandingFees = feesResponse;
      _feesError = null;

      // Search for fee item matching this specific bookingId
      final matches = feesResponse.fees
          .where((f) => f.originalBookingId == bookingId)
          .toList();

      if (matches.isNotEmpty) {
        _recoveredAssessedFee = matches.first;
        _isAssessedFeeUnavailable = false;
      } else {
        // Do NOT assume ₹0 or free! Explicitly mark as unavailable from read endpoint
        _recoveredAssessedFee = null;
        _isAssessedFeeUnavailable = true;
      }
    } catch (e) {
      // Failed fee refresh does NOT erase confirmed booking details!
      _feesError = e is ApiException
          ? e.message
          : 'Failed to refresh outstanding fees: ${e.toString()}';
      _isAssessedFeeUnavailable = true;
    }
  }

  void _notifyCancellationConfirmed() {
    if (onCancellationConfirmed != null) {
      onCancellationConfirmed!().catchError((_) {});
    }
  }

  /// Clears cancellation errors.
  void clearCancellationError() {
    _cancellationError = null;
    notifyListeners();
  }
}
