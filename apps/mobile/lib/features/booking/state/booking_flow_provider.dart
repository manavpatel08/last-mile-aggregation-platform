import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';
import 'package:uuid/uuid.dart';

import '../../../core/network/api_exception.dart';
import '../data/booking_repository.dart';
import '../models/booking_request.dart';
import '../models/booking_response.dart';
import '../models/fare_quote.dart';
import '../models/location_validation.dart';
import '../models/pickup_point.dart';
import '../models/service_region.dart';
import '../services/passenger_location_service.dart';

/// State management provider for the passenger fare quote and booking request flow.
class BookingFlowProvider extends ChangeNotifier {
  BookingFlowProvider({
    required this.bookingRepository,
    required this.locationService,
    Uuid? uuid,
  }) : _uuid = uuid ?? const Uuid();

  final BookingRepository bookingRepository;
  final PassengerLocationService locationService;
  final Uuid _uuid;

  // Initial loading states
  bool _isLoadingInitialData = false;
  String? _initialDataError;
  List<PickupPoint> _pickupPoints = [];
  List<ServiceRegion> _serviceRegions = [];

  // Selected pickup point
  PickupPoint? _selectedPickupPoint;

  // Passenger device location & geofence
  LatLng? _passengerLocation;
  bool _isAcquiringLocation = false;
  String? _locationErrorMessage;
  PickupValidationResult? _pickupValidation;

  // Selected destination
  LatLng? _selectedDestination;
  bool _isValidatingDestination = false;
  DestinationValidationResult? _destinationValidation;
  String? _destinationError;

  // Fare quote
  FareQuote? _fareQuote;
  bool _isLoadingQuote = false;
  String? _quoteError;
  Timer? _quoteCountdownTimer;
  Duration _remainingQuoteDuration = Duration.zero;
  bool _isQuoteExpired = false;

  // Ride configuration
  String _requestedType = 'SHARED'; // 'SHARED' or 'PRIVATE'
  int _minGroupPreference = 2; // 2..4
  bool _upfrontConsentAgreed = false;

  // Submission state & idempotency
  bool _isSubmittingBooking = false;
  String? _submissionError;
  String? _currentIdempotencyKey;
  BookingRequest? _pendingRequestSnapshot;
  bool _isReconciling = false;
  BookingResponse? _createdBooking;

  // Getters
  bool get isLoadingInitialData => _isLoadingInitialData;
  String? get initialDataError => _initialDataError;
  List<PickupPoint> get pickupPoints => _pickupPoints;
  List<ServiceRegion> get serviceRegions => _serviceRegions;
  PickupPoint? get selectedPickupPoint => _selectedPickupPoint;

  LatLng? get passengerLocation => _passengerLocation;
  bool get isAcquiringLocation => _isAcquiringLocation;
  String? get locationErrorMessage => _locationErrorMessage;
  PickupValidationResult? get pickupValidation => _pickupValidation;

  LatLng? get selectedDestination => _selectedDestination;
  bool get isValidatingDestination => _isValidatingDestination;
  DestinationValidationResult? get destinationValidation =>
      _destinationValidation;
  String? get destinationError => _destinationError;

  FareQuote? get fareQuote => _fareQuote;
  bool get isLoadingQuote => _isLoadingQuote;
  String? get quoteError => _quoteError;
  Duration get remainingQuoteDuration => _remainingQuoteDuration;
  bool get isQuoteExpired => _isQuoteExpired;

  String get requestedType => _requestedType;
  int get minGroupPreference => _minGroupPreference;
  bool get upfrontConsentAgreed => _upfrontConsentAgreed;

  bool get isSubmittingBooking => _isSubmittingBooking;
  String? get submissionError => _submissionError;
  String? get currentIdempotencyKey => _currentIdempotencyKey;
  BookingRequest? get pendingRequestSnapshot => _pendingRequestSnapshot;
  bool get hasPendingSubmission =>
      _pendingRequestSnapshot != null && _createdBooking == null;
  bool get isReconciling => _isReconciling;
  BookingResponse? get createdBooking => _createdBooking;

  bool get canRequestQuote =>
      !hasPendingSubmission &&
      _selectedPickupPoint != null &&
      _selectedDestination != null &&
      _destinationValidation?.isInsideServiceRegion == true &&
      !_isLoadingQuote;

  bool get canSubmitBooking {
    if (_isSubmittingBooking || _isReconciling) return false;
    if (hasPendingSubmission) {
      // In retry mode, the immutable snapshot is pending and ready to retry
      return true;
    }
    return _fareQuote != null &&
        !_isQuoteExpired &&
        _upfrontConsentAgreed;
  }

  /// Loads initial pickup hubs, service regions, and passenger GPS fix.
  Future<void> loadInitialData() async {
    _isLoadingInitialData = true;
    _initialDataError = null;
    notifyListeners();

    try {
      final results = await Future.wait([
        bookingRepository.getPickupZones(),
        bookingRepository.getServiceRegions(),
      ]);

      _pickupPoints = results[0] as List<PickupPoint>;
      _serviceRegions = results[1] as List<ServiceRegion>;

      if (_pickupPoints.isNotEmpty) {
        _selectedPickupPoint = _pickupPoints.first;
      }

      await refreshPassengerLocation();
    } catch (e) {
      _initialDataError = e is ApiException
          ? e.message
          : 'Failed to load transit data: ${e.toString()}';
    } finally {
      _isLoadingInitialData = false;
      notifyListeners();
    }
  }

  /// Selects a pickup hub.
  void selectPickupPoint(PickupPoint point) {
    if (hasPendingSubmission) return;
    _selectedPickupPoint = point;
    _pickupValidation = null;
    if (_passengerLocation != null) {
      validatePickupLocation();
    }
    // Invalidate existing quote if pickup point changed
    _clearQuote();
    notifyListeners();
  }

  /// Refreshes the passenger device location and validates against the 150m geofence.
  Future<void> refreshPassengerLocation() async {
    if (hasPendingSubmission) return;
    _isAcquiringLocation = true;
    _locationErrorMessage = null;
    notifyListeners();

    try {
      final result = await locationService.getCurrentLocation();
      if (result.isSuccess &&
          result.latitude != null &&
          result.longitude != null) {
        _passengerLocation = LatLng(result.latitude!, result.longitude!);
        _locationErrorMessage = null;
        await validatePickupLocation();
      } else {
        _locationErrorMessage =
            result.errorMessage ?? 'Unable to acquire location.';
        // If GPS fails and no location set, fallback to pickup point center for testing
        if (_passengerLocation == null && _selectedPickupPoint != null) {
          _passengerLocation = LatLng(
            _selectedPickupPoint!.latitude,
            _selectedPickupPoint!.longitude,
          );
        }
      }
    } catch (e) {
      _locationErrorMessage = 'Location acquisition error: $e';
    } finally {
      _isAcquiringLocation = false;
      notifyListeners();
    }
  }

  /// Sets passenger pickup location manually (for testing/simulator fallback).
  void setPassengerLocation(LatLng location) {
    if (hasPendingSubmission) return;
    _passengerLocation = location;
    _locationErrorMessage = null;
    validatePickupLocation();
    notifyListeners();
  }

  /// Validates passenger pickup coordinate against the backend 150m geofence.
  Future<void> validatePickupLocation() async {
    if (_selectedPickupPoint == null || _passengerLocation == null) return;

    try {
      _pickupValidation = await bookingRepository.validatePickup(
        pickupPointId: _selectedPickupPoint!.id,
        latitude: _passengerLocation!.latitude,
        longitude: _passengerLocation!.longitude,
      );
    } catch (e) {
      // Non-fatal pre-check; backend validation during booking creation is authoritative
      _pickupValidation = null;
    }
    notifyListeners();
  }

  /// Selects a destination point (e.g. from map tap) and validates against Gandhinagar boundary.
  Future<void> selectDestination(LatLng destination) async {
    if (hasPendingSubmission) return;
    _selectedDestination = destination;
    _isValidatingDestination = true;
    _destinationValidation = null;
    _destinationError = null;
    _clearQuote();
    notifyListeners();

    try {
      final result = await bookingRepository.validateDestination(
        latitude: destination.latitude,
        longitude: destination.longitude,
      );

      _destinationValidation = result;
      if (!result.isInsideServiceRegion) {
        _destinationError =
            'Selected destination is outside the Gandhinagar service region.';
      } else {
        _destinationError = null;
      }
    } catch (e) {
      _destinationError = e is ApiException
          ? e.message
          : 'Destination validation error: ${e.toString()}';
    } finally {
      _isValidatingDestination = false;
      notifyListeners();
    }
  }

  /// Generates a 2-minute binding fare quote.
  Future<void> requestFareQuote() async {
    if (hasPendingSubmission) return;
    if (_selectedPickupPoint == null || _selectedDestination == null) return;

    _isLoadingQuote = true;
    _quoteError = null;
    _clearQuote();
    notifyListeners();

    try {
      final quote = await bookingRepository.generateFareQuote(
        pickupPointId: _selectedPickupPoint!.id,
        destinationLatitude: _selectedDestination!.latitude,
        destinationLongitude: _selectedDestination!.longitude,
      );

      _fareQuote = quote;
      _isQuoteExpired = false;
      _startQuoteCountdown();
      // Generate a fresh idempotency key and clear snapshot for this new quote
      _currentIdempotencyKey = _uuid.v4();
      _pendingRequestSnapshot = null;
    } catch (e) {
      _quoteError = e is ApiException
          ? e.message
          : 'Failed to generate fare quote: ${e.toString()}';
    } finally {
      _isLoadingQuote = false;
      notifyListeners();
    }
  }

  /// Sets the requested ride type ('SHARED' or 'PRIVATE').
  void setRequestedType(String type) {
    if (hasPendingSubmission) return;
    if (_requestedType != type) {
      _requestedType = type;
      notifyListeners();
    }
  }

  /// Sets the minimum group size preference (2..4) for shared rides.
  void setMinGroupPreference(int count) {
    if (hasPendingSubmission) return;
    if (count >= 2 && count <= 4 && _minGroupPreference != count) {
      _minGroupPreference = count;
      notifyListeners();
    }
  }

  /// Sets upfront consent agreement.
  void setUpfrontConsentAgreed(bool agreed) {
    if (hasPendingSubmission) return;
    _upfrontConsentAgreed = agreed;
    notifyListeners();
  }

  /// Submits the booking request idempotently.
  Future<bool> submitBooking() async {
    if (_isSubmittingBooking || _isReconciling) return false;

    final BookingRequest request;
    final String idempotencyKey;

    if (_pendingRequestSnapshot != null) {
      // RETRY PATH: All retries must use the exact same immutable request snapshot and key
      request = _pendingRequestSnapshot!;
      idempotencyKey = _currentIdempotencyKey!;
    } else {
      // FIRST ATTEMPT: Validate preconditions and save immutable request snapshot
      if (!canSubmitBooking) return false;
      if (_passengerLocation == null) {
        _submissionError = 'Passenger pickup coordinate is missing.';
        notifyListeners();
        return false;
      }

      idempotencyKey = _currentIdempotencyKey ?? _uuid.v4();
      _currentIdempotencyKey = idempotencyKey;

      request = BookingRequest(
        quoteId: _fareQuote!.quoteId,
        requestedType: _requestedType,
        minGroupPreference: _minGroupPreference,
        passengerPickupLocation: BookingLocation(
          latitude: _passengerLocation!.latitude,
          longitude: _passengerLocation!.longitude,
        ),
        upfrontConsentAgreed: _upfrontConsentAgreed,
      );
      _pendingRequestSnapshot = request;
    }

    _isSubmittingBooking = true;
    _submissionError = null;
    notifyListeners();

    try {
      final response = await bookingRepository.createBooking(
        request: request,
        idempotencyKey: idempotencyKey,
      );

      // Confirmed success: clear pending snapshot and key
      _createdBooking = response;
      _pendingRequestSnapshot = null;
      _currentIdempotencyKey = null;
      _submissionError = null;
      _quoteCountdownTimer?.cancel();
      _quoteCountdownTimer = null;
      return true;
    } on ApiException catch (e) {
      final isDefinitive = _isDefinitiveRejection(e);

      if (isDefinitive) {
        // Clear snapshot and key only on definitive rejection
        _pendingRequestSnapshot = null;
        _currentIdempotencyKey = null;

        if (e.errorCode == 'QUOTE_EXPIRED') {
          _isQuoteExpired = true;
          _submissionError =
              'This fare quote has expired after 2 minutes. Please generate a fresh quote.';
        } else if (e.errorCode == 'ACTIVE_BOOKING_EXISTS' || e.statusCode == 409) {
          _submissionError =
              'You already have an active booking in progress. Please complete or cancel it before booking again.';
        } else if (e.errorCode == 'PICKUP_OUTSIDE_GEOFENCE') {
          _submissionError = e.message.isNotEmpty
              ? e.message
              : 'Your pickup location is outside the 150m authorized geofence limit.';
        } else if (e.errorCode == 'DESTINATION_OUTSIDE_SERVICE_AREA') {
          _submissionError =
              'Destination coordinates are outside the authorized service area.';
        } else {
          _submissionError = e.message;
        }
      } else {
        // Uncertain error (network timeout, network failure, 5xx server error, IDEMPOTENCY_IN_PROGRESS):
        // PRESERVE _pendingRequestSnapshot and _currentIdempotencyKey for retry!
        if (e.errorCode == 'REQUEST_TIMEOUT' ||
            e.errorCode == 'NETWORK_UNAVAILABLE') {
          _submissionError =
              '${e.message} Your booking submission is pending. Tap retry to resubmit safely or check status.';
        } else if (e.errorCode == 'IDEMPOTENCY_IN_PROGRESS') {
          _submissionError =
              'Your booking request is currently being processed by the server. Please wait a moment and tap retry.';
        } else {
          _submissionError =
              'Temporary server error (${e.statusCode ?? 'network'}). Your booking submission is preserved. Tap retry to resubmit.';
        }
      }
      return false;
    } catch (e) {
      // Non-ApiException unexpected error (e.g. client socket error / timeout)
      // Preserve snapshot and key for retry!
      _submissionError =
          'Booking submission encountered an error: ${e.toString()}. Your submission is preserved. Tap retry to resend.';
      return false;
    } finally {
      _isSubmittingBooking = false;
      notifyListeners();
    }
  }

  /// Reconciles an uncertain pending submission using `GET /api/v1/bookings/active`.
  ///
  /// - If an active booking exists, captures it into [_createdBooking], displays it,
  ///   and clears the pending submission snapshot and idempotency key.
  /// - If no active booking exists on the server, PRESERVES the pending snapshot and key,
  ///   because the original POST could still be processing on the server. Sets an informative
  ///   message explaining that booking status is not yet confirmed and the user can safely retry.
  /// - If reconciliation fails (e.g. network/server failure), preserves the snapshot and
  ///   does NOT silently discard the submission or create a new request.
  Future<bool> reconcilePendingSubmission() async {
    if (!hasPendingSubmission) return false;

    _isReconciling = true;
    _submissionError = null;
    notifyListeners();

    try {
      final activeBooking = await bookingRepository.getActiveBooking();
      if (activeBooking != null) {
        // Confirmed active booking recovered from server!
        _createdBooking = activeBooking;
        _pendingRequestSnapshot = null;
        _currentIdempotencyKey = null;
        _quoteCountdownTimer?.cancel();
        _quoteCountdownTimer = null;
        _submissionError = null;
        return true;
      } else {
        // Server confirmed no active booking yet, but the original request
        // may still be processing on the backend. PRESERVE snapshot and key!
        _submissionError =
            'Booking status is not yet confirmed on the server. You can safely retry the same submission.';
        return false;
      }
    } catch (e) {
      // Reconciliation query failed: do not silently discard snapshot or create new request!
      _submissionError =
          'Unable to verify whether your booking was received: ${e is ApiException ? e.message : e.toString()}. Your pending submission is preserved. Tap retry to resubmit.';
      return false;
    } finally {
      _isReconciling = false;
      notifyListeners();
    }
  }

  /// Resets the booking flow to start fresh.
  ///
  /// If an uncertain submission is pending, it must first be reconciled.
  Future<bool> resetFlow() async {
    if (hasPendingSubmission) {
      final recovered = await reconcilePendingSubmission();
      if (recovered) {
        // Confirmed active booking was recovered and is now shown; do not reset
        return false;
      }
      if (hasPendingSubmission) {
        // Reconciliation failed; do not discard snapshot or create new request
        return false;
      }
    }

    _clearQuote();
    _selectedDestination = null;
    _destinationValidation = null;
    _destinationError = null;
    _createdBooking = null;
    _submissionError = null;
    _upfrontConsentAgreed = false;
    _currentIdempotencyKey = null;
    _pendingRequestSnapshot = null;
    notifyListeners();
    return true;
  }

  void _clearQuote() {
    if (hasPendingSubmission) return;
    _quoteCountdownTimer?.cancel();
    _quoteCountdownTimer = null;
    _fareQuote = null;
    _remainingQuoteDuration = Duration.zero;
    _isQuoteExpired = false;
    _quoteError = null;
    _currentIdempotencyKey = null;
    _pendingRequestSnapshot = null;
  }

  void _startQuoteCountdown() {
    _quoteCountdownTimer?.cancel();
    if (_fareQuote == null) return;

    _updateRemainingDuration();
    _quoteCountdownTimer = Timer.periodic(
      const Duration(seconds: 1),
      (_) => _updateRemainingDuration(),
    );
  }

  void _updateRemainingDuration() {
    if (_fareQuote == null) {
      _quoteCountdownTimer?.cancel();
      return;
    }

    final remaining = _fareQuote!.remainingDuration;
    _remainingQuoteDuration = remaining;

    if (remaining <= Duration.zero) {
      _isQuoteExpired = true;
      _quoteCountdownTimer?.cancel();
      _quoteCountdownTimer = null;
    }

    notifyListeners();
  }

  bool _isDefinitiveRejection(ApiException e) {
    final code = e.errorCode;
    if (code == 'QUOTE_EXPIRED' ||
        code == 'ACTIVE_BOOKING_EXISTS' ||
        code == 'PICKUP_OUTSIDE_GEOFENCE' ||
        code == 'DESTINATION_OUTSIDE_SERVICE_AREA' ||
        code == 'UPFRONT_CONSENT_REQUIRED' ||
        code == 'IDEMPOTENCY_CONFLICT') {
      return true;
    }
    if (e.statusCode == 401 || e.statusCode == 403) {
      return true;
    }
    if (e.statusCode == 400 || e.statusCode == 422) {
      return true;
    }
    if (e.statusCode == 409 &&
        code != 'IDEMPOTENCY_IN_PROGRESS' &&
        code != 'IDEMPOTENCY_CLAIM_LOST') {
      return true;
    }
    return false;
  }

  @override
  void dispose() {
    _quoteCountdownTimer?.cancel();
    super.dispose();
  }
}
