import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/theme/app_theme.dart';
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
import 'package:lastmile_mobile/features/booking/presentation/screens/booking_flow_screen.dart';
import 'package:lastmile_mobile/features/booking/services/passenger_location_service.dart';
import 'package:lastmile_mobile/features/booking/state/booking_flow_provider.dart';
import 'package:lastmile_mobile/features/passenger/state/passenger_home_provider.dart';
import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

class _FakeBookingRepository implements BookingRepository {
  List<PickupPoint> pickupZones = [
    const PickupPoint(
      id: 'hub-pdeu',
      name: 'PDEU Main Gate',
      serviceZoneId: 'zone-1',
      radiusMeters: 150.0,
      latitude: 23.1550,
      longitude: 72.6668,
      isActive: true,
    ),
  ];

  List<ServiceRegion> serviceRegions = [
    const ServiceRegion(
      id: 'reg-gn',
      name: 'Gandhinagar Service Region',
      isActive: true,
      boundaryGeoJson: {
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
    ),
  ];

  DestinationValidationResult destinationValidation =
      const DestinationValidationResult(isInsideServiceRegion: true);

  PickupValidationResult pickupValidation = const PickupValidationResult(
    isValid: true,
    distanceMeters: 20.0,
    allowedRadiusMeters: 150.0,
  );

  FareQuote? fareQuote;
  BookingResponse? createdBooking;
  BookingResponse? activeBookingToReturn;
  Exception? errorToThrow;

  @override
  Future<List<PickupPoint>> getPickupZones() async => pickupZones;

  @override
  Future<List<ServiceRegion>> getServiceRegions() async => serviceRegions;

  @override
  Future<DestinationValidationResult> validateDestination({
    required double latitude,
    required double longitude,
  }) async =>
      destinationValidation;

  @override
  Future<PickupValidationResult> validatePickup({
    required String pickupPointId,
    required double latitude,
    required double longitude,
  }) async =>
      pickupValidation;

  @override
  Future<FareQuote> generateFareQuote({
    required String pickupPointId,
    required double destinationLatitude,
    required double destinationLongitude,
  }) async {
    return fareQuote ??
        FareQuote(
          quoteId: 'quote-test-99',
          pickupPointId: pickupPointId,
          pickupPointName: 'PDEU Main Gate',
          directDistanceMeters: 1800,
          directDurationSec: 240,
          privateEstimatedFare: '42.00',
          sharedEstimatedRange: const SharedFareRange(
            minFare: '20.00',
            maxFare: '42.00',
          ),
          agreedFareCeiling: '42.00',
          tariffVersion: 1,
          expiresAt: DateTime.now().add(const Duration(minutes: 2)),
        );
  }

  @override
  Future<BookingResponse> createBooking({
    required BookingRequest request,
    required String idempotencyKey,
  }) async {
    if (errorToThrow != null) throw errorToThrow!;
    return createdBooking ??
        BookingResponse(
          bookingId: 'book-succ-12345',
          status: 'REQUESTED',
          agreedFareCeiling: '42.00',
          maxWaitDeadline: DateTime.now().add(const Duration(seconds: 120)),
        );
  }

  @override
  Future<BookingResponse?> getActiveBooking() async => activeBookingToReturn;

  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async =>
      throw UnimplementedError();

  @override
  Future<BookingCancellationResponse> cancelBooking({
    required String bookingId,
    String? reason,
    required String idempotencyKey,
  }) async =>
      throw UnimplementedError();

  @override
  Future<OutstandingCancellationFeesResponse>
      getOutstandingCancellationFees() async =>
          const OutstandingCancellationFeesResponse(
            totalOutstandingPaise: 0,
            fees: [],
          );
}

Widget _buildTestableWidget({
  required BookingFlowProvider provider,
  PassengerHomeProvider? passengerHomeProvider,
}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<BookingFlowProvider>.value(value: provider),
      ChangeNotifierProvider<PassengerHomeProvider>.value(
        value: passengerHomeProvider ?? PassengerHomeProvider(),
      ),
    ],
    child: MaterialApp(
      theme: AppTheme.lightTheme,
      home: const BookingFlowScreen(),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('BookingFlowScreen Widget Tests', () {
    testWidgets('renders pickup hub and destination map picker after loading',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repo = _FakeBookingRepository();
      final loc = FakePassengerLocationService();
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      expect(find.text('Book a Ride'), findsOneWidget);
      expect(find.byKey(const Key('pickup_point_dropdown')), findsOneWidget);
      expect(find.text('Select Destination'), findsOneWidget);
      expect(find.text('Infocity (23.188, 72.628)'), findsOneWidget);
    });

    testWidgets(
        'selecting destination and getting quote renders FareQuoteCard and consent checkbox',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repo = _FakeBookingRepository();
      final loc = FakePassengerLocationService();
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      // Tap preset chip to select destination
      final chipFinder = find.text('Infocity (23.188, 72.628)');
      await tester.ensureVisible(chipFinder);
      await tester.tap(chipFinder);
      await tester.pumpAndSettle();

      final getQuoteButton = find.byKey(const Key('get_fare_quote_button'));
      expect(getQuoteButton, findsOneWidget);
      await tester.ensureVisible(getQuoteButton);

      // Tap Get Fare Quote button
      await tester.tap(getQuoteButton);
      await tester.pumpAndSettle();

      // Verify FareQuoteCard is visible with details
      expect(find.byKey(const Key('fare_quote_card')), findsOneWidget);
      expect(find.text('₹20.00 – ₹42.00'), findsOneWidget); // shared range
      expect(find.text('₹42.00'), findsNWidgets(2)); // private & ceiling
      expect(find.byKey(const Key('quote_countdown_text')), findsOneWidget);

      // Ride type selection
      expect(find.byKey(const Key('ride_type_segmented_button')), findsOneWidget);
      expect(find.text('Shared Ride'), findsOneWidget);
      expect(find.text('Private Ride'), findsOneWidget);

      // Upfront consent checkbox is present and unchecked
      final checkboxFinder = find.byKey(const Key('upfront_consent_checkbox'));
      expect(checkboxFinder, findsOneWidget);
      await tester.ensureVisible(checkboxFinder);

      // Confirm Booking button should be disabled until consent is checked
      final confirmButtonFinder = find.byKey(const Key('confirm_booking_button'));
      expect(confirmButtonFinder, findsOneWidget);
      expect(tester.widget<FilledButton>(confirmButtonFinder).onPressed, isNull);

      // Check upfront consent
      await tester.tap(checkboxFinder);
      await tester.pumpAndSettle();

      // Confirm Booking button should now be enabled
      expect(
        tester.widget<FilledButton>(confirmButtonFinder).onPressed,
        isNotNull,
      );
    });

    testWidgets('submitting booking navigates to success summary with details',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repo = _FakeBookingRepository();
      final loc = FakePassengerLocationService();
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      // Select destination and get quote
      final chipFinder = find.text('Infocity (23.188, 72.628)');
      await tester.ensureVisible(chipFinder);
      await tester.tap(chipFinder);
      await tester.pumpAndSettle();

      final getQuoteButton = find.byKey(const Key('get_fare_quote_button'));
      await tester.ensureVisible(getQuoteButton);
      await tester.tap(getQuoteButton);
      await tester.pumpAndSettle();

      // Agree to upfront consent
      final consentCheckbox = find.byKey(const Key('upfront_consent_checkbox'));
      await tester.ensureVisible(consentCheckbox);
      await tester.tap(consentCheckbox);
      await tester.pumpAndSettle();

      // Tap confirm booking
      final confirmButton = find.byKey(const Key('confirm_booking_button'));
      await tester.ensureVisible(confirmButton);
      await tester.tap(confirmButton);
      await tester.pumpAndSettle();

      // Verify success screen details
      expect(find.text('Booking Requested!'), findsOneWidget);
      expect(find.byKey(const Key('created_booking_id')), findsOneWidget);
      expect(find.text('book-succ-12345'), findsOneWidget);
      expect(find.text('REQUESTED'), findsOneWidget);
      expect(find.text('₹42.00'), findsOneWidget);
      expect(
        find.byKey(const Key('return_to_passenger_home_button')),
        findsOneWidget,
      );
    });

    testWidgets('displays error banner when booking fails with active booking conflict',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repo = _FakeBookingRepository();
      repo.errorToThrow = const ApiException(
        statusCode: 409,
        errorCode: 'ACTIVE_BOOKING_EXISTS',
        message: 'Passenger already has an active booking in progress.',
      );

      final loc = FakePassengerLocationService();
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      // Select destination and get quote
      final chipFinder = find.text('Infocity (23.188, 72.628)');
      await tester.ensureVisible(chipFinder);
      await tester.tap(chipFinder);
      await tester.pumpAndSettle();

      final getQuoteButton = find.byKey(const Key('get_fare_quote_button'));
      await tester.ensureVisible(getQuoteButton);
      await tester.tap(getQuoteButton);
      await tester.pumpAndSettle();

      // Agree to upfront consent
      final consentCheckbox = find.byKey(const Key('upfront_consent_checkbox'));
      await tester.ensureVisible(consentCheckbox);
      await tester.tap(consentCheckbox);
      await tester.pumpAndSettle();

      // Tap confirm booking
      final confirmButton = find.byKey(const Key('confirm_booking_button'));
      await tester.ensureVisible(confirmButton);
      await tester.tap(confirmButton);
      await tester.pumpAndSettle();

      // Error banner must be visible
      expect(
        find.byKey(const Key('booking_submission_error_banner')),
        findsOneWidget,
      );
      expect(
        find.textContaining('already have an active booking'),
        findsOneWidget,
      );
    });

    testWidgets(
        'displays pending retry banner on network timeout and recovers confirmed booking via reconcile button',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repo = _FakeBookingRepository();
      repo.errorToThrow = const ApiException(
        statusCode: 408,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'The request timed out. Please try again.',
      );

      final loc = FakePassengerLocationService();
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      // Select destination and get quote
      final chipFinder = find.text('Infocity (23.188, 72.628)');
      await tester.ensureVisible(chipFinder);
      await tester.tap(chipFinder);
      await tester.pumpAndSettle();

      final getQuoteButton = find.byKey(const Key('get_fare_quote_button'));
      await tester.ensureVisible(getQuoteButton);
      await tester.tap(getQuoteButton);
      await tester.pumpAndSettle();

      // Agree to upfront consent
      final consentCheckbox = find.byKey(const Key('upfront_consent_checkbox'));
      await tester.ensureVisible(consentCheckbox);
      await tester.tap(consentCheckbox);
      await tester.pumpAndSettle();

      // Tap confirm booking -> triggers timeout
      final confirmButton = find.byKey(const Key('confirm_booking_button'));
      await tester.ensureVisible(confirmButton);
      await tester.tap(confirmButton);
      await tester.pumpAndSettle();

      // Pending retry banner and reconcile button should be visible
      expect(find.byKey(const Key('pending_retry_banner')), findsOneWidget);
      expect(find.text('Retry Booking Submission'), findsOneWidget);
      expect(find.byKey(const Key('reconcile_status_button')), findsOneWidget);

      // Now server has active booking available upon reconciliation
      repo.errorToThrow = null;
      repo.activeBookingToReturn = BookingResponse(
        bookingId: 'reconciled-book-888',
        status: 'MATCHING',
        agreedFareCeiling: '42.00',
        maxWaitDeadline: DateTime.now().add(const Duration(seconds: 120)),
      );

      // Tap reconcile button to recover confirmed booking
      await tester.tap(find.byKey(const Key('reconcile_status_button')));
      await tester.pumpAndSettle();

      // Confirmed active booking recovered and success screen displayed
      expect(find.text('Booking Requested!'), findsOneWidget);
      expect(find.text('reconciled-book-888'), findsOneWidget);
      expect(find.text('MATCHING'), findsOneWidget);
    });

    testWidgets(
        'null active booking during reconciliation preserves pending retry banner and shows unconfirmed message',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repo = _FakeBookingRepository();
      repo.errorToThrow = const ApiException(
        statusCode: 408,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'The request timed out. Please try again.',
      );

      final loc = FakePassengerLocationService();
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      final chipFinder = find.text('Infocity (23.188, 72.628)');
      await tester.ensureVisible(chipFinder);
      await tester.tap(chipFinder);
      await tester.pumpAndSettle();

      final getQuoteButton = find.byKey(const Key('get_fare_quote_button'));
      await tester.ensureVisible(getQuoteButton);
      await tester.tap(getQuoteButton);
      await tester.pumpAndSettle();

      final consentCheckbox = find.byKey(const Key('upfront_consent_checkbox'));
      await tester.ensureVisible(consentCheckbox);
      await tester.tap(consentCheckbox);
      await tester.pumpAndSettle();

      final confirmButton = find.byKey(const Key('confirm_booking_button'));
      await tester.ensureVisible(confirmButton);
      await tester.tap(confirmButton);
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('pending_retry_banner')), findsOneWidget);
      expect(find.text('Retry Booking Submission'), findsOneWidget);

      // Reconciliation returns null active booking
      repo.errorToThrow = null;
      repo.activeBookingToReturn = null;

      await tester.tap(find.byKey(const Key('reconcile_status_button')));
      await tester.pumpAndSettle();

      // Invariant: pending banner is preserved, retry button is preserved, message is shown
      expect(find.byKey(const Key('pending_retry_banner')), findsOneWidget);
      expect(find.text('Retry Booking Submission'), findsOneWidget);
      expect(
        find.text(
          'Booking status is not yet confirmed on the server. You can safely retry the same submission.',
        ),
        findsOneWidget,
      );
    });

    testWidgets(
        'renders clearly visible OSM attribution in map widget and tapping launches copyright URL',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final originalLauncher = UrlLauncherPlatform.instance;
      final fakeLauncher = _FakeScreenUrlLauncher();
      UrlLauncherPlatform.instance = fakeLauncher;
      addTearDown(() => UrlLauncherPlatform.instance = originalLauncher);

      final repo = _FakeBookingRepository();
      final loc = FakePassengerLocationService();
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      final attributionFinder = find.byKey(const Key('osm_attribution'));
      expect(attributionFinder, findsOneWidget);
      expect(find.text('© OpenStreetMap contributors'), findsOneWidget);

      await tester.tap(attributionFinder);
      await tester.pumpAndSettle();

      expect(fakeLauncher.launchCallCount, 1);
      expect(fakeLauncher.lastUrl, 'https://www.openstreetmap.org/copyright');
      expect(fakeLauncher.lastOptions?.mode, PreferredLaunchMode.externalApplication);
    });

    testWidgets(
        'denied location permission displays error banner and prevents quote generation',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repo = _FakeBookingRepository();
      final loc = FakePassengerLocationService(
        initialResult: const LocationResult.failure(
          'Location permission denied. Please grant location access.',
          isPermissionDenied: true,
        ),
      );
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      // Verify location error banner is rendered and no coordinate is fabricated
      expect(find.byKey(const Key('location_error_banner')), findsOneWidget);
      expect(find.text('Location permission denied. Please grant location access.'),
          findsOneWidget);
      expect(provider.passengerLocation, isNull);

      // Select destination
      final chipFinder = find.text('Infocity (23.188, 72.628)');
      await tester.ensureVisible(chipFinder);
      await tester.tap(chipFinder);
      await tester.pumpAndSettle();

      // Fare quote button MUST NOT be displayed
      expect(find.byKey(const Key('get_fare_quote_button')), findsNothing);
      expect(find.byKey(const Key('pickup_location_guidance_banner')),
          findsOneWidget);
    });

    testWidgets(
        'failed pickup geofence validation displays exceeding distance and prevents quote button',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repo = _FakeBookingRepository();
      repo.pickupValidation = const PickupValidationResult(
        isValid: false,
        distanceMeters: 310.0,
        allowedRadiusMeters: 150.0,
      );
      final loc = FakePassengerLocationService();
      final provider = BookingFlowProvider(
        bookingRepository: repo,
        locationService: loc,
      );
      addTearDown(provider.dispose);

      await tester.pumpWidget(_buildTestableWidget(provider: provider));
      await tester.pumpAndSettle();

      expect(find.text('Distance: 310m (exceeds 150m)'), findsOneWidget);

      final chipFinder = find.text('Infocity (23.188, 72.628)');
      await tester.ensureVisible(chipFinder);
      await tester.tap(chipFinder);
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('get_fare_quote_button')), findsNothing);
      expect(find.byKey(const Key('pickup_location_guidance_banner')),
          findsOneWidget);
    });
  });
}

class _FakeScreenUrlLauncher extends UrlLauncherPlatform {
  String? lastUrl;
  LaunchOptions? lastOptions;
  int launchCallCount = 0;

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    launchCallCount++;
    lastUrl = url;
    lastOptions = options;
    return true;
  }
}
