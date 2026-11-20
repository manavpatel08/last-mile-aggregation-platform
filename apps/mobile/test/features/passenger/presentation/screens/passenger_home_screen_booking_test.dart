import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import 'package:lastmile_mobile/app/router/app_routes.dart';
import 'package:lastmile_mobile/app/state/app_mode_provider.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/core/theme/app_theme.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/booking/data/booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_request.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/booking/models/fare_quote.dart';
import 'package:lastmile_mobile/features/booking/models/location_validation.dart';
import 'package:lastmile_mobile/features/booking/models/pickup_point.dart';
import 'package:lastmile_mobile/features/booking/models/service_region.dart';
import 'package:lastmile_mobile/features/passenger/presentation/screens/passenger_home_screen.dart';
import 'package:lastmile_mobile/features/passenger/state/passenger_home_provider.dart';

import '../../../../helpers/test_fakes.dart';

class _FakeBookingRepository implements BookingRepository {
  BookingResponse? activeBookingToReturn;

  @override
  Future<BookingResponse?> getActiveBooking() async => activeBookingToReturn;

  @override
  Future<BookingResponse> createBooking({
    required BookingRequest request,
    required String idempotencyKey,
  }) =>
      throw UnimplementedError();

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const testPassenger = AuthUser(
    id: 'u-1',
    email: 'passenger@pdeu.ac.in',
    fullName: 'Passenger Test',
    role: 'PASSENGER',
    roles: ['PASSENGER'],
    passengerProfile: PassengerProfile(
      id: 'pass-profile-1',
      defaultMinGroupPreference: 2,
      totalRidesCompleted: 2,
    ),
  );

  group('PassengerHomeScreen Booking Integration', () {
    testWidgets('renders Book a Ride CTA entry point and navigates on tap',
        (tester) async {
      final bookingRepo = _FakeBookingRepository();
      final authRepo = FakeAuthRepository(currentUser: testPassenger);
      final tokenStore = AuthTokenStore();
      final storage = SecureTokenStorage.inMemory();
      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: storage,
      );

      final router = GoRouter(
        initialLocation: AppRoutes.passengerHome,
        routes: [
          GoRoute(
            path: AppRoutes.passengerHome,
            builder: (context, state) => const PassengerHomeScreen(),
          ),
          GoRoute(
            path: AppRoutes.passengerBooking,
            builder: (context, state) => const Scaffold(
              body: Text('Booking Screen Destination'),
            ),
          ),
        ],
      );

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            Provider<BookingRepository>.value(value: bookingRepo),
            ChangeNotifierProvider<AuthProvider>.value(value: authProvider),
            ChangeNotifierProvider<AppModeProvider>(
              create: (_) => AppModeProvider(initialMode: AppMode.passenger),
            ),
            ChangeNotifierProvider<PassengerHomeProvider>(
              create: (_) => PassengerHomeProvider(),
            ),
          ],
          child: MaterialApp.router(
            theme: AppTheme.lightTheme,
            routerConfig: router,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Check Book a Ride card
      expect(find.byKey(const Key('book_ride_card')), findsOneWidget);
      expect(find.text('Book a Ride'), findsOneWidget);
      expect(find.byKey(const Key('book_ride_button')), findsOneWidget);

      // Tap Book a Ride
      await tester.tap(find.byKey(const Key('book_ride_button')));
      await tester.pumpAndSettle();

      expect(find.text('Booking Screen Destination'), findsOneWidget);
    });

    testWidgets('displays ActiveBookingCard when passenger has active booking',
        (tester) async {
      final bookingRepo = _FakeBookingRepository();
      bookingRepo.activeBookingToReturn = BookingResponse(
        bookingId: 'book-active-12345',
        status: 'MATCHING',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime.now().add(const Duration(minutes: 2)),
      );

      final authRepo = FakeAuthRepository(currentUser: testPassenger);
      final tokenStore = AuthTokenStore();
      final storage = SecureTokenStorage.inMemory();
      final authProvider = AuthProvider(
        authRepository: authRepo,
        googleSignInService: FakeGoogleSignInService(),
        tokenStore: tokenStore,
        secureStorage: storage,
      );

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            Provider<BookingRepository>.value(value: bookingRepo),
            ChangeNotifierProvider<AuthProvider>.value(value: authProvider),
            ChangeNotifierProvider<AppModeProvider>(
              create: (_) => AppModeProvider(initialMode: AppMode.passenger),
            ),
            ChangeNotifierProvider<PassengerHomeProvider>(
              create: (_) => PassengerHomeProvider(),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.lightTheme,
            home: const PassengerHomeScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Check Active Booking Card
      expect(find.byKey(const Key('active_booking_card')), findsOneWidget);
      expect(find.byKey(const Key('active_booking_status_badge')), findsOneWidget);
      expect(find.text('MATCHING'), findsOneWidget);
      expect(find.text('₹45.00'), findsOneWidget);
      expect(find.byKey(const Key('active_booking_id_text')), findsOneWidget);
    });
  });
}
