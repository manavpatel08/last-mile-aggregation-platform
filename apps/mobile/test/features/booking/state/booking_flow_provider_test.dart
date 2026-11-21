import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/booking/data/booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_cancellation_response.dart';
import 'package:lastmile_mobile/features/booking/models/booking_details.dart';
import 'package:lastmile_mobile/features/booking/models/booking_request.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/booking/models/cancellation_fee.dart';
import 'package:lastmile_mobile/features/booking/models/fare_quote.dart';
import 'package:lastmile_mobile/features/booking/models/location_validation.dart';
import 'package:lastmile_mobile/features/booking/models/pickup_point.dart';
import 'package:lastmile_mobile/features/booking/models/service_region.dart';
import 'package:lastmile_mobile/features/booking/services/passenger_location_service.dart';
import 'package:lastmile_mobile/features/booking/state/booking_flow_provider.dart';

class _MockBookingRepository implements BookingRepository {
  List<PickupPoint> mockPickupZones = [
    const PickupPoint(
      id: 'hub-1',
      name: 'PDEU Main Gate',
      serviceZoneId: 'zone-1',
      radiusMeters: 150.0,
      latitude: 23.1550,
      longitude: 72.6668,
      isActive: true,
    ),
  ];

  List<ServiceRegion> mockServiceRegions = [
    const ServiceRegion(
      id: 'reg-1',
      name: 'Gandhinagar Service Region',
      isActive: true,
    ),
  ];

  DestinationValidationResult mockDestinationValidation =
      const DestinationValidationResult(isInsideServiceRegion: true);

  PickupValidationResult mockPickupValidation =
      const PickupValidationResult(
    isValid: true,
    distanceMeters: 25.0,
    allowedRadiusMeters: 150.0,
  );

  Future<PickupValidationResult> Function(
    String pickupPointId,
    double latitude,
    double longitude,
  )? onValidatePickup;

  FareQuote? mockFareQuote;
  BookingResponse? mockCreatedBooking;
  BookingResponse? mockActiveBooking;
  Exception? errorToThrow;
  Exception? activeBookingErrorToThrow;

  int createBookingCalls = 0;
  int getActiveBookingCalls = 0;
  String? lastIdempotencyKey;
  BookingRequest? lastBookingRequest;

  @override
  Future<List<PickupPoint>> getPickupZones() async {
    if (errorToThrow != null) throw errorToThrow!;
    return mockPickupZones;
  }

  @override
  Future<List<ServiceRegion>> getServiceRegions() async {
    if (errorToThrow != null) throw errorToThrow!;
    return mockServiceRegions;
  }

  @override
  Future<DestinationValidationResult> validateDestination({
    required double latitude,
    required double longitude,
  }) async {
    if (errorToThrow != null) throw errorToThrow!;
    return mockDestinationValidation;
  }

  @override
  Future<PickupValidationResult> validatePickup({
    required String pickupPointId,
    required double latitude,
    required double longitude,
  }) async {
    if (errorToThrow != null) throw errorToThrow!;
    if (onValidatePickup != null) {
      return onValidatePickup!(pickupPointId, latitude, longitude);
    }
    return mockPickupValidation;
  }

  @override
  Future<FareQuote> generateFareQuote({
    required String pickupPointId,
    required double destinationLatitude,
    required double destinationLongitude,
  }) async {
    if (errorToThrow != null) throw errorToThrow!;
    return mockFareQuote ??
        FareQuote(
          quoteId: 'quote-test-1',
          pickupPointId: pickupPointId,
          pickupPointName: 'PDEU Main Gate',
          directDistanceMeters: 2000,
          directDurationSec: 300,
          privateEstimatedFare: '40.00',
          sharedEstimatedRange: const SharedFareRange(
            minFare: '20.00',
            maxFare: '40.00',
          ),
          agreedFareCeiling: '40.00',
          tariffVersion: 1,
          expiresAt: DateTime.now().add(const Duration(minutes: 2)),
        );
  }

  @override
  Future<BookingResponse> createBooking({
    required BookingRequest request,
    required String idempotencyKey,
  }) async {
    createBookingCalls++;
    lastIdempotencyKey = idempotencyKey;
    lastBookingRequest = request;

    if (errorToThrow != null) throw errorToThrow!;

    return mockCreatedBooking ??
        BookingResponse(
          bookingId: 'book-new-1',
          status: 'REQUESTED',
          agreedFareCeiling: '40.00',
          maxWaitDeadline: DateTime.now().add(const Duration(seconds: 120)),
        );
  }

  @override
  Future<BookingResponse?> getActiveBooking() async {
    getActiveBookingCalls++;
    if (activeBookingErrorToThrow != null) throw activeBookingErrorToThrow!;
    if (errorToThrow != null) throw errorToThrow!;
    return mockActiveBooking;
  }

  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async {
    if (errorToThrow != null) throw errorToThrow!;
    throw UnimplementedError();
  }

  @override
  Future<BookingCancellationResponse> cancelBooking({
    required String bookingId,
    String? reason,
    required String idempotencyKey,
  }) async {
    if (errorToThrow != null) throw errorToThrow!;
    throw UnimplementedError();
  }

  @override
  Future<OutstandingCancellationFeesResponse>
      getOutstandingCancellationFees() async {
    if (errorToThrow != null) throw errorToThrow!;
    return const OutstandingCancellationFeesResponse(
      totalOutstandingPaise: 0,
      fees: [],
    );
  }
}

void main() {
  late _MockBookingRepository repository;
  late FakePassengerLocationService locationService;
  late BookingFlowProvider provider;

  setUp(() {
    repository = _MockBookingRepository();
    locationService = FakePassengerLocationService();
    provider = BookingFlowProvider(
      bookingRepository: repository,
      locationService: locationService,
    );
  });

  tearDown(() {
    provider.dispose();
  });

  group('BookingFlowProvider', () {
    test('denied location permission: no fabricated pickup coordinate and no fare quote or booking enabled',
        () async {
      locationService.initialResult = const LocationResult.failure(
        'Location permission was denied. Please grant location access.',
        isPermissionDenied: true,
      );

      await provider.loadInitialData();

      // Coordinate MUST remain null - no fabricated fallback to pickup hub!
      expect(provider.passengerLocation, isNull);
      expect(provider.pickupValidation, isNull);
      expect(provider.locationErrorMessage, contains('Location permission was denied'));
      expect(provider.canRequestQuote, isFalse);
      expect(provider.canSubmitBooking, isFalse);

      // Attempting to select destination and request quote must fail closed
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      expect(provider.canRequestQuote, isFalse);

      await provider.requestFareQuote();
      expect(provider.fareQuote, isNull);
      expect(provider.quoteError, contains('Actual GPS location is required'));

      // Attempting to submit booking must fail closed
      final booked = await provider.submitBooking();
      expect(booked, isFalse);
      expect(repository.createBookingCalls, 0);
    });

    test('disabled location services: no coordinate and quote/booking disabled',
        () async {
      locationService.initialResult = const LocationResult.failure(
        'Location services are disabled on your device.',
        isLocationServiceDisabled: true,
      );

      await provider.refreshPassengerLocation();

      expect(provider.passengerLocation, isNull);
      expect(provider.pickupValidation, isNull);
      expect(provider.locationErrorMessage, contains('Location services are disabled'));
      expect(provider.canRequestQuote, isFalse);
      expect(provider.canSubmitBooking, isFalse);
    });

    test('failed pickup geofence validation fails closed and prevents fare quote',
        () async {
      locationService.initialResult = const LocationResult.success(
        latitude: 23.2000,
        longitude: 72.7000,
      );
      repository.mockPickupValidation = const PickupValidationResult(
        isValid: false,
        distanceMeters: 450.0,
        allowedRadiusMeters: 150.0,
      );

      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));

      expect(provider.passengerLocation, isNotNull);
      expect(provider.pickupValidation?.isValid, isFalse);
      expect(provider.canRequestQuote, isFalse);
      expect(provider.canSubmitBooking, isFalse);

      await provider.requestFareQuote();
      expect(provider.fareQuote, isNull);
      expect(provider.quoteError, contains('150m authorized pickup geofence'));
    });

    test('valid GPS fix plus successful geofence validation enables the flow',
        () async {
      locationService.initialResult = const LocationResult.success(
        latitude: 23.1551,
        longitude: 72.6669,
      );
      repository.mockPickupValidation = const PickupValidationResult(
        isValid: true,
        distanceMeters: 18.0,
        allowedRadiusMeters: 150.0,
      );

      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));

      expect(provider.passengerLocation, isNotNull);
      expect(provider.pickupValidation?.isValid, isTrue);
      expect(provider.canRequestQuote, isTrue);

      await provider.requestFareQuote();
      expect(provider.fareQuote, isNotNull);

      provider.setUpfrontConsentAgreed(true);
      expect(provider.canSubmitBooking, isTrue);

      final success = await provider.submitBooking();
      expect(success, isTrue);
      expect(repository.lastBookingRequest!.passengerPickupLocation.latitude, 23.1551);
      expect(repository.lastBookingRequest!.passengerPickupLocation.longitude, 72.6669);
    });

    test('pending submission retry reuses identical payload and key without requiring new GPS fix',
        () async {
      locationService.initialResult = const LocationResult.success(
        latitude: 23.1550,
        longitude: 72.6668,
      );
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      // First submission times out
      repository.errorToThrow = const ApiException(
        statusCode: 408,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'Request timed out.',
      );
      await provider.submitBooking();
      expect(provider.hasPendingSubmission, isTrue);

      final originalSnapshot = provider.pendingRequestSnapshot!;
      final originalKey = provider.currentIdempotencyKey!;

      // Simulate device GPS lost or disabled during retry window
      locationService.initialResult = const LocationResult.failure(
        'Location services disabled',
        isLocationServiceDisabled: true,
      );
      await provider.refreshPassengerLocation(); // Should not mutate pending retry

      // Retry booking submission
      repository.errorToThrow = null;
      final retrySuccess = await provider.submitBooking();
      expect(retrySuccess, isTrue);

      // Verify retry reuses identical original snapshot and key
      expect(repository.lastBookingRequest, equals(originalSnapshot));
      expect(repository.lastIdempotencyKey, equals(originalKey));
      expect(repository.lastBookingRequest!.passengerPickupLocation.latitude,
          originalSnapshot.passengerPickupLocation.latitude);
      expect(repository.lastBookingRequest!.passengerPickupLocation.longitude,
          originalSnapshot.passengerPickupLocation.longitude);
    });

    test('existing valid geofence followed by GPS refresh: submission remains disabled until new coordinates are validated',
        () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      // Initially valid and ready to submit
      expect(provider.canSubmitBooking, isTrue);

      final gpsCompleter = Completer<LocationResult>();
      locationService.onGetCurrentLocation = () => gpsCompleter.future;

      // Start GPS refresh
      final refreshFuture = provider.refreshPassengerLocation();

      // Invariant 1: Invalidate previous pickup validation immediately
      expect(provider.pickupValidation, isNull);
      expect(provider.isAcquiringLocation, isTrue);
      // Invariant 2 & 3: Submission remains strictly disabled
      expect(provider.canSubmitBooking, isFalse);

      final submitAttempt = await provider.submitBooking();
      expect(submitAttempt, isFalse);
      expect(provider.submissionError, contains('Please wait'));

      // Now complete GPS with valid coordinates
      gpsCompleter.complete(
        const LocationResult.success(latitude: 23.1550, longitude: 72.6668),
      );
      await refreshFuture;

      // After validation completes, submission is re-enabled
      expect(provider.canSubmitBooking, isTrue);
    });

    test('new GPS coordinate outside the geofence: old successful validation cannot authorize submission',
        () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      expect(provider.canSubmitBooking, isTrue);

      // Now GPS acquires new coordinate far outside geofence
      locationService.initialResult = const LocationResult.success(
        latitude: 23.3500,
        longitude: 72.8500,
      );
      repository.mockPickupValidation = const PickupValidationResult(
        isValid: false,
        distanceMeters: 25000.0,
        allowedRadiusMeters: 150.0,
      );

      await provider.refreshPassengerLocation();

      // Old successful validation must not authorize new coordinates
      expect(provider.pickupValidation?.isValid, isFalse);
      expect(provider.canSubmitBooking, isFalse);

      final booked = await provider.submitBooking();
      expect(booked, isFalse);
      expect(provider.submissionError, contains('A verified pickup location'));
    });

    test('two pickup validation requests completing out of order: only the latest matching request can update state',
        () async {
      await provider.loadInitialData();

      final completer1 = Completer<PickupValidationResult>();
      final completer2 = Completer<PickupValidationResult>();
      int callCount = 0;

      repository.onValidatePickup = (pointId, lat, lng) {
        callCount++;
        if (callCount == 1) {
          return completer1.future;
        } else {
          return completer2.future;
        }
      };

      // Request 1: Location A (inside geofence)
      provider.setPassengerLocation(const LatLng(23.1550, 72.6668));
      expect(provider.isValidatingPickup, isTrue);

      // Request 2: Location B (outside geofence)
      provider.setPassengerLocation(const LatLng(23.3000, 72.8000));
      expect(provider.isValidatingPickup, isTrue);

      // Request 2 completes FIRST with invalid geofence
      completer2.complete(
        const PickupValidationResult(
          isValid: false,
          distanceMeters: 15000.0,
          allowedRadiusMeters: 150.0,
        ),
      );
      await Future<void>.delayed(Duration.zero);

      // State is updated with Request 2
      expect(provider.pickupValidation?.isValid, isFalse);
      expect(provider.pickupValidation?.distanceMeters, 15000.0);
      expect(provider.isValidatingPickup, isFalse);

      // Request 1 completes LATER with valid geofence
      completer1.complete(
        const PickupValidationResult(
          isValid: true,
          distanceMeters: 10.0,
          allowedRadiusMeters: 150.0,
        ),
      );
      await Future<void>.delayed(Duration.zero);

      // Invariant: Stale Request 1 MUST NOT overwrite newer Request 2!
      expect(provider.pickupValidation?.isValid, isFalse);
      expect(provider.pickupValidation?.distanceMeters, 15000.0);
      expect(provider.isValidatingPickup, isFalse);
    });

    test('submit called directly during validation must fail', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      final validationCompleter = Completer<PickupValidationResult>();
      repository.onValidatePickup = (pointId, lat, lng) => validationCompleter.future;

      // Trigger pickup validation
      final validationFuture = provider.validatePickupLocation();
      expect(provider.isValidatingPickup, isTrue);
      expect(provider.canSubmitBooking, isFalse);

      // Attempt submit while validating
      final submitSuccess = await provider.submitBooking();
      expect(submitSuccess, isFalse);
      expect(provider.submissionError,
          contains('Please wait for pickup location and geofence validation to complete.'));
      expect(repository.createBookingCalls, 0);

      // Clean up validation
      validationCompleter.complete(
        const PickupValidationResult(
          isValid: true,
          distanceMeters: 20.0,
          allowedRadiusMeters: 150.0,
        ),
      );
      await validationFuture;
      expect(provider.isValidatingPickup, isFalse);
    });

    test('loadInitialData populates pickup zones and selects default hub',
        () async {
      await provider.loadInitialData();

      expect(provider.isLoadingInitialData, isFalse);
      expect(provider.pickupPoints.length, 1);
      expect(provider.selectedPickupPoint?.name, 'PDEU Main Gate');
      expect(provider.passengerLocation, isNotNull);
      expect(provider.pickupValidation?.isValid, isTrue);
    });

    test('selectDestination validates against service region boundary',
        () async {
      await provider.loadInitialData();

      // Inside service region
      repository.mockDestinationValidation =
          const DestinationValidationResult(isInsideServiceRegion: true);
      await provider.selectDestination(const LatLng(23.1885, 72.6288));

      expect(provider.selectedDestination, isNotNull);
      expect(provider.destinationError, isNull);
      expect(provider.canRequestQuote, isTrue);

      // Outside service region
      repository.mockDestinationValidation =
          const DestinationValidationResult(isInsideServiceRegion: false);
      await provider.selectDestination(const LatLng(23.0000, 72.0000));

      expect(provider.destinationError, isNotNull);
      expect(provider.canRequestQuote, isFalse);
    });

    test('requestFareQuote generates binding quote and generates idempotency key',
        () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));

      await provider.requestFareQuote();

      expect(provider.fareQuote, isNotNull);
      expect(provider.fareQuote!.quoteId, 'quote-test-1');
      expect(provider.isQuoteExpired, isFalse);
      expect(provider.remainingQuoteDuration.inSeconds, greaterThan(0));
      expect(provider.currentIdempotencyKey, isNotNull);
    });

    test('ride type and group preference selection', () {
      expect(provider.requestedType, 'SHARED');
      expect(provider.minGroupPreference, 2);

      provider.setRequestedType('PRIVATE');
      expect(provider.requestedType, 'PRIVATE');

      provider.setRequestedType('SHARED');
      provider.setMinGroupPreference(4);
      expect(provider.minGroupPreference, 4);

      // Constraints: only 2..4 allowed
      provider.setMinGroupPreference(1);
      expect(provider.minGroupPreference, 4);
    });

    test('upfront consent gates booking submission', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();

      expect(provider.upfrontConsentAgreed, isFalse);
      expect(provider.canSubmitBooking, isFalse);

      provider.setUpfrontConsentAgreed(true);
      expect(provider.canSubmitBooking, isTrue);
    });

    test('Retry uses exactly the same payload and key', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setRequestedType('SHARED');
      provider.setMinGroupPreference(3);
      provider.setUpfrontConsentAgreed(true);

      final originalKey = provider.currentIdempotencyKey;
      expect(originalKey, isNotNull);

      // Simulate network timeout failure on first submission
      repository.errorToThrow = const ApiException(
        statusCode: 408,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'The request timed out. Please try again.',
      );

      final firstAttempt = await provider.submitBooking();
      expect(firstAttempt, isFalse);
      expect(provider.hasPendingSubmission, isTrue);
      expect(provider.pendingRequestSnapshot, isNotNull);
      expect(repository.createBookingCalls, 1);

      final snapshot = provider.pendingRequestSnapshot!;
      expect(snapshot.quoteId, 'quote-test-1');
      expect(snapshot.requestedType, 'SHARED');
      expect(snapshot.minGroupPreference, 3);
      expect(snapshot.upfrontConsentAgreed, isTrue);
      expect(repository.lastIdempotencyKey, originalKey);

      // Retry submission after connection restores
      repository.errorToThrow = null;
      final retryAttempt = await provider.submitBooking();
      expect(retryAttempt, isTrue);
      expect(repository.createBookingCalls, 2);

      // Critical invariant: exactly the same key and payload snapshot sent on retry
      expect(repository.lastIdempotencyKey, originalKey);
      expect(repository.lastBookingRequest!.quoteId, snapshot.quoteId);
      expect(repository.lastBookingRequest!.requestedType, snapshot.requestedType);
      expect(repository.lastBookingRequest!.minGroupPreference, snapshot.minGroupPreference);
      expect(repository.lastBookingRequest!.upfrontConsentAgreed, snapshot.upfrontConsentAgreed);
      expect(provider.hasPendingSubmission, isFalse);
      expect(provider.createdBooking, isNotNull);
    });

    test('Form changes cannot mutate a pending retry', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setRequestedType('SHARED');
      provider.setMinGroupPreference(2);
      provider.setUpfrontConsentAgreed(true);

      // First submission fails with network failure
      repository.errorToThrow = const ApiException(
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Unable to reach the server. Check your network connection.',
      );

      final firstAttempt = await provider.submitBooking();
      expect(firstAttempt, isFalse);
      expect(provider.hasPendingSubmission, isTrue);

      // Attempt to mutate form fields during pending retry state
      provider.setRequestedType('PRIVATE');
      provider.setMinGroupPreference(4);
      provider.setUpfrontConsentAgreed(false);
      provider.selectDestination(const LatLng(23.2156, 72.6369));
      provider.selectPickupPoint(
        const PickupPoint(
          id: 'hub-other',
          name: 'Other Hub',
          serviceZoneId: 'z2',
          radiusMeters: 150,
          latitude: 23.15,
          longitude: 72.66,
          isActive: true,
        ),
      );
      provider.requestFareQuote(); // Should do nothing

      // Verify pending snapshot remains untouched
      final snapshot = provider.pendingRequestSnapshot!;
      expect(snapshot.requestedType, 'SHARED');
      expect(snapshot.minGroupPreference, 2);
      expect(snapshot.upfrontConsentAgreed, isTrue);
      expect(provider.requestedType, 'SHARED');
      expect(provider.minGroupPreference, 2);
      expect(provider.upfrontConsentAgreed, isTrue);

      // Now retry submission
      repository.errorToThrow = null;
      final retrySuccess = await provider.submitBooking();
      expect(retrySuccess, isTrue);

      // The sent payload must be the original snapshot, completely unaffected by attempted mutations
      expect(repository.lastBookingRequest!.requestedType, 'SHARED');
      expect(repository.lastBookingRequest!.minGroupPreference, 2);
      expect(repository.lastBookingRequest!.upfrontConsentAgreed, isTrue);
    });

    test('A recovered active booking clears the pending state', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      // First attempt times out
      repository.errorToThrow = const ApiException(
        statusCode: 504,
        errorCode: 'GATEWAY_TIMEOUT',
        message: 'Gateway timed out.',
      );

      final firstAttempt = await provider.submitBooking();
      expect(firstAttempt, isFalse);
      expect(provider.hasPendingSubmission, isTrue);
      expect(provider.pendingRequestSnapshot, isNotNull);
      expect(provider.currentIdempotencyKey, isNotNull);

      // Backend actually committed the booking during the timeout window!
      repository.errorToThrow = null;
      repository.mockActiveBooking = BookingResponse(
        bookingId: 'recovered-booking-uuid',
        status: 'MATCHING',
        agreedFareCeiling: '40.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 2)),
      );

      // Reconcile pending submission
      final recovered = await provider.reconcilePendingSubmission();
      expect(recovered, isTrue);
      expect(provider.hasPendingSubmission, isFalse);
      expect(provider.pendingRequestSnapshot, isNull);
      expect(provider.currentIdempotencyKey, isNull);
      expect(provider.createdBooking, isNotNull);
      expect(provider.createdBooking!.bookingId, 'recovered-booking-uuid');
      expect(provider.createdBooking!.status, 'MATCHING');
    });

    test('Null active-booking response preserves the snapshot and key', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      // First attempt times out
      repository.errorToThrow = const ApiException(
        statusCode: 408,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'Request timed out.',
      );

      final firstAttempt = await provider.submitBooking();
      expect(firstAttempt, isFalse);
      expect(provider.hasPendingSubmission, isTrue);

      final preservedSnapshot = provider.pendingRequestSnapshot;
      final preservedKey = provider.currentIdempotencyKey;
      expect(preservedSnapshot, isNotNull);
      expect(preservedKey, isNotNull);

      // Server returns null for active booking (request could still be in progress on backend)
      repository.errorToThrow = null;
      repository.mockActiveBooking = null;

      final recovered = await provider.reconcilePendingSubmission();
      expect(recovered, isFalse);

      // Snapshot and idempotency key MUST be preserved!
      expect(provider.hasPendingSubmission, isTrue);
      expect(provider.pendingRequestSnapshot, equals(preservedSnapshot));
      expect(provider.currentIdempotencyKey, equals(preservedKey));
      expect(
        provider.submissionError,
        'Booking status is not yet confirmed on the server. You can safely retry the same submission.',
      );
    });

    test('A subsequent retry sends exactly the original payload and key', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      // Initial attempt encounters temporary 503 error
      repository.errorToThrow = const ApiException(
        statusCode: 503,
        errorCode: 'SERVICE_UNAVAILABLE',
        message: 'Service unavailable.',
      );

      await provider.submitBooking();
      expect(provider.hasPendingSubmission, isTrue);

      final originalSnapshot = provider.pendingRequestSnapshot!;
      final originalKey = provider.currentIdempotencyKey!;

      // Server returns null for active booking during check
      repository.mockActiveBooking = null;
      final recovered = await provider.reconcilePendingSubmission();
      expect(recovered, isFalse);
      expect(provider.hasPendingSubmission, isTrue);

      // Attempted form modifications while pending retry are ignored
      provider.setRequestedType('PRIVATE');
      provider.setMinGroupPreference(4);

      // User taps retry: must reuse the exact same snapshot and key
      repository.errorToThrow = null;
      final retrySuccess = await provider.submitBooking();
      expect(retrySuccess, isTrue);

      expect(repository.lastBookingRequest, equals(originalSnapshot));
      expect(repository.lastBookingRequest!.requestedType, originalSnapshot.requestedType);
      expect(repository.lastBookingRequest!.minGroupPreference, originalSnapshot.minGroupPreference);
      expect(repository.lastIdempotencyKey, equals(originalKey));

      // After confirmed booking success, pending state is cleared
      expect(provider.hasPendingSubmission, isFalse);
      expect(provider.pendingRequestSnapshot, isNull);
      expect(provider.currentIdempotencyKey, isNull);
      expect(provider.createdBooking, isNotNull);
    });

    test('Reconciliation failure also preserves the pending submission',
        () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      // First attempt fails with uncertain 500 error
      repository.errorToThrow = const ApiException(
        statusCode: 500,
        errorCode: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      );

      await provider.submitBooking();
      expect(provider.hasPendingSubmission, isTrue);

      final savedSnapshot = provider.pendingRequestSnapshot;
      final savedKey = provider.currentIdempotencyKey;
      expect(savedSnapshot, isNotNull);
      expect(savedKey, isNotNull);

      // Reconciliation also fails due to network outage
      repository.activeBookingErrorToThrow = const ApiException(
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Network offline.',
      );
      repository.errorToThrow = null;

      final recovered = await provider.reconcilePendingSubmission();
      expect(recovered, isFalse);
      // Critical invariant: snapshot and key are preserved; NOT silently cleared!
      expect(provider.hasPendingSubmission, isTrue);
      expect(provider.pendingRequestSnapshot, equals(savedSnapshot));
      expect(provider.currentIdempotencyKey, equals(savedKey));
      expect(provider.submissionError, contains('Unable to verify'));
    });

    test('A new quote creates a new logical submission and key', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));

      // 1. Generate Quote 1
      repository.mockFareQuote = FareQuote(
        quoteId: 'quote-version-1',
        pickupPointId: 'hub-1',
        pickupPointName: 'PDEU Main Gate',
        directDistanceMeters: 2000,
        directDurationSec: 300,
        privateEstimatedFare: '40.00',
        sharedEstimatedRange: const SharedFareRange(minFare: '20.00', maxFare: '40.00'),
        agreedFareCeiling: '40.00',
        tariffVersion: 1,
        expiresAt: DateTime.now().add(const Duration(minutes: 2)),
      );
      await provider.requestFareQuote();
      final key1 = provider.currentIdempotencyKey;
      expect(key1, isNotNull);
      expect(provider.fareQuote!.quoteId, 'quote-version-1');

      // Reset flow (clean state)
      await provider.resetFlow();
      expect(provider.currentIdempotencyKey, isNull);
      expect(provider.pendingRequestSnapshot, isNull);

      // 2. Generate Quote 2
      await provider.selectDestination(const LatLng(23.2156, 72.6369));
      repository.mockFareQuote = FareQuote(
        quoteId: 'quote-version-2',
        pickupPointId: 'hub-1',
        pickupPointName: 'PDEU Main Gate',
        directDistanceMeters: 4000,
        directDurationSec: 600,
        privateEstimatedFare: '60.00',
        sharedEstimatedRange: const SharedFareRange(minFare: '25.00', maxFare: '60.00'),
        agreedFareCeiling: '60.00',
        tariffVersion: 1,
        expiresAt: DateTime.now().add(const Duration(minutes: 2)),
      );
      await provider.requestFareQuote();
      final key2 = provider.currentIdempotencyKey;
      expect(key2, isNotNull);
      expect(provider.fareQuote!.quoteId, 'quote-version-2');

      // Critical invariant: new logical submission gets a distinct idempotency key
      expect(key1, isNot(equals(key2)));

      provider.setUpfrontConsentAgreed(true);
      await provider.submitBooking();
      expect(repository.lastIdempotencyKey, key2);
      expect(repository.lastBookingRequest!.quoteId, 'quote-version-2');
    });

    test('surfaces QUOTE_EXPIRED error and clears snapshot on definitive rejection',
        () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      repository.errorToThrow = const ApiException(
        statusCode: 400,
        errorCode: 'QUOTE_EXPIRED',
        message: 'Fare quote has expired after 2 minutes.',
      );

      final success = await provider.submitBooking();
      expect(success, isFalse);
      expect(provider.isQuoteExpired, isTrue);
      // Definitive rejection clears snapshot to allow fresh quote
      expect(provider.hasPendingSubmission, isFalse);
      expect(provider.pendingRequestSnapshot, isNull);
      expect(provider.submissionError, contains('expired'));
    });

    test('surfaces ACTIVE_BOOKING_EXISTS (409) when active booking exists',
        () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      repository.errorToThrow = const ApiException(
        statusCode: 409,
        errorCode: 'ACTIVE_BOOKING_EXISTS',
        message: 'Passenger already has an active booking in progress.',
      );

      final success = await provider.submitBooking();
      expect(success, isFalse);
      expect(provider.hasPendingSubmission, isFalse);
      expect(provider.submissionError, contains('already have an active booking'));
    });

    test('surfaces PICKUP_OUTSIDE_GEOFENCE when pickup is beyond 150m',
        () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      repository.errorToThrow = const ApiException(
        statusCode: 400,
        errorCode: 'PICKUP_OUTSIDE_GEOFENCE',
        message: 'Pickup location is 250m from PDEU Main Gate, exceeding 150m.',
      );

      final success = await provider.submitBooking();
      expect(success, isFalse);
      expect(provider.hasPendingSubmission, isFalse);
      expect(provider.submissionError, contains('exceeding 150m'));
    });

    test('resetFlow clears quote, destination, and idempotency key', () async {
      await provider.loadInitialData();
      await provider.selectDestination(const LatLng(23.1885, 72.6288));
      await provider.requestFareQuote();
      provider.setUpfrontConsentAgreed(true);

      await provider.resetFlow();

      expect(provider.fareQuote, isNull);
      expect(provider.selectedDestination, isNull);
      expect(provider.upfrontConsentAgreed, isFalse);
      expect(provider.currentIdempotencyKey, isNull);
      expect(provider.pendingRequestSnapshot, isNull);
    });
  });
}
