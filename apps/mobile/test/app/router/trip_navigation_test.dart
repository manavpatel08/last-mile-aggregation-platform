import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import 'package:lastmile_mobile/app/router/app_router.dart';
import 'package:lastmile_mobile/app/router/app_routes.dart';
import 'package:lastmile_mobile/app/state/app_mode_provider.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
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
import 'package:lastmile_mobile/features/booking/state/booking_details_provider.dart';
import 'package:lastmile_mobile/features/booking/state/booking_flow_provider.dart';
import 'package:lastmile_mobile/features/driver/data/driver_repository.dart';
import 'package:lastmile_mobile/features/driver/state/driver_home_provider.dart';
import 'package:lastmile_mobile/features/driver/state/driver_onboarding_provider.dart';
import 'package:lastmile_mobile/features/passenger/state/passenger_home_provider.dart';
import 'package:lastmile_mobile/features/trip/data/trip_repository.dart';
import 'package:lastmile_mobile/features/trip/models/cash_confirmation_model.dart';
import 'package:lastmile_mobile/features/trip/models/passenger_boarding_pass.dart';
import 'package:lastmile_mobile/features/trip/models/trip_detail_model.dart';
import 'package:lastmile_mobile/features/trip/presentation/screens/driver_active_trip_screen.dart';
import 'package:lastmile_mobile/features/trip/presentation/screens/passenger_active_trip_screen.dart';

import '../../helpers/test_fakes.dart';

class _FakeTripRepository implements TripRepository {
  @override
  Future<PassengerBoardingPass> getPassengerBoardingPass(
      String bookingId) async {
    return PassengerBoardingPass(
      bookingId: bookingId,
      passengerId: 'p-1',
      tripId: 'trip-1',
      boardingOtp: '4821',
      expiresAt: DateTime.now().add(const Duration(minutes: 30)),
      bookingStatus: 'DRIVER_ASSIGNED',
      driver: const BoardingPassDriver(name: 'Ramesh Patel'),
    );
  }

  @override
  Future<TripDetailModel> getTripDetails(String tripId) async {
    return TripDetailModel(
      tripId: tripId,
      rideGroupId: 'grp-1',
      activeDriverId: 'driver-1',
      status: 'AT_PICKUP',
      driverArrivedAt: DateTime.now(),
      passengers: const [
        TripPassengerModel(
          id: 'tp-1',
          passengerId: 'p-1',
          bookingId: 'book-1',
          status: 'BOARDED',
          finalRideFarePaise: 3800,
          waitingChargePaise: 0,
        ),
      ],
    );
  }

  @override
  Future<ArrivePickupResponse> arriveAtPickup({
    required String tripId,
    required String idempotencyKey,
  }) async {
    return ArrivePickupResponse(
      tripId: tripId,
      status: 'AT_PICKUP',
      driverArrivedAt: DateTime.now(),
    );
  }

  @override
  Future<VerifyBoardingResponse> verifyBoarding({
    required String tripId,
    required String passengerId,
    required String otp,
    required String idempotencyKey,
  }) async {
    return const VerifyBoardingResponse(
      success: true,
      passengerStatus: 'BOARDED',
      waitingChargePaise: 0,
    );
  }

  @override
  Future<StartTripResponse> startTrip({
    required String tripId,
    required String idempotencyKey,
  }) async {
    return StartTripResponse(
      tripId: tripId,
      status: 'IN_PROGRESS',
      startedAt: DateTime.now(),
    );
  }

  @override
  Future<CompletePassengerResponse> completePassengerDropOff({
    required String tripId,
    required String passengerId,
    required String idempotencyKey,
  }) async {
    return CompletePassengerResponse(
      passengerId: passengerId,
      status: 'COMPLETED',
      rideFarePaise: 3800,
      rideFare: '38.00',
      waitingChargePaise: 0,
      waitingCharge: '0.00',
      totalCashToCollectPaise: 3800,
      totalCashToCollect: '38.00',
    );
  }

  @override
  Future<CompleteTripResponse> completeTrip({
    required String tripId,
    required String idempotencyKey,
  }) async {
    return CompleteTripResponse(
      tripId: tripId,
      status: 'COMPLETED',
      completedAt: DateTime.now(),
    );
  }

  @override
  Future<CashConfirmationModel> confirmCash({
    required String tripId,
    required String tripPassengerId,
    required int amountCollectedPaise,
    required String idempotencyKey,
  }) async {
    return CashConfirmationModel(
      collectionId: 'coll-nav',
      tripId: tripId,
      tripPassengerId: tripPassengerId,
      driverId: 'drv-nav',
      totalCashCollectedPaise: amountCollectedPaise,
      totalCashCollected: (amountCollectedPaise / 100).toStringAsFixed(2),
      rideFarePaise: amountCollectedPaise,
      rideFare: (amountCollectedPaise / 100).toStringAsFixed(2),
      waitingChargePaise: 0,
      waitingCharge: '0.00',
      surchargeFeesPaise: 0,
      surchargeFees: '0.00',
      collectedFeeIds: const [],
      paymentStatus: 'PAID',
    );
  }
}

class _FakeBookingRepository implements BookingRepository {
  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async {
    return BookingDetails(
      bookingId: bookingId,
      status: 'DRIVER_ASSIGNED',
      agreedFareCeiling: '45.00',
      maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
    );
  }

  @override
  Future<BookingCancellationResponse> cancelBooking({
    required String bookingId,
    String? reason,
    required String idempotencyKey,
  }) =>
      throw UnimplementedError();

  @override
  Future<OutstandingCancellationFeesResponse>
      getOutstandingCancellationFees() async {
    return const OutstandingCancellationFeesResponse(
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
  Future<BookingResponse?> getActiveBooking() async => null;

  @override
  Future<FareQuote> generateFareQuote({
    required String pickupPointId,
    required double destinationLatitude,
    required double destinationLongitude,
  }) =>
      throw UnimplementedError();

  @override
  Future<List<PickupPoint>> getPickupZones() async => const [];

  @override
  Future<List<ServiceRegion>> getServiceRegions() async => const [];

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

Future<AuthProvider> _createAuthenticatedProvider(AuthUser user) async {
  final tokenStore = AuthTokenStore();
  final secureStorage = SecureTokenStorage.inMemory({
    SecureTokenStorage.refreshTokenKey: 'valid-refresh-token',
  });
  final repo = FakeAuthRepository(currentUser: user);
  final provider = AuthProvider(
    authRepository: repo,
    googleSignInService: FakeGoogleSignInService(),
    tokenStore: tokenStore,
    secureStorage: secureStorage,
  );
  await provider.restoreSession();
  return provider;
}

void main() {
  const config = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const passengerUser = AuthUser(
    id: 'pass-user-1',
    email: 'passenger@pdeu.ac.in',
    fullName: 'Passenger Student',
    role: 'PASSENGER',
    roles: ['PASSENGER'],
  );

  const driverUser = AuthUser(
    id: 'driver-user-1',
    email: 'driver@pdeu.ac.in',
    fullName: 'Driver Partner',
    role: 'DRIVER',
    roles: ['DRIVER'],
    driverVerificationStatus: 'APPROVED',
    driverProfile: DriverProfile(
      id: 'dp-1',
      licenseNumber: 'GJ-01-2023-9999999',
      verificationStatus: 'APPROVED',
      operationalStatus: 'RESERVED',
      isOnline: true,
    ),
  );

  Widget createRouterTestApp({
    required GoRouter router,
    required AuthProvider authProvider,
    required AppModeProvider appModeProvider,
    TripRepository? tripRepository,
    BookingRepository? bookingRepository,
    DriverRepository? driverRepository,
    DriverHomeProvider? driverHomeProvider,
  }) {
    final tripRepo = tripRepository ?? _FakeTripRepository();
    final bookingRepo = bookingRepository ?? _FakeBookingRepository();
    final driverRepo = driverRepository ?? FakeDriverRepository();
    final drvHomeProv = driverHomeProvider ??
        DriverHomeProvider(
            driverRepository: driverRepo, enableCountdownTimer: false);

    return MultiProvider(
      providers: [
        Provider<AppConfig>.value(value: config),
        Provider<TripRepository>.value(value: tripRepo),
        Provider<BookingRepository>.value(value: bookingRepo),
        Provider<DriverRepository>.value(value: driverRepo),
        ChangeNotifierProvider<AuthProvider>.value(value: authProvider),
        ChangeNotifierProvider<AppModeProvider>.value(value: appModeProvider),
        ChangeNotifierProvider<DriverHomeProvider>.value(value: drvHomeProv),
        ChangeNotifierProvider<PassengerHomeProvider>(
          create: (_) => PassengerHomeProvider(),
        ),
        ChangeNotifierProvider<DriverOnboardingProvider>(
          create: (_) => DriverOnboardingProvider(driverRepository: driverRepo),
        ),
        ChangeNotifierProvider<BookingFlowProvider>(
          create: (_) => BookingFlowProvider(
            bookingRepository: bookingRepo,
            locationService: FakePassengerLocationService(),
          ),
        ),
        ChangeNotifierProvider<BookingDetailsProvider>(
          create: (_) => BookingDetailsProvider(bookingRepository: bookingRepo),
        ),
      ],
      child: MaterialApp.router(
        routerConfig: router,
      ),
    );
  }

  group('Trip Navigation & RBAC Guards', () {
    testWidgets(
        'Passenger navigates to /passenger/bookings/:id/trip and renders PassengerActiveTripScreen',
        (tester) async {
      final authProvider = await _createAuthenticatedProvider(passengerUser);
      final appModeProvider = AppModeProvider(initialMode: AppMode.passenger);
      final tripRepo = _FakeTripRepository();

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.passengerActiveTripPath('book-test-123'),
      );

      await tester.pumpWidget(
        createRouterTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
          tripRepository: tripRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(PassengerActiveTripScreen), findsOneWidget);
      expect(find.text('Active Trip'), findsOneWidget);
      expect(find.text('4  8  2  1'), findsOneWidget);
    });

    testWidgets(
        'Driver navigates to /driver/trips/:id and renders DriverActiveTripScreen',
        (tester) async {
      final authProvider = await _createAuthenticatedProvider(driverUser);
      final appModeProvider = AppModeProvider(initialMode: AppMode.driver);
      final tripRepo = _FakeTripRepository();

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.driverActiveTripPath('trip-test-456'),
      );

      await tester.pumpWidget(
        createRouterTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
          tripRepository: tripRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(DriverActiveTripScreen), findsOneWidget);
      expect(find.text('Trip Manifest & Boarding'), findsOneWidget);
      expect(find.text('Trip #trip-tes'), findsOneWidget);
    });

    testWidgets(
        'Driver-only user navigating to /passenger/bookings/:id/trip is redirected to Driver Home',
        (tester) async {
      final authProvider = await _createAuthenticatedProvider(driverUser);
      final appModeProvider = AppModeProvider(initialMode: AppMode.driver);

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.passengerActiveTripPath('book-test-123'),
      );

      await tester.pumpWidget(
        createRouterTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // Guard redirects driver-only user away from passenger trip route to driver home
      expect(find.byType(PassengerActiveTripScreen), findsNothing);
      expect(find.text('Driver Home'), findsOneWidget);
    });

    testWidgets(
        'Passenger-only user navigating to /driver/trips/:id is redirected to Passenger Home',
        (tester) async {
      final authProvider = await _createAuthenticatedProvider(passengerUser);
      final appModeProvider = AppModeProvider(initialMode: AppMode.passenger);

      final router = AppRouter.createRouter(
        appModeProvider: appModeProvider,
        authProvider: authProvider,
        initialLocation: AppRoutes.driverActiveTripPath('trip-test-456'),
      );

      await tester.pumpWidget(
        createRouterTestApp(
          router: router,
          authProvider: authProvider,
          appModeProvider: appModeProvider,
        ),
      );
      await tester.pumpAndSettle();

      // Guard redirects passenger-only user away from driver trip route to passenger home
      expect(find.byType(DriverActiveTripScreen), findsNothing);
      expect(find.text('Passenger Home'), findsOneWidget);
    });
  });
}
