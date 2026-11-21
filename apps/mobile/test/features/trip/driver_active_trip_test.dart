import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/trip/data/trip_repository.dart';
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
}
