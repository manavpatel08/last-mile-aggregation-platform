import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/booking/data/booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_details.dart';
import 'package:lastmile_mobile/features/trip/data/trip_repository.dart';
import 'package:lastmile_mobile/features/trip/models/passenger_boarding_pass.dart';
import 'package:lastmile_mobile/features/trip/models/trip_detail_model.dart';
import 'package:lastmile_mobile/features/trip/presentation/screens/passenger_active_trip_screen.dart';
import 'package:lastmile_mobile/features/trip/state/passenger_active_trip_provider.dart';

class _FakeTripRepository implements TripRepository {
  PassengerBoardingPass? passToReturn;
  Exception? errorToThrow;
  Completer<PassengerBoardingPass>? completer;
  int getBoardingPassCalls = 0;

  @override
  Future<PassengerBoardingPass> getPassengerBoardingPass(
      String bookingId) async {
    getBoardingPassCalls++;
    if (completer != null) {
      return completer!.future;
    }
    if (errorToThrow != null) throw errorToThrow!;
    return passToReturn ??
        PassengerBoardingPass(
          bookingId: bookingId,
          passengerId: 'pass-1',
          tripId: 'trip-1',
          boardingOtp: '4821',
          expiresAt: DateTime.now().add(const Duration(minutes: 25)),
          bookingStatus: 'DRIVER_ASSIGNED',
          driver: const BoardingPassDriver(
            name: 'Ramesh Patel',
            phoneNumber: '+919876543210',
            vehicle: BoardingPassDriverVehicle(
              registrationNumber: 'GJ01AB1234',
              makeModel: 'Mahindra Treo',
              vehicleType: 'E_RICKSHAW',
            ),
          ),
        );
  }

  @override
  Future<TripDetailModel> getTripDetails(String tripId) {
    throw UnimplementedError();
  }

  @override
  Future<ArrivePickupResponse> arriveAtPickup({
    required String tripId,
    required String idempotencyKey,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<VerifyBoardingResponse> verifyBoarding({
    required String tripId,
    required String passengerId,
    required String otp,
    required String idempotencyKey,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<StartTripResponse> startTrip({
    required String tripId,
    required String idempotencyKey,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<CompletePassengerResponse> completePassengerDropOff({
    required String tripId,
    required String passengerId,
    required String idempotencyKey,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<CompleteTripResponse> completeTrip({
    required String tripId,
    required String idempotencyKey,
  }) {
    throw UnimplementedError();
  }
}

class _FakeBookingRepository implements BookingRepository {
  String statusToReturn = 'BOARDED';
  int getBookingDetailsCalls = 0;

  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async {
    getBookingDetailsCalls++;
    return BookingDetails(
      bookingId: bookingId,
      status: statusToReturn,
      agreedFareCeiling: '45.00',
      maxWaitDeadline: DateTime.now().add(const Duration(minutes: 10)),
      passengerId: 'p-1',
      pickupPointId: 'zone-1',
      pickupPointName: 'PDEU Main Gate',
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  Widget buildTestWidget({
    required String bookingId,
    required TripRepository repository,
    BookingRepository? bookingRepository,
    PassengerActiveTripProvider? provider,
  }) {
    return MultiProvider(
      providers: [
        if (bookingRepository != null)
          Provider<BookingRepository>.value(value: bookingRepository),
        Provider<TripRepository>.value(value: repository),
      ],
      child: MaterialApp(
        home: PassengerActiveTripScreen(
          bookingId: bookingId,
          repository: repository,
          bookingRepository: bookingRepository,
          provider: provider,
        ),
      ),
    );
  }

  group('PassengerActiveTripScreen & Provider', () {
    testWidgets('displays loading indicator initially', (tester) async {
      final fakeRepo = _FakeTripRepository();
      fakeRepo.completer = Completer<PassengerBoardingPass>();
      final provider = PassengerActiveTripProvider(repository: fakeRepo);

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-1',
          repository: fakeRepo,
          provider: provider,
        ),
      );
      await tester.pump(); // trigger post frame callback

      expect(
        find.byKey(const Key('active_trip_loading_indicator')),
        findsOneWidget,
      );

      fakeRepo.completer!.complete(
        PassengerBoardingPass(
          bookingId: 'book-1',
          passengerId: 'pass-1',
          tripId: 'trip-1',
          boardingOtp: '4821',
          expiresAt: DateTime.now().add(const Duration(minutes: 25)),
          bookingStatus: 'DRIVER_ASSIGNED',
          driver: const BoardingPassDriver(name: 'Ramesh Patel'),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('active_trip_loading_indicator')),
        findsNothing,
      );
    });

    testWidgets('displays error banner and retry button on failure',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..errorToThrow = const ApiException(
          errorCode: 'BOOKING_NOT_ASSIGNED',
          message: 'Booking has not been assigned to a driver yet.',
        );

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-err',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('active_trip_error_banner')),
        findsOneWidget,
      );
      expect(
        find.text('Booking has not been assigned to a driver yet.'),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('retry_load_boarding_pass_button')),
        findsOneWidget,
      );

      // Now resolve error and tap Retry
      fakeRepo.errorToThrow = null;
      await tester.tap(find.byKey(const Key('retry_load_boarding_pass_button')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('active_trip_error_banner')),
        findsNothing,
      );
      expect(find.byKey(const Key('boarding_otp_display')), findsOneWidget);
    });

    testWidgets('displays driver, vehicle, and formatted 4-digit OTP card',
        (tester) async {
      final fakeRepo = _FakeTripRepository();

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-success',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      // Check OTP Display: 4-digit OTP formatted with spaces
      expect(find.byKey(const Key('boarding_otp_display')), findsOneWidget);
      expect(find.text('4  8  2  1'), findsOneWidget);

      // Check Driver Information
      expect(find.byKey(const Key('driver_name_text')), findsOneWidget);
      expect(find.text('Ramesh Patel'), findsOneWidget);
      expect(find.byKey(const Key('driver_phone_text')), findsOneWidget);
      expect(find.text('+919876543210'), findsOneWidget);

      // Check Vehicle Information
      expect(find.byKey(const Key('vehicle_make_model_text')), findsOneWidget);
      expect(find.text('Mahindra Treo'), findsOneWidget);
      expect(find.byKey(const Key('vehicle_reg_number_text')), findsOneWidget);
      expect(find.text('GJ01AB1234'), findsOneWidget);

      // Check Status
      expect(find.byKey(const Key('trip_status_text')), findsOneWidget);
      expect(find.text('Driver En Route to Hub'), findsOneWidget);
    });

    testWidgets('displays driver arrived status correctly', (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..passToReturn = PassengerBoardingPass(
          bookingId: 'book-arrived',
          passengerId: 'p-1',
          tripId: 't-1',
          boardingOtp: '9942',
          expiresAt: DateTime.now().add(const Duration(minutes: 20)),
          bookingStatus: 'DRIVER_ARRIVED',
          driver: const BoardingPassDriver(name: 'Suresh Kumar'),
        );

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-arrived',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver Arrived at Hub'), findsOneWidget);
      expect(find.text('9  9  4  2'), findsOneWidget);
    });

    testWidgets('refresh button triggers reload', (tester) async {
      final fakeRepo = _FakeTripRepository();

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-refresh',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();
      expect(fakeRepo.getBoardingPassCalls, 1);

      await tester
          .tap(find.byKey(const Key('refresh_boarding_pass_button')));
      await tester.pumpAndSettle();
      expect(fakeRepo.getBoardingPassCalls, 2);
    });

    testWidgets('displays boarded state with verified checkmark card and no OTP',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..passToReturn = PassengerBoardingPass(
          bookingId: 'book-boarded',
          passengerId: 'p-1',
          tripId: 't-1',
          boardingOtp: '4821',
          expiresAt: DateTime.now().add(const Duration(minutes: 20)),
          bookingStatus: 'BOARDED',
          driver: const BoardingPassDriver(name: 'Ramesh Patel'),
        );

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-boarded',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Boarded — Ride Starting Soon'), findsOneWidget);
      expect(find.byKey(const Key('boarding_verified_card')), findsOneWidget);
      expect(find.byKey(const Key('boarding_otp_display')), findsNothing);
      expect(find.text('Boarding Verified'), findsOneWidget);
    });

    testWidgets('displays in progress status banner when ride is in progress',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..passToReturn = PassengerBoardingPass(
          bookingId: 'book-in-prog',
          passengerId: 'p-1',
          tripId: 't-1',
          boardingOtp: '4821',
          expiresAt: DateTime.now().add(const Duration(minutes: 20)),
          bookingStatus: 'IN_PROGRESS',
          driver: const BoardingPassDriver(name: 'Ramesh Patel'),
        );

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-in-prog',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Trip In Progress — En Route'), findsOneWidget);
      expect(find.byKey(const Key('boarding_verified_card')), findsOneWidget);
      expect(find.byKey(const Key('boarding_otp_display')), findsNothing);
    });

    testWidgets('displays completed status banner when ride is completed',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..passToReturn = PassengerBoardingPass(
          bookingId: 'book-completed',
          passengerId: 'p-1',
          tripId: 't-1',
          boardingOtp: '4821',
          expiresAt: DateTime.now().add(const Duration(minutes: 20)),
          bookingStatus: 'COMPLETED',
          driver: const BoardingPassDriver(name: 'Ramesh Patel'),
        );

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-completed',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Trip Completed — Arrived'), findsOneWidget);
      expect(find.byKey(const Key('boarding_verified_card')), findsOneWidget);
      expect(find.byKey(const Key('boarding_otp_display')), findsNothing);
    });

    testWidgets(
        'OTP_ALREADY_CONSUMED recovers status from BookingRepository and manual refresh updates to IN_PROGRESS and COMPLETED',
        (tester) async {
      final fakeTripRepo = _FakeTripRepository()
        ..errorToThrow = const ApiException(
          message: 'OTP has already been verified and consumed',
          statusCode: 400,
          errorCode: 'OTP_ALREADY_CONSUMED',
        );
      final fakeBookingRepo = _FakeBookingRepository()..statusToReturn = 'BOARDED';

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-recovered-1',
          repository: fakeTripRepo,
          bookingRepository: fakeBookingRepo,
        ),
      );
      await tester.pumpAndSettle();

      // Screen recovers from OTP_ALREADY_CONSUMED into BOARDED
      expect(find.text('Boarded — Ride Starting Soon'), findsOneWidget);
      expect(find.byKey(const Key('boarding_verified_card')), findsOneWidget);
      expect(find.byKey(const Key('active_trip_error_banner')), findsNothing);
      expect(fakeBookingRepo.getBookingDetailsCalls, 1);

      // Now trip starts (status -> IN_PROGRESS), passenger taps refresh
      fakeBookingRepo.statusToReturn = 'IN_PROGRESS';
      await tester.tap(find.byKey(const Key('refresh_boarding_pass_button')));
      await tester.pumpAndSettle();

      expect(find.text('Trip In Progress — En Route'), findsOneWidget);
      expect(find.text('Trip In Progress'), findsOneWidget);
      expect(fakeBookingRepo.getBookingDetailsCalls, 2);

      // Now passenger is dropped off (status -> COMPLETED), passenger taps refresh
      fakeBookingRepo.statusToReturn = 'COMPLETED';
      await tester.tap(find.byKey(const Key('refresh_boarding_pass_button')));
      await tester.pumpAndSettle();

      expect(find.text('Trip Completed — Arrived'), findsOneWidget);
      expect(find.text('Drop-Off Completed'), findsOneWidget);
      expect(fakeBookingRepo.getBookingDetailsCalls, 3);
    });

    testWidgets(
        'resolves BookingRepository from context when not explicitly passed in constructor',
        (tester) async {
      final fakeTripRepo = _FakeTripRepository()
        ..errorToThrow = const ApiException(
          message: 'OTP already consumed',
          statusCode: 400,
          errorCode: 'OTP_ALREADY_CONSUMED',
        );
      final fakeBookingRepo = _FakeBookingRepository()..statusToReturn = 'BOARDED';

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            Provider<BookingRepository>.value(value: fakeBookingRepo),
            Provider<TripRepository>.value(value: fakeTripRepo),
          ],
          child: const MaterialApp(
            home: PassengerActiveTripScreen(
              bookingId: 'book-context-test',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Boarded — Ride Starting Soon'), findsOneWidget);
      expect(find.byKey(const Key('boarding_verified_card')), findsOneWidget);
      expect(find.byKey(const Key('active_trip_error_banner')), findsNothing);
      expect(fakeBookingRepo.getBookingDetailsCalls, 1);
    });

    testWidgets(
        'reliably handles exact backend OTP_ALREADY_CONSUMED response envelope, recovers status, and never exposes placeholder OTP or fictitious vehicle info',
        (tester) async {
      final backendErrorResponse = Response(
        requestOptions: RequestOptions(
          path: '/api/v1/bookings/book-actual-shape/boarding-pass',
        ),
        statusCode: 400,
        data: <String, dynamic>{
          'success': false,
          'statusCode': 400,
          'errorCode': 'OTP_ALREADY_CONSUMED',
          'message': 'Boarding OTP has already been used or trip is completed.',
          'errors': <dynamic>[],
          'timestamp': '2026-11-22T03:50:00.000Z',
          'path': '/api/v1/bookings/book-actual-shape/boarding-pass',
        },
      );
      final apiException = ApiException.fromDioException(
        DioException(
          requestOptions: backendErrorResponse.requestOptions,
          response: backendErrorResponse,
          type: DioExceptionType.badResponse,
        ),
      );

      final fakeTripRepo = _FakeTripRepository()..errorToThrow = apiException;
      final fakeBookingRepo =
          _FakeBookingRepository()..statusToReturn = 'BOARDED';

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-actual-shape',
          repository: fakeTripRepo,
          bookingRepository: fakeBookingRepo,
        ),
      );
      await tester.pumpAndSettle();

      // 1. Confirms BookingRepository.getBookingDetails was called
      expect(fakeBookingRepo.getBookingDetailsCalls, 1);

      // 2. Confirms verified card is shown, not the error banner
      expect(find.byKey(const Key('active_trip_error_banner')), findsNothing);
      expect(find.byKey(const Key('boarding_verified_card')), findsOneWidget);
      expect(find.text('Boarded — Ride Starting Soon'), findsOneWidget);

      // 3. Confirms placeholder OTP ('••••') is NEVER rendered as credentials to passenger
      expect(find.byKey(const Key('boarding_otp_display')), findsNothing);
      expect(find.text('••••'), findsNothing);

      // 4. Confirms fallback driver metadata shows non-fictitious placeholder without vehicle details
      expect(find.byKey(const Key('driver_name_text')), findsOneWidget);
      expect(find.text('Assigned Driver'), findsOneWidget);
      expect(find.byKey(const Key('vehicle_make_model_text')), findsNothing);
      expect(find.byKey(const Key('vehicle_reg_number_text')), findsNothing);
    });

    testWidgets(
        'reliably handles backend OTP_ALREADY_VERIFIED response envelope and recovers status',
        (tester) async {
      final backendErrorResponse = Response(
        requestOptions: RequestOptions(
          path: '/api/v1/bookings/book-verified-shape/boarding-pass',
        ),
        statusCode: 400,
        data: <String, dynamic>{
          'success': false,
          'statusCode': 400,
          'errorCode': 'OTP_ALREADY_VERIFIED',
          'message': 'Boarding OTP has already been verified.',
          'errors': <dynamic>[],
          'timestamp': '2026-11-22T03:50:00.000Z',
          'path': '/api/v1/bookings/book-verified-shape/boarding-pass',
        },
      );
      final apiException = ApiException.fromDioException(
        DioException(
          requestOptions: backendErrorResponse.requestOptions,
          response: backendErrorResponse,
          type: DioExceptionType.badResponse,
        ),
      );

      final fakeTripRepo = _FakeTripRepository()..errorToThrow = apiException;
      final fakeBookingRepo =
          _FakeBookingRepository()..statusToReturn = 'IN_PROGRESS';

      await tester.pumpWidget(
        buildTestWidget(
          bookingId: 'book-verified-shape',
          repository: fakeTripRepo,
          bookingRepository: fakeBookingRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(fakeBookingRepo.getBookingDetailsCalls, 1);
      expect(find.byKey(const Key('boarding_verified_card')), findsOneWidget);
      expect(find.text('Trip In Progress — En Route'), findsOneWidget);
      expect(find.byKey(const Key('boarding_otp_display')), findsNothing);
    });
  });
}
