import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/trip/data/trip_repository.dart';
import 'package:lastmile_mobile/features/trip/models/cash_confirmation_model.dart';
import 'package:lastmile_mobile/features/trip/models/passenger_boarding_pass.dart';
import 'package:lastmile_mobile/features/trip/models/trip_detail_model.dart';
import 'package:lastmile_mobile/features/trip/presentation/screens/driver_active_trip_screen.dart';
import 'package:lastmile_mobile/features/trip/state/driver_active_trip_provider.dart';

class _FakeTripRepository implements TripRepository {
  TripDetailModel? tripToReturn;
  Exception? loadError;
  Exception? arriveError;
  Exception? verifyError;

  int arriveCalls = 0;
  int verifyCalls = 0;
  String? lastVerifiedOtp;
  final List<String> verifyIdempotencyKeys = [];
  final List<String> verifyOtps = [];
  Future<VerifyBoardingResponse> Function(
    String tripId,
    String passengerId,
    String otp,
    String idempotencyKey,
  )? onVerifyBoarding;

  @override
  Future<TripDetailModel> getTripDetails(String tripId) async {
    if (loadError != null) throw loadError!;
    return tripToReturn ??
        TripDetailModel(
          tripId: tripId,
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'CREATED',
          passengers: const [
            TripPassengerModel(
              id: 'tp-1',
              passengerId: 'p-1',
              bookingId: 'book-1111-2222',
              status: 'ASSIGNED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
            TripPassengerModel(
              id: 'tp-2',
              passengerId: 'p-2',
              bookingId: 'book-3333-4444',
              status: 'ASSIGNED',
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
    arriveCalls++;
    if (arriveError != null) throw arriveError!;
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
    verifyCalls++;
    lastVerifiedOtp = otp;
    verifyOtps.add(otp);
    verifyIdempotencyKeys.add(idempotencyKey);
    if (onVerifyBoarding != null) {
      return onVerifyBoarding!(tripId, passengerId, otp, idempotencyKey);
    }
    if (verifyError != null) throw verifyError!;
    return const VerifyBoardingResponse(
      success: true,
      passengerStatus: 'BOARDED',
      waitingChargePaise: 0,
    );
  }

  @override
  Future<PassengerBoardingPass> getPassengerBoardingPass(String bookingId) {
    throw UnimplementedError();
  }

  int startTripCalls = 0;
  int completePassengerCalls = 0;
  int completeTripCalls = 0;
  Exception? startTripError;
  Exception? completePassengerError;
  Exception? completeTripError;

  @override
  Future<StartTripResponse> startTrip({
    required String tripId,
    required String idempotencyKey,
  }) async {
    startTripCalls++;
    if (startTripError != null) throw startTripError!;
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
    completePassengerCalls++;
    if (completePassengerError != null) throw completePassengerError!;
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
    completeTripCalls++;
    if (completeTripError != null) throw completeTripError!;
    return CompleteTripResponse(
      tripId: tripId,
      status: 'COMPLETED',
      completedAt: DateTime.now(),
    );
  }

  int confirmCashCalls = 0;
  Exception? confirmCashError;
  String? lastConfirmedTripId;
  String? lastConfirmedTripPassengerId;
  int? lastConfirmedAmountPaise;
  String? lastConfirmedIdempotencyKey;
  final List<String> confirmCashIdempotencyKeys = [];
  CashConfirmationModel Function(
    String tripId,
    String tripPassengerId,
    int amountCollectedPaise,
    String idempotencyKey,
  )? onConfirmCash;

  @override
  Future<CashConfirmationModel> confirmCash({
    required String tripId,
    required String tripPassengerId,
    required int amountCollectedPaise,
    required String idempotencyKey,
  }) async {
    confirmCashCalls++;
    lastConfirmedTripId = tripId;
    lastConfirmedTripPassengerId = tripPassengerId;
    lastConfirmedAmountPaise = amountCollectedPaise;
    lastConfirmedIdempotencyKey = idempotencyKey;
    confirmCashIdempotencyKeys.add(idempotencyKey);
    if (confirmCashError != null) throw confirmCashError!;
    if (onConfirmCash != null) {
      return onConfirmCash!(
        tripId,
        tripPassengerId,
        amountCollectedPaise,
        idempotencyKey,
      );
    }
    return CashConfirmationModel(
      collectionId: 'coll-test-1',
      tripId: tripId,
      tripPassengerId: tripPassengerId,
      driverId: 'driver-1',
      totalCashCollectedPaise: amountCollectedPaise,
      totalCashCollected: (amountCollectedPaise / 100).toStringAsFixed(2),
      rideFarePaise: 3800,
      rideFare: '38.00',
      waitingChargePaise: 0,
      waitingCharge: '0.00',
      surchargeFeesPaise:
          amountCollectedPaise > 3800 ? amountCollectedPaise - 3800 : 0,
      surchargeFees: amountCollectedPaise > 3800
          ? ((amountCollectedPaise - 3800) / 100).toStringAsFixed(2)
          : '0.00',
      collectedFeeIds:
          amountCollectedPaise > 3800 ? const ['fee-1'] : const [],
      paymentStatus: 'PAID',
      confirmedAt: DateTime.parse('2026-11-22T04:00:00.000Z'),
      paymentAllocations: [
        PaymentAllocationModel(
          id: 'alloc-1',
          obligationType: 'RIDE_FARE',
          obligationEntityId: tripPassengerId,
          allocatedAmountPaise: 3800,
          allocatedAmount: '38.00',
        ),
        if (amountCollectedPaise > 3800)
          PaymentAllocationModel(
            id: 'alloc-2',
            obligationType: 'CANCELLATION_FEE_SURCHARGE',
            obligationEntityId: 'fee-1',
            allocatedAmountPaise: amountCollectedPaise - 3800,
            allocatedAmount:
                ((amountCollectedPaise - 3800) / 100).toStringAsFixed(2),
          ),
      ],
    );
  }
}

void main() {
  Widget buildTestWidget({
    required String tripId,
    required TripRepository repository,
    DriverActiveTripProvider? provider,
  }) {
    return MaterialApp(
      home: DriverActiveTripScreen(
        tripId: tripId,
        repository: repository,
        provider: provider,
      ),
    );
  }

  group('DriverActiveTripScreen & Provider', () {
    testWidgets('renders trip manifest and passengers list', (tester) async {
      final fakeRepo = _FakeTripRepository();

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-123',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Trip Manifest & Boarding'), findsOneWidget);
      expect(find.text('Assigned Passengers (2)'), findsOneWidget);
      expect(find.text('Passenger 1'), findsOneWidget);
      expect(find.text('Passenger 2'), findsOneWidget);
      expect(
        find.byKey(const Key('driver_arrived_button')),
        findsOneWidget,
      );
    });

    testWidgets('tapping Arrived button reports arrival and updates UI',
        (tester) async {
      final fakeRepo = _FakeTripRepository();

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-123',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(fakeRepo.arriveCalls, 0);
      await tester.tap(find.byKey(const Key('driver_arrived_button')));
      await tester.pumpAndSettle();

      expect(fakeRepo.arriveCalls, 1);
      expect(
        find.byKey(const Key('arrived_status_indicator')),
        findsOneWidget,
      );
      expect(find.text('Arrived at Pickup Hub'), findsWidgets);
    });

    testWidgets('validates 4-digit OTP format before submitting',
        (tester) async {
      final fakeRepo = _FakeTripRepository();

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-123',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      // Enter short OTP (3 digits)
      final otpField = find.byKey(const Key('otp_input_p-1'));
      await tester.enterText(otpField, '123');
      await tester.tap(find.byKey(const Key('verify_otp_button_p-1')));
      await tester.pumpAndSettle();

      // Verification should NOT have been called
      expect(fakeRepo.verifyCalls, 0);
      expect(
        find.byKey(const Key('passenger_error_p-1')),
        findsOneWidget,
      );
      expect(
        find.text('Please enter a valid 4-digit numeric OTP.'),
        findsOneWidget,
      );
    });

    testWidgets(
        'successful 4-digit OTP verification updates passenger status to Boarded',
        (tester) async {
      final fakeRepo = _FakeTripRepository();

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-123',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      // Enter valid 4-digit OTP for Passenger 1
      final otpField = find.byKey(const Key('otp_input_p-1'));
      await tester.enterText(otpField, '4821');
      await tester.tap(find.byKey(const Key('verify_otp_button_p-1')));
      await tester.pumpAndSettle();

      expect(fakeRepo.verifyCalls, 1);
      expect(fakeRepo.lastVerifiedOtp, '4821');

      // Passenger 1 should now be marked Boarded
      expect(
        find.byKey(const Key('passenger_verified_label_p-1')),
        findsOneWidget,
      );
      expect(find.text('Boarding Verified'), findsOneWidget);
      expect(
        find.byKey(const Key('driver_trip_success_banner')),
        findsOneWidget,
      );

      // Passenger 2 should remain unboarded with OTP input intact
      expect(
        find.byKey(const Key('otp_input_p-2')),
        findsOneWidget,
      );
    });

    testWidgets('displays backend verification error for specific passenger',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..verifyError = const ApiException(
          errorCode: 'INVALID_OTP',
          message: 'Invalid boarding OTP provided.',
        );

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-123',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      final otpField = find.byKey(const Key('otp_input_p-1'));
      await tester.enterText(otpField, '0000');
      await tester.tap(find.byKey(const Key('verify_otp_button_p-1')));
      await tester.pumpAndSettle();

      expect(fakeRepo.verifyCalls, 1);
      expect(
        find.byKey(const Key('passenger_error_p-1')),
        findsOneWidget,
      );
      expect(find.text('Invalid boarding OTP provided.'), findsOneWidget);

      // Passenger 1 OTP field should still be available to retry
      expect(
        find.byKey(const Key('otp_input_p-1')),
        findsOneWidget,
      );
    });
  });

  group('DriverActiveTripProvider - OTP Idempotency Retry Lifecycle', () {
    test(
        'Test 1 — Incorrect OTP followed by corrected OTP uses fresh key and succeeds',
        () async {
      final fakeRepo = _FakeTripRepository();
      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-123');

      // Attempt 1: Driver enters incorrect OTP "0000"
      fakeRepo.onVerifyBoarding = (tripId, passengerId, otp, key) async {
        throw const ApiException(
          statusCode: 400,
          errorCode: 'INVALID_OTP',
          message: 'Invalid boarding OTP provided.',
        );
      };

      final attempt1Success = await provider.verifyPassengerOtp(
        passengerId: 'p-1',
        otp: '0000',
      );

      expect(attempt1Success, isFalse);
      expect(fakeRepo.verifyCalls, 1);
      expect(fakeRepo.verifyOtps[0], '0000');
      final firstKey = fakeRepo.verifyIdempotencyKeys[0];
      expect(
        provider.errorForPassenger('p-1'),
        'Invalid boarding OTP provided.',
      );

      // Attempt 2: Driver enters corrected OTP "4821"
      fakeRepo.onVerifyBoarding = (tripId, passengerId, otp, key) async {
        return const VerifyBoardingResponse(
          success: true,
          passengerStatus: 'BOARDED',
          waitingChargePaise: 0,
        );
      };

      final attempt2Success = await provider.verifyPassengerOtp(
        passengerId: 'p-1',
        otp: '4821',
      );

      expect(attempt2Success, isTrue);
      expect(fakeRepo.verifyCalls, 2);
      expect(fakeRepo.verifyOtps[1], '4821');
      final secondKey = fakeRepo.verifyIdempotencyKeys[1];

      // Second attempt MUST use a distinct idempotency key
      expect(secondKey, isNot(equals(firstKey)));

      // Status of passenger must now be BOARDED
      final passenger =
          provider.passengers.firstWhere((p) => p.passengerId == 'p-1');
      expect(passenger.status, 'BOARDED');
      expect(passenger.isBoarded, isTrue);
      expect(provider.errorForPassenger('p-1'), isNull);
    });

    test(
        'Test 2 — Ambiguous network failure retains idempotency key across retry',
        () async {
      final fakeRepo = _FakeTripRepository();
      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-123');

      // Attempt 1: Simulated timeout / network dropout
      fakeRepo.onVerifyBoarding = (tripId, passengerId, otp, key) async {
        throw const ApiException(
          statusCode: null,
          errorCode: 'REQUEST_TIMEOUT',
          message: 'The request timed out. Please try again.',
        );
      };

      final attempt1Success = await provider.verifyPassengerOtp(
        passengerId: 'p-1',
        otp: '4821',
      );

      expect(attempt1Success, isFalse);
      expect(fakeRepo.verifyCalls, 1);
      final firstKey = fakeRepo.verifyIdempotencyKeys[0];

      // Attempt 2: Retry the same logical OTP request "4821"
      fakeRepo.onVerifyBoarding = (tripId, passengerId, otp, key) async {
        return const VerifyBoardingResponse(
          success: true,
          passengerStatus: 'BOARDED',
          waitingChargePaise: 0,
        );
      };

      final attempt2Success = await provider.verifyPassengerOtp(
        passengerId: 'p-1',
        otp: '4821',
      );

      expect(attempt2Success, isTrue);
      expect(fakeRepo.verifyCalls, 2);
      final retryKey = fakeRepo.verifyIdempotencyKeys[1];

      // Must reuse the exact same idempotency key for the same logical request after timeout
      expect(retryKey, equals(firstKey));

      final passenger =
          provider.passengers.firstWhere((p) => p.passengerId == 'p-1');
      expect(passenger.status, 'BOARDED');
    });

    test(
        'Test 3 — Successful verification clears completed idempotency key',
        () async {
      final fakeRepo = _FakeTripRepository();
      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-123');

      final success = await provider.verifyPassengerOtp(
        passengerId: 'p-1',
        otp: '4821',
      );

      expect(success, isTrue);
      expect(fakeRepo.verifyCalls, 1);
      expect(
        provider.passengers.firstWhere((p) => p.passengerId == 'p-1').isBoarded,
        isTrue,
      );

      // Completed idempotency key is cleared appropriately
      expect(provider.getIdempotencyKeyForPassenger('p-1'), isNull);
    });
  });

  group('DriverActiveTrip - Progression Flow (Start, Drop-Off, Complete)', () {
    testWidgets(
        'canStartTrip enables button when AT_PICKUP and all boarded; tapping starts trip',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-prog-1',
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
            TripPassengerModel(
              id: 'tp-2',
              passengerId: 'p-2',
              bookingId: 'book-2',
              status: 'BOARDED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        );

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-prog-1',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('start_trip_button')), findsOneWidget);
      expect(find.text('Start Trip (Depart Hub)'), findsOneWidget);

      await tester.tap(find.byKey(const Key('start_trip_button')));
      await tester.pumpAndSettle();

      expect(fakeRepo.startTripCalls, 1);
      expect(find.byKey(const Key('trip_in_progress_indicator')), findsOneWidget);
      expect(find.text('Trip In Progress — Delivering Passengers'), findsOneWidget);
    });

    testWidgets(
        'canStartTrip remains disabled when all passengers are NO_SHOW',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-prog-all-noshow',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'AT_PICKUP',
          driverArrivedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-1',
              passengerId: 'p-1',
              bookingId: 'book-1',
              status: 'NO_SHOW',
              finalRideFarePaise: 0,
              waitingChargePaise: 0,
            ),
            TripPassengerModel(
              id: 'tp-2',
              passengerId: 'p-2',
              bookingId: 'book-2',
              status: 'NO_SHOW',
              finalRideFarePaise: 0,
              waitingChargePaise: 0,
            ),
          ],
        );

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-prog-all-noshow',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('start_trip_button')), findsNothing);
    });

    testWidgets(
        'canStartTrip enables button when at least one passenger is BOARDED alongside a NO_SHOW passenger',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-prog-mixed-boarded',
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
            TripPassengerModel(
              id: 'tp-2',
              passengerId: 'p-2',
              bookingId: 'book-2',
              status: 'NO_SHOW',
              finalRideFarePaise: 0,
              waitingChargePaise: 0,
            ),
          ],
        );

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-prog-mixed-boarded',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('start_trip_button')), findsOneWidget);
      expect(find.text('Start Trip (Depart Hub)'), findsOneWidget);

      await tester.tap(find.byKey(const Key('start_trip_button')));
      await tester.pumpAndSettle();

      expect(fakeRepo.startTripCalls, 1);
    });

    testWidgets(
        'completing passenger drop-off records cash and displays breakdown',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-prog-2',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
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

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-prog-2',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('complete_drop_off_button_p-1')), findsOneWidget);
      expect(find.text('Complete Drop-Off'), findsOneWidget);

      await tester.tap(find.byKey(const Key('complete_drop_off_button_p-1')));
      await tester.pumpAndSettle();

      expect(fakeRepo.completePassengerCalls, 1);
      expect(find.byKey(const Key('cash_breakdown_p-1')), findsOneWidget);
      expect(find.text('Ride Fare: ₹38.00'), findsOneWidget);
      expect(find.text('Waiting Charge: ₹0.00'), findsOneWidget);
      expect(find.text('Total Cash to Collect: ₹38.00'), findsOneWidget);
      expect(find.text('COMPLETED'), findsWidgets);
    });

    testWidgets(
        'canCompleteTrip enables Finalize Trip when all passengers COMPLETED; tapping completes trip',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-prog-3',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-1',
              passengerId: 'p-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        );

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-prog-3',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('finalize_trip_button')), findsOneWidget);
      expect(find.text('Finalize Trip'), findsOneWidget);

      await tester.tap(find.byKey(const Key('finalize_trip_button')));
      await tester.pumpAndSettle();

      expect(fakeRepo.completeTripCalls, 1);
      expect(
        find.byKey(const Key('trip_completed_status_indicator')),
        findsOneWidget,
      );
      expect(find.text('Trip Completed'), findsOneWidget);
      expect(find.byKey(const Key('return_home_button')), findsOneWidget);
    });

    testWidgets(
        'canCompleteTrip enables Finalize Trip when passengers include CANCELLED alongside COMPLETED',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-prog-cancelled-1',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-1',
              passengerId: 'p-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
            TripPassengerModel(
              id: 'tp-2',
              passengerId: 'p-2',
              bookingId: 'book-2',
              status: 'CANCELLED',
              finalRideFarePaise: 0,
              waitingChargePaise: 0,
            ),
          ],
        );

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-prog-cancelled-1',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      // Passenger 1 shows Drop-Off Completed
      expect(
        find.byKey(const Key('passenger_completed_label_p-1')),
        findsOneWidget,
      );
      // Passenger 2 shows Booking Cancelled
      expect(
        find.byKey(const Key('passenger_cancelled_label_p-2')),
        findsOneWidget,
      );
      expect(find.text('Booking Cancelled'), findsOneWidget);

      // Finalize Trip button is enabled
      expect(find.byKey(const Key('finalize_trip_button')), findsOneWidget);
      expect(find.text('Finalize Trip'), findsOneWidget);

      await tester.tap(find.byKey(const Key('finalize_trip_button')));
      await tester.pumpAndSettle();

      expect(fakeRepo.completeTripCalls, 1);
      expect(
        find.byKey(const Key('trip_completed_status_indicator')),
        findsOneWidget,
      );
    });

    testWidgets(
        'canCompleteTrip is disabled when any passenger is non-terminal (e.g. BOARDED or ASSIGNED)',
        (tester) async {
      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-prog-non-terminal',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-1',
              passengerId: 'p-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
            TripPassengerModel(
              id: 'tp-2',
              passengerId: 'p-2',
              bookingId: 'book-2',
              status: 'BOARDED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        );

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-prog-non-terminal',
          repository: fakeRepo,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('finalize_trip_button')), findsNothing);
    });
  });

  group('DriverActiveTrip - Cash Collection and Payment Receipt', () {
    testWidgets(
        'confirms cash payment with authoritative paise, tripPassengerId, and Idempotency-Key, then renders receipt with breakdown and allocations',
        (tester) async {
      tester.view.physicalSize = const Size(2400, 4800);
      addTearDown(tester.view.resetPhysicalSize);

      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-cash-1',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-uuid-1',
              passengerId: 'p-user-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        );

      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-cash-1');

      // Complete drop-off first to establish authoritative drop-off response with surcharge
      fakeRepo.completePassengerError = null;
      await provider.completePassengerDropOff(passengerId: 'p-user-1');

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-cash-1',
          repository: fakeRepo,
          provider: provider,
        ),
      );
      await tester.pumpAndSettle();

      // Drop-off breakdown is rendered with Confirm Cash button
      expect(find.byKey(const Key('cash_breakdown_p-user-1')), findsOneWidget);
      expect(
        find.byKey(const Key('confirm_cash_button_p-user-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('payment_receipt_p-user-1')),
        findsNothing,
      );

      // Tap Confirm Cash Payment
      await tester.ensureVisible(
        find.byKey(const Key('confirm_cash_button_p-user-1')),
      );
      await tester.tap(find.byKey(const Key('confirm_cash_button_p-user-1')));
      await tester.pumpAndSettle();

      // 1. Verify repository call and exact parameters
      expect(fakeRepo.confirmCashCalls, 1);
      expect(fakeRepo.lastConfirmedTripId, 'trip-cash-1');
      expect(fakeRepo.lastConfirmedTripPassengerId, 'tp-uuid-1');
      expect(fakeRepo.lastConfirmedAmountPaise, 3800);
      expect(fakeRepo.lastConfirmedIdempotencyKey, isNotNull);
      expect(fakeRepo.lastConfirmedIdempotencyKey, isNotEmpty);

      // 2. Button is replaced by Payment Collected receipt
      expect(
        find.byKey(const Key('confirm_cash_button_p-user-1')),
        findsNothing,
      );
      expect(find.byKey(const Key('payment_receipt_p-user-1')), findsOneWidget);
      expect(
        find.byKey(const Key('payment_collected_badge_p-user-1')),
        findsOneWidget,
      );
      expect(find.text('Payment Collected'), findsOneWidget);
      expect(find.byKey(const Key('receipt_status_p-user-1')), findsOneWidget);
      expect(find.text('PAID'), findsOneWidget);

      // 3. Receipt details and payment breakdown rendering
      expect(
        find.byKey(const Key('confirmed_cash_total_p-user-1')),
        findsOneWidget,
      );
      expect(find.text('₹38.00'), findsWidgets);
      expect(find.text('Ride Fare: ₹38.00'), findsOneWidget);
      expect(find.text('Waiting Charge: ₹0.00'), findsOneWidget);
      expect(find.text('• RIDE_FARE: ₹38.00'), findsOneWidget);
      expect(
        find.byKey(const Key('confirmed_at_text_p-user-1')),
        findsOneWidget,
      );
    });

    testWidgets(
        'renders surcharge fees and allocations when returned by backend',
        (tester) async {
      tester.view.physicalSize = const Size(2400, 4800);
      addTearDown(tester.view.resetPhysicalSize);

      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-surcharge-1',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-sur-1',
              passengerId: 'p-sur-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        )
        ..onConfirmCash = (tripId, tripPassengerId, amount, key) {
          return CashConfirmationModel(
            collectionId: 'coll-sur-1',
            tripId: tripId,
            tripPassengerId: tripPassengerId,
            driverId: 'driver-1',
            totalCashCollectedPaise: 6800,
            totalCashCollected: '68.00',
            rideFarePaise: 3800,
            rideFare: '38.00',
            waitingChargePaise: 0,
            waitingCharge: '0.00',
            surchargeFeesPaise: 3000,
            surchargeFees: '30.00',
            collectedFeeIds: const ['fee-uuid-1'],
            paymentStatus: 'PAID',
            confirmedAt: DateTime.parse('2026-11-22T04:00:00.000Z'),
            paymentAllocations: const [
              PaymentAllocationModel(
                id: 'alloc-1',
                obligationType: 'RIDE_FARE',
                obligationEntityId: 'tp-sur-1',
                allocatedAmountPaise: 3800,
                allocatedAmount: '38.00',
              ),
              PaymentAllocationModel(
                id: 'alloc-2',
                obligationType: 'CANCELLATION_FEE_SURCHARGE',
                obligationEntityId: 'fee-uuid-1',
                allocatedAmountPaise: 3000,
                allocatedAmount: '30.00',
              ),
            ],
          );
        };

      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-surcharge-1');
      await provider.completePassengerDropOff(passengerId: 'p-sur-1');

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-surcharge-1',
          repository: fakeRepo,
          provider: provider,
        ),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.byKey(const Key('confirm_cash_button_p-sur-1')),
      );
      await tester.tap(find.byKey(const Key('confirm_cash_button_p-sur-1')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('payment_receipt_p-sur-1')), findsOneWidget);
      expect(
        find.byKey(const Key('confirmed_cash_total_p-sur-1')),
        findsOneWidget,
      );
      expect(find.text('₹68.00'), findsOneWidget);
      expect(
        find.byKey(const Key('receipt_surcharge_fees_p-sur-1')),
        findsOneWidget,
      );
      expect(find.text('Surcharge Fees: ₹30.00'), findsOneWidget);
      expect(find.text('• RIDE_FARE: ₹38.00'), findsOneWidget);
      expect(
        find.text('• CANCELLATION_FEE_SURCHARGE: ₹30.00'),
        findsOneWidget,
      );
    });

    testWidgets(
        'handles CASH_ALREADY_COLLECTED error and does not show false receipt',
        (tester) async {
      tester.view.physicalSize = const Size(2400, 4800);
      addTearDown(tester.view.resetPhysicalSize);

      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-conflict-1',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-c-1',
              passengerId: 'p-c-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        )
        ..confirmCashError = const ApiException(
          statusCode: 409,
          errorCode: 'CASH_ALREADY_COLLECTED',
          message:
              'Cash collection has already been confirmed for this passenger journey.',
        );

      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-conflict-1');
      await provider.completePassengerDropOff(passengerId: 'p-c-1');

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-conflict-1',
          repository: fakeRepo,
          provider: provider,
        ),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.byKey(const Key('confirm_cash_button_p-c-1')),
      );
      await tester.tap(find.byKey(const Key('confirm_cash_button_p-c-1')));
      await tester.pumpAndSettle();

      expect(fakeRepo.confirmCashCalls, 1);
      expect(find.byKey(const Key('payment_receipt_p-c-1')), findsNothing);
      expect(find.byKey(const Key('cash_error_p-c-1')), findsOneWidget);
      expect(
        find.text(
          'Cash collection has already been confirmed for this passenger journey.',
        ),
        findsOneWidget,
      );
      // Key is cleared on definitive error
      expect(provider.getCashIdempotencyKeyForPassenger('p-c-1'), isNull);
    });

    testWidgets(
        'handles INVALID_COLLECTION_AMOUNT error and clears idempotency key',
        (tester) async {
      tester.view.physicalSize = const Size(2400, 4800);
      addTearDown(tester.view.resetPhysicalSize);

      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-invalid-amt',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-inv-1',
              passengerId: 'p-inv-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        )
        ..confirmCashError = const ApiException(
          statusCode: 400,
          errorCode: 'INVALID_COLLECTION_AMOUNT',
          message:
              'Collected amount (3800 paise) does not match expected payable total (6800 paise).',
        );

      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-invalid-amt');
      await provider.completePassengerDropOff(passengerId: 'p-inv-1');

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-invalid-amt',
          repository: fakeRepo,
          provider: provider,
        ),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.byKey(const Key('confirm_cash_button_p-inv-1')),
      );
      await tester.tap(find.byKey(const Key('confirm_cash_button_p-inv-1')));
      await tester.pumpAndSettle();

      expect(fakeRepo.confirmCashCalls, 1);
      expect(find.byKey(const Key('payment_receipt_p-inv-1')), findsNothing);
      expect(find.byKey(const Key('cash_error_p-inv-1')), findsOneWidget);
      expect(
        find.text(
          'Collected amount (3800 paise) does not match expected payable total (6800 paise).',
        ),
        findsOneWidget,
      );
      expect(provider.getCashIdempotencyKeyForPassenger('p-inv-1'), isNull);
    });

    testWidgets(
        'retains exact same Idempotency-Key across ambiguous network timeout and safe retry succeeds',
        (tester) async {
      tester.view.physicalSize = const Size(2400, 4800);
      addTearDown(tester.view.resetPhysicalSize);

      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-timeout-1',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-timeout-1',
              passengerId: 'p-timeout-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        )
        ..confirmCashError = const ApiException(
          statusCode: null,
          errorCode: 'REQUEST_TIMEOUT',
          message: 'The request timed out. Please try again.',
        );

      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-timeout-1');
      await provider.completePassengerDropOff(passengerId: 'p-timeout-1');

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-timeout-1',
          repository: fakeRepo,
          provider: provider,
        ),
      );
      await tester.pumpAndSettle();

      // First attempt triggers timeout
      await tester.ensureVisible(
        find.byKey(const Key('confirm_cash_button_p-timeout-1')),
      );
      await tester.tap(find.byKey(const Key('confirm_cash_button_p-timeout-1')));
      await tester.pumpAndSettle();

      expect(fakeRepo.confirmCashCalls, 1);
      final initialKey = fakeRepo.lastConfirmedIdempotencyKey;
      expect(initialKey, isNotNull);
      expect(find.byKey(const Key('cash_error_p-timeout-1')), findsOneWidget);
      expect(
        find.text('The request timed out. Please try again.'),
        findsOneWidget,
      );

      // Verify idempotency key was retained in provider
      expect(
        provider.getCashIdempotencyKeyForPassenger('p-timeout-1'),
        initialKey,
      );

      // Network recovers
      fakeRepo.confirmCashError = null;

      // Safe retry
      await tester.ensureVisible(
        find.byKey(const Key('confirm_cash_button_p-timeout-1')),
      );
      await tester.tap(find.byKey(const Key('confirm_cash_button_p-timeout-1')));
      await tester.pumpAndSettle();

      expect(fakeRepo.confirmCashCalls, 2);
      expect(fakeRepo.lastConfirmedIdempotencyKey, initialKey);
      expect(fakeRepo.confirmCashIdempotencyKeys[0], initialKey);
      expect(fakeRepo.confirmCashIdempotencyKeys[1], initialKey);
      expect(find.byKey(const Key('payment_receipt_p-timeout-1')), findsOneWidget);
    });

    test(
        'duplicate submission prevention: rejects concurrent in-flight or already confirmed calls',
        () async {
      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-dup-1',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-dup-1',
              passengerId: 'p-dup-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        );

      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-dup-1');
      await provider.completePassengerDropOff(passengerId: 'p-dup-1');

      // First call succeeds
      final firstCall =
          await provider.confirmCashCollection(passengerId: 'p-dup-1');
      expect(firstCall, isTrue);
      expect(fakeRepo.confirmCashCalls, 1);

      // Second call when already confirmed must be prevented
      final secondCall =
          await provider.confirmCashCollection(passengerId: 'p-dup-1');
      expect(secondCall, isFalse);
      expect(fakeRepo.confirmCashCalls, 1); // No additional call made
    });

    testWidgets(
        'action visibility: hidden for incomplete passengers, visible after drop-off, replaced by receipt upon confirmation',
        (tester) async {
      tester.view.physicalSize = const Size(2400, 4800);
      addTearDown(tester.view.resetPhysicalSize);

      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-vis-1',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-vis-1',
              passengerId: 'p-vis-1',
              bookingId: 'book-1',
              status: 'BOARDED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
          ],
        );

      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-vis-1');

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-vis-1',
          repository: fakeRepo,
          provider: provider,
        ),
      );
      await tester.pumpAndSettle();

      // 1. While passenger is BOARDED: Complete Drop-Off is visible, cash confirmation is NOT visible
      expect(
        find.byKey(const Key('complete_drop_off_button_p-vis-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('confirm_cash_button_p-vis-1')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('payment_receipt_p-vis-1')),
        findsNothing,
      );

      // 2. Drop off passenger
      await tester.ensureVisible(
        find.byKey(const Key('complete_drop_off_button_p-vis-1')),
      );
      await tester.tap(find.byKey(const Key('complete_drop_off_button_p-vis-1')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('complete_drop_off_button_p-vis-1')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('confirm_cash_button_p-vis-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('payment_receipt_p-vis-1')),
        findsNothing,
      );

      // 3. Confirm cash payment
      await tester.ensureVisible(
        find.byKey(const Key('confirm_cash_button_p-vis-1')),
      );
      await tester.tap(find.byKey(const Key('confirm_cash_button_p-vis-1')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('confirm_cash_button_p-vis-1')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('payment_receipt_p-vis-1')),
        findsOneWidget,
      );
    });

    testWidgets(
        'correct receipt association when multiple passengers are in one trip',
        (tester) async {
      tester.view.physicalSize = const Size(2400, 4800);
      addTearDown(tester.view.resetPhysicalSize);

      final fakeRepo = _FakeTripRepository()
        ..tripToReturn = TripDetailModel(
          tripId: 'trip-multi-p',
          rideGroupId: 'grp-1',
          activeDriverId: 'driver-1',
          status: 'IN_PROGRESS',
          startedAt: DateTime.now(),
          passengers: const [
            TripPassengerModel(
              id: 'tp-1',
              passengerId: 'p-1',
              bookingId: 'book-1',
              status: 'COMPLETED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
            TripPassengerModel(
              id: 'tp-2',
              passengerId: 'p-2',
              bookingId: 'book-2',
              status: 'COMPLETED',
              finalRideFarePaise: 4200,
              waitingChargePaise: 0,
            ),
          ],
        );

      final provider = DriverActiveTripProvider(repository: fakeRepo);
      await provider.loadTrip('trip-multi-p');

      // Drop off both passengers
      await provider.completePassengerDropOff(passengerId: 'p-1');
      await provider.completePassengerDropOff(passengerId: 'p-2');

      await tester.pumpWidget(
        buildTestWidget(
          tripId: 'trip-multi-p',
          repository: fakeRepo,
          provider: provider,
        ),
      );
      await tester.pumpAndSettle();

      // Both show their respective Confirm Cash buttons
      expect(find.byKey(const Key('confirm_cash_button_p-1')), findsOneWidget);
      expect(find.byKey(const Key('confirm_cash_button_p-2')), findsOneWidget);
      expect(find.byKey(const Key('payment_receipt_p-1')), findsNothing);
      expect(find.byKey(const Key('payment_receipt_p-2')), findsNothing);

      // Confirm cash ONLY for passenger 1
      await tester.ensureVisible(
        find.byKey(const Key('confirm_cash_button_p-1')),
      );
      await tester.tap(find.byKey(const Key('confirm_cash_button_p-1')));
      await tester.pumpAndSettle();

      // Passenger 1 has receipt, Passenger 2 still has confirm cash button
      expect(find.byKey(const Key('payment_receipt_p-1')), findsOneWidget);
      expect(find.byKey(const Key('confirm_cash_button_p-1')), findsNothing);
      expect(find.byKey(const Key('payment_receipt_p-2')), findsNothing);
      expect(find.byKey(const Key('confirm_cash_button_p-2')), findsOneWidget);
    });
  });
}
