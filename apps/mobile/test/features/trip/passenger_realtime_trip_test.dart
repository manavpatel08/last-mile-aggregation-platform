import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';
import 'package:lastmile_mobile/core/realtime/models/realtime_event.dart';
import 'package:lastmile_mobile/core/realtime/socket_client.dart';
import 'package:lastmile_mobile/core/realtime/socket_service.dart';
import 'package:lastmile_mobile/features/booking/data/booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_details.dart';
import 'package:lastmile_mobile/features/trip/data/trip_repository.dart';
import 'package:lastmile_mobile/features/trip/models/cash_confirmation_model.dart';
import 'package:lastmile_mobile/features/trip/models/passenger_boarding_pass.dart';
import 'package:lastmile_mobile/features/trip/models/trip_detail_model.dart';
import 'package:lastmile_mobile/features/trip/presentation/screens/passenger_active_trip_screen.dart';
import 'package:lastmile_mobile/features/trip/state/passenger_active_trip_provider.dart';

class _FakeSocketService implements SocketService {
  final _eventController = StreamController<StandardRealtimeEvent>.broadcast();
  final _stateController = StreamController<SocketConnectionState>.broadcast();
  final List<String> subscribedBookings = [];
  final List<String> unsubscribedBookings = [];
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
  Future<bool> subscribeBooking(String bookingId) async {
    subscribedBookings.add(bookingId);
    return true;
  }

  @override
  Future<bool> unsubscribeBooking(String bookingId) async {
    unsubscribedBookings.add(bookingId);
    return true;
  }

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
  String entityId = 'trip-100',
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

class _FakeTripRepository implements TripRepository {
  PassengerBoardingPass? passToReturn;

  @override
  Future<PassengerBoardingPass> getPassengerBoardingPass(
      String bookingId) async {
    return passToReturn ??
        PassengerBoardingPass(
          bookingId: bookingId,
          passengerId: 'pass-1',
          tripId: 'trip-100',
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
  Future<TripDetailModel> getTripDetails(String tripId) =>
      throw UnimplementedError();

  @override
  Future<ArrivePickupResponse> arriveAtPickup({
    required String tripId,
    required String idempotencyKey,
  }) =>
      throw UnimplementedError();

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
}

class _FakeBookingRepository implements BookingRepository {
  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async {
    return BookingDetails(
      bookingId: bookingId,
      status: 'CONFIRMED',
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
  late _FakeSocketService fakeSocket;
  late _FakeTripRepository fakeTripRepo;
  late _FakeBookingRepository fakeBookingRepo;

  setUp(() {
    fakeSocket = _FakeSocketService();
    fakeTripRepo = _FakeTripRepository();
    fakeBookingRepo = _FakeBookingRepository();
  });

  tearDown(() {
    fakeSocket.dispose();
  });

  Widget buildTestWidget({
    required String bookingId,
    PassengerActiveTripProvider? provider,
  }) {
    return MultiProvider(
      providers: [
        Provider<SocketService>.value(value: fakeSocket),
        Provider<BookingRepository>.value(value: fakeBookingRepo),
        Provider<TripRepository>.value(value: fakeTripRepo),
      ],
      child: MaterialApp(
        home: PassengerActiveTripScreen(
          bookingId: bookingId,
          repository: fakeTripRepo,
          bookingRepository: fakeBookingRepo,
          provider: provider,
        ),
      ),
    );
  }

  group('PassengerActiveTripScreen Realtime Integration', () {
    testWidgets('subscribes to booking room on mount and unsubscribes on unmount',
        (tester) async {
      await tester.pumpWidget(
        buildTestWidget(bookingId: 'book-1234'),
      );
      await tester.pumpAndSettle();

      expect(fakeSocket.subscribedBookings, contains('book-1234'));

      // Unmount the screen
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('Unmounted'))),
      );
      await tester.pumpAndSettle();

      expect(fakeSocket.unsubscribedBookings, contains('book-1234'));
    });

    testWidgets('driver.location.updated event updates live location card',
        (tester) async {
      await tester.pumpWidget(
        buildTestWidget(bookingId: 'book-1234'),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('live_driver_location_card')), findsNothing);

      // Emit driver location update
      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'driver.location.updated',
          data: {
            'driverId': 'driver-1',
            'latitude': 23.1550,
            'longitude': 72.6650,
            'heading': 180.0,
            'speed': 35.0,
            'recordedAt': DateTime.now().toIso8601String(),
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('live_driver_location_card')),
        findsOneWidget,
      );
      expect(find.textContaining('Lat: 23.1550, Lon: 72.6650'), findsOneWidget);
    });

    testWidgets('driver.arrived event updates driver arrival status',
        (tester) async {
      await tester.pumpWidget(
        buildTestWidget(bookingId: 'book-1234'),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver Arrived at Hub'), findsNothing);

      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'driver.arrived',
          data: {
            'tripId': 'trip-100',
            'driverArrivedAt': DateTime.now().toIso8601String(),
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver Arrived at Hub'), findsOneWidget);
    });

    testWidgets('passenger.boarded event marks boarding pass as boarded',
        (tester) async {
      await tester.pumpWidget(
        buildTestWidget(bookingId: 'book-1234'),
      );
      await tester.pumpAndSettle();

      expect(find.text('Boarded — Ride Starting Soon'), findsNothing);

      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'passenger.boarded',
          data: {
            'tripId': 'trip-100',
            'passengerId': 'pass-1',
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Boarded — Ride Starting Soon'), findsOneWidget);
    });

    testWidgets('payment.confirmed event displays payment confirmation banner',
        (tester) async {
      await tester.pumpWidget(
        buildTestWidget(bookingId: 'book-1234'),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('payment_confirmed_banner')),
        findsNothing,
      );

      fakeSocket.emitEvent(
        _testEvent<Map<String, dynamic>>(
          event: 'payment.confirmed',
          data: {
            'tripId': 'trip-100',
            'bookingId': 'book-1234',
            'totalCashCollected': '45.00',
            'paymentStatus': 'PAID',
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('payment_confirmed_banner')),
        findsOneWidget,
      );
      expect(find.text('Cash Payment Confirmed by Driver'), findsOneWidget);
    });
  });
}
