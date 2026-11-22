import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';
import 'package:lastmile_mobile/core/realtime/models/realtime_event.dart';
import 'package:lastmile_mobile/core/realtime/socket_client.dart';
import 'package:lastmile_mobile/core/realtime/socket_service.dart';
import 'package:lastmile_mobile/features/driver/data/driver_repository.dart';
import 'package:lastmile_mobile/features/driver/services/driver_location_tracker.dart';
import 'package:lastmile_mobile/features/trip/data/trip_repository.dart';
import 'package:lastmile_mobile/features/trip/models/cash_confirmation_model.dart';
import 'package:lastmile_mobile/features/trip/models/passenger_boarding_pass.dart';
import 'package:lastmile_mobile/features/trip/models/trip_detail_model.dart';
import 'package:lastmile_mobile/features/trip/presentation/screens/driver_active_trip_screen.dart';
import 'package:lastmile_mobile/features/trip/state/driver_active_trip_provider.dart';

class _FakeSocketService implements SocketService {
  final _eventController = StreamController<StandardRealtimeEvent>.broadcast();
  final _stateController = StreamController<SocketConnectionState>.broadcast();
  final List<String> subscribedTrips = [];
  final List<String> unsubscribedTrips = [];

  @override
  SocketConnectionState get state => SocketConnectionState.connected;

  @override
  Stream<SocketConnectionState> get stateStream => _stateController.stream;

  @override
  Stream<StandardRealtimeEvent> get eventStream => _eventController.stream;

  @override
  bool get isConnected => true;

  @override
  bool get isDisposed => false;

  @override
  Future<void> connect() async {}

  @override
  void disconnect() {}

  @override
  Future<bool> subscribeTrip(String tripId) async {
    subscribedTrips.add(tripId);
    return true;
  }

  @override
  Future<bool> unsubscribeTrip(String tripId) async {
    unsubscribedTrips.add(tripId);
    return true;
  }

  @override
  Future<bool> subscribeBooking(String bookingId) async => true;

  @override
  Future<bool> unsubscribeBooking(String bookingId) async => true;

  @override
  Future<bool> subscribeGroup(String groupId) async => true;

  @override
  Future<bool> unsubscribeGroup(String groupId) async => true;

  @override
  void onEvent(String eventName, void Function(StandardRealtimeEvent event) handler) {}

  @override
  void offEvent(String eventName, [void Function(StandardRealtimeEvent event)? handler]) {}

  @override
  Future<bool> emitLocationUpdate(DriverLocationUpdatePayload payload) async =>
      true;

  @override
  void dispose() {
    _eventController.close();
    _stateController.close();
  }

  void emitEvent(StandardRealtimeEvent event) {
    _eventController.add(event);
  }
}

StandardRealtimeEvent<T> _testEvent<T>({
  required String event,
  required T data,
  String entityType = 'TRIP',
  String entityId = 'trip-42',
  int entityVersion = 1,
}) {
  return StandardRealtimeEvent<T>(
    eventId: 'evt-1',
    event: event,
    entityType: entityType,
    entityId: entityId,
    entityVersion: entityVersion,
    occurredAt: DateTime.now(),
    data: data,
  );
}

class _FakeLocationTracker implements DriverLocationTracker {
  String? currentActiveTripId;
  final List<String?> tripIdTransitions = [];

  @override
  bool get isTracking => true;

  @override
  void setActiveTripId(String? tripId) {
    currentActiveTripId = tripId;
    tripIdTransitions.add(tripId);
  }

  @override
  void startTracking({required DriverRepository repository}) {}

  @override
  void stopTracking() {}

  @override
  void updateAppLifecycle(AppLifecycleState state) {}

  @override
  Future<void> retryPermission() async {}

  @override
  void dispose() {}
}

class _FakeTripRepository implements TripRepository {
  TripDetailModel? tripToReturn;

  @override
  Future<TripDetailModel> getTripDetails(String tripId) async {
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
              bookingId: 'book-1111',
              status: 'ASSIGNED',
              finalRideFarePaise: 3800,
              waitingChargePaise: 0,
            ),
            TripPassengerModel(
              id: 'tp-2',
              passengerId: 'p-2',
              bookingId: 'book-2222',
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
  }) =>
      throw UnimplementedError();

  @override
  Future<StartTripResponse> startTrip({
    required String tripId,
    required String idempotencyKey,
  }) =>
      throw UnimplementedError();

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
  }) =>
      throw UnimplementedError();

  @override
  Future<CashConfirmationModel> confirmCash({
    required String tripId,
    required String tripPassengerId,
    required int amountCollectedPaise,
    required String idempotencyKey,
  }) =>
      throw UnimplementedError();

  @override
  Future<PassengerBoardingPass> getPassengerBoardingPass(String bookingId) =>
      throw UnimplementedError();
}

void main() {
  late _FakeSocketService fakeSocket;
  late _FakeLocationTracker fakeTracker;
  late _FakeTripRepository fakeTripRepo;

  setUp(() {
    fakeSocket = _FakeSocketService();
    fakeTracker = _FakeLocationTracker();
    fakeTripRepo = _FakeTripRepository();
  });

  tearDown(() {
    fakeSocket.dispose();
  });

  Widget buildTestWidget({
    required String tripId,
    DriverActiveTripProvider? provider,
  }) {
    return MultiProvider(
      providers: [
        Provider<SocketService>.value(value: fakeSocket),
        Provider<DriverLocationTracker>.value(value: fakeTracker),
        Provider<TripRepository>.value(value: fakeTripRepo),
      ],
      child: MaterialApp(
        home: DriverActiveTripScreen(
          tripId: tripId,
          repository: fakeTripRepo,
          provider: provider,
        ),
      ),
    );
  }

  group('DriverActiveTripScreen Realtime Integration', () {
    testWidgets(
        'subscribes to trip room and sets active trip on tracker on mount, unsubscribes and resets on unmount',
        (tester) async {
      await tester.pumpWidget(buildTestWidget(tripId: 'trip-42'));
      await tester.pumpAndSettle();

      expect(fakeSocket.subscribedTrips, contains('trip-42'));
      expect(fakeTracker.currentActiveTripId, 'trip-42');

      // Unmount screen
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('Unmounted'))),
      );
      await tester.pumpAndSettle();

      expect(fakeSocket.unsubscribedTrips, contains('trip-42'));
      expect(fakeTracker.currentActiveTripId, isNull);
    });

    testWidgets('passenger.boarded event updates passenger status to BOARDED',
        (tester) async {
      await tester.pumpWidget(buildTestWidget(tripId: 'trip-42'));
      await tester.pumpAndSettle();

      // Initially ASSIGNED
      expect(find.byKey(const Key('passenger_status_p-1')), findsOneWidget);
      expect(find.text('ASSIGNED'), findsNWidgets(2));

      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'passenger.boarded',
          data: {
            'tripId': 'trip-42',
            'passengerId': 'p-1',
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('BOARDED'), findsOneWidget);
    });

    testWidgets('passenger.dropped_off event updates passenger status to COMPLETED',
        (tester) async {
      await tester.pumpWidget(buildTestWidget(tripId: 'trip-42'));
      await tester.pumpAndSettle();

      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'passenger.dropped_off',
          data: {
            'tripId': 'trip-42',
            'passengerId': 'p-1',
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('COMPLETED'), findsOneWidget);
    });

    testWidgets('passenger.no_show event updates passenger status to NO_SHOW',
        (tester) async {
      await tester.pumpWidget(buildTestWidget(tripId: 'trip-42'));
      await tester.pumpAndSettle();

      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'passenger.no_show',
          data: {
            'tripId': 'trip-42',
            'passengerId': 'p-2',
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('NO_SHOW'), findsOneWidget);
    });

    testWidgets('trip.completed event marks trip completed and clears active trip on tracker',
        (tester) async {
      await tester.pumpWidget(buildTestWidget(tripId: 'trip-42'));
      await tester.pumpAndSettle();

      expect(fakeTracker.currentActiveTripId, 'trip-42');

      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'trip.completed',
          data: {
            'tripId': 'trip-42',
            'status': 'COMPLETED',
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('trip_completed_status_indicator')), findsOneWidget);
      expect(fakeTracker.currentActiveTripId, isNull);
    });

    testWidgets(
        'payment.confirmed socket event marks payment confirmed without synthesizing full receipt',
        (tester) async {
      final provider = DriverActiveTripProvider();
      await tester.pumpWidget(
        buildTestWidget(tripId: 'trip-42', provider: provider),
      );
      await tester.pumpAndSettle();

      // Complete passenger drop-off via provider to populate authoritative drop-off breakdown
      final dropOffSuccess = await provider.completePassengerDropOff(
        passengerId: 'p-1',
        repository: fakeTripRepo,
      );
      expect(dropOffSuccess, isTrue);
      await tester.pumpAndSettle();

      // Button is initially visible, status banner is not
      expect(find.byKey(const Key('confirm_cash_button_p-1')), findsOneWidget);
      expect(find.byKey(const Key('payment_status_confirmed_p-1')), findsNothing);
      expect(provider.isCashCollected('p-1'), isFalse);
      expect(provider.confirmedCashReceipts['p-1'], isNull);

      // Emit Stage 10A payment.confirmed event
      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'payment.confirmed',
          data: {
            'cashCollectionId': 'cc-999',
            'tripId': 'trip-42',
            'driverId': 'driver-1',
            'tripPassengerId': 'tp-1',
            'bookingId': 'book-1111',
            'passengerId': 'p-1',
            'totalCashCollectedPaise': 3800,
            'rideFarePaise': 3800,
            'waitingChargePaise': 0,
            'feeSurchargePaise': 0,
            'paymentStatus': 'PAID',
          },
        ),
      );
      await tester.pumpAndSettle();

      // Confirm button is hidden, confirmed card is rendered
      expect(find.byKey(const Key('confirm_cash_button_p-1')), findsNothing);
      expect(find.byKey(const Key('payment_status_confirmed_p-1')), findsOneWidget);
      expect(provider.isCashCollected('p-1'), isTrue);
      // Confirmed cash receipts map contains ONLY full receipts, NOT partial socket models
      expect(provider.confirmedCashReceipts['p-1'], isNull);
    });

    test('CashConfirmationModel.fromJson throws FormatException when passed partial Stage 10A socket payload', () {
      final partialSocketPayload = {
        'cashCollectionId': 'cc-999',
        'tripId': 'trip-42',
        'driverId': 'driver-1',
        'tripPassengerId': 'tp-1',
        'bookingId': 'book-1111',
        'totalCashCollectedPaise': 3800,
        'rideFarePaise': 3800,
        'waitingChargePaise': 0,
        'feeSurchargePaise': 0,
        'paymentStatus': 'PAID',
      };

      expect(
        () => CashConfirmationModel.fromJson(partialSocketPayload),
        throwsFormatException,
      );
    });

    test('full receipt from REST confirmCash is preserved when payment.confirmed event arrives', () {
      final provider = DriverActiveTripProvider();

      // Populate full receipt as returned by REST confirmCash endpoint
      final fullReceipt = CashConfirmationModel(
        collectionId: 'cc-999',
        tripId: 'trip-42',
        tripPassengerId: 'tp-1',
        driverId: 'driver-1',
        totalCashCollectedPaise: 3800,
        totalCashCollected: '₹38.00',
        rideFarePaise: 3800,
        rideFare: '₹38.00',
        waitingChargePaise: 0,
        waitingCharge: '₹0.00',
        surchargeFeesPaise: 0,
        surchargeFees: '₹0.00',
        collectedFeeIds: const [],
        paymentStatus: 'PAID',
        confirmedAt: DateTime.parse('2026-11-22T10:00:00.000Z'),
        paymentAllocations: const [
          PaymentAllocationModel(
            id: 'alloc-1',
            obligationType: 'RIDE_FARE',
            obligationEntityId: 'tp-1',
            allocatedAmountPaise: 3800,
            allocatedAmount: '₹38.00',
          ),
        ],
      );

      provider.recordCashReceipt('p-1', fullReceipt);
      expect(provider.isCashCollected('p-1'), isTrue);
      expect(provider.confirmedCashReceipts['p-1'], equals(fullReceipt));

      // Now incoming socket event arrives
      provider.onPaymentConfirmed({
        'cashCollectionId': 'cc-999',
        'tripId': 'trip-42',
        'passengerId': 'p-1',
      });

      // Full receipt is still intact and not overwritten with null or partial data
      expect(provider.isCashCollected('p-1'), isTrue);
      expect(provider.confirmedCashReceipts['p-1'], equals(fullReceipt));
      expect(provider.confirmedCashReceipts['p-1']!.totalCashCollected, '₹38.00');
      expect(provider.confirmedCashReceipts['p-1']!.paymentAllocations.length, 1);
    });
  });
}
