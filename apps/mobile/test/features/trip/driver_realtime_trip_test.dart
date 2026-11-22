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
  }) =>
      throw UnimplementedError();

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
  });
}
