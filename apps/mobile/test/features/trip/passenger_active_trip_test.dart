import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
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
}

void main() {
  Widget buildTestWidget({
    required String bookingId,
    required TripRepository repository,
    PassengerActiveTripProvider? provider,
  }) {
    return MaterialApp(
      home: PassengerActiveTripScreen(
        bookingId: bookingId,
        repository: repository,
        provider: provider,
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
  });
}
