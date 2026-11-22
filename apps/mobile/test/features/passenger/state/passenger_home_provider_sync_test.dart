import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/realtime/models/sync_models.dart';
import 'package:lastmile_mobile/features/booking/data/booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/passenger/state/passenger_home_provider.dart';

class _FakeBookingRepository implements BookingRepository {
  int getActiveBookingCalls = 0;
  BookingResponse? bookingToReturn;
  Exception? errorToThrow;

  @override
  Future<BookingResponse?> getActiveBooking() async {
    getActiveBookingCalls++;
    if (errorToThrow != null) throw errorToThrow!;
    return bookingToReturn;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late PassengerHomeProvider provider;
  late _FakeBookingRepository repository;

  final sampleActiveTrip = const SyncPassengerActiveTrip(
    id: 'trip-1',
    status: 'IN_PROGRESS',
    tripVersion: 2,
    activeDriverId: 'driver-1',
    farePaise: 3500,
  );

  final sampleFees = [
    SyncOutstandingFee(
      id: 'fee-1',
      feeAmountPaise: 3000,
      reason: 'Late cancellation',
      assessedAt: DateTime.parse('2026-11-22T10:00:00.000Z'),
    ),
  ];

  final sampleSyncBooking = SyncActiveBooking(
    id: 'booking-1',
    status: 'CONFIRMED',
    passengerId: 'p-1',
    pickupPointId: 'zone-1',
    fareQuotePaise: 3500,
    createdAt: DateTime.parse('2026-11-22T10:00:00.000Z'),
    updatedAt: DateTime.parse('2026-11-22T10:05:00.000Z'),
    entityVersion: 2,
  );

  final authoritativeBookingResponse = BookingResponse(
    bookingId: 'booking-1',
    status: 'CONFIRMED',
    passengerId: 'p-1',
    pickupPointId: 'zone-1',
    agreedFareCeiling: '35.00',
    maxWaitDeadline: DateTime.parse('2026-11-22T10:15:00.000Z'),
    createdAt: DateTime.parse('2026-11-22T10:00:00.000Z'),
    updatedAt: DateTime.parse('2026-11-22T10:05:00.000Z'),
  );

  setUp(() {
    provider = PassengerHomeProvider();
    repository = _FakeBookingRepository();
    repository.bookingToReturn = authoritativeBookingResponse;
  });

  tearDown(() {
    provider.dispose();
  });

  group('PassengerHomeProvider Sync Reconciliation', () {
    test('non-null sync activeBooking triggers authoritative REST refresh when local booking is null',
        () async {
      expect(provider.activeBooking, isNull);
      expect(repository.getActiveBookingCalls, 0);

      final state = SyncPassengerState(
        activeBooking: sampleSyncBooking,
        activeTrip: sampleActiveTrip,
        outstandingCancellationFees: sampleFees,
      );

      provider.handleSyncResponse(state, repository: repository);
      await Future<void>.delayed(Duration.zero);

      expect(repository.getActiveBookingCalls, 1);
      expect(provider.activeBooking?.bookingId, 'booking-1');
      expect(provider.activeBooking?.status, 'CONFIRMED');
      expect(provider.activeTrip?.id, 'trip-1');
      expect(provider.outstandingFees.length, 1);
    });

    test('non-null sync activeBooking triggers REST refresh if status changed',
        () async {
      provider.updateActiveBooking(authoritativeBookingResponse);
      expect(provider.activeBooking?.status, 'CONFIRMED');

      final updatedSyncBooking = SyncActiveBooking(
        id: 'booking-1',
        status: 'IN_PROGRESS',
        passengerId: 'p-1',
        pickupPointId: 'zone-1',
        fareQuotePaise: 3500,
        createdAt: DateTime.parse('2026-11-22T10:00:00.000Z'),
        updatedAt: DateTime.parse('2026-11-22T10:10:00.000Z'),
        entityVersion: 3,
      );

      repository.bookingToReturn = BookingResponse(
        bookingId: 'booking-1',
        status: 'IN_PROGRESS',
        passengerId: 'p-1',
        pickupPointId: 'zone-1',
        agreedFareCeiling: '35.00',
        maxWaitDeadline: DateTime.parse('2026-11-22T10:15:00.000Z'),
        createdAt: DateTime.parse('2026-11-22T10:00:00.000Z'),
      );

      final state = SyncPassengerState(
        activeBooking: updatedSyncBooking,
        activeTrip: sampleActiveTrip,
      );

      provider.handleSyncResponse(state, repository: repository);
      await Future<void>.delayed(Duration.zero);

      expect(repository.getActiveBookingCalls, 1);
      expect(provider.activeBooking?.status, 'IN_PROGRESS');
    });

    test('no unnecessary refresh when the authoritative booking snapshot is unchanged',
        () {
      provider.updateActiveBooking(authoritativeBookingResponse);
      expect(provider.activeBooking, isNotNull);
      expect(repository.getActiveBookingCalls, 0);

      final state = SyncPassengerState(
        activeBooking: sampleSyncBooking,
        activeTrip: sampleActiveTrip,
        outstandingCancellationFees: sampleFees,
      );

      provider.handleSyncResponse(state, repository: repository);

      // Unchanged id, status, and updatedAt -> no repository refresh triggered
      expect(repository.getActiveBookingCalls, 0);
      expect(provider.activeBooking?.bookingId, 'booking-1');
      expect(provider.activeBooking?.status, 'CONFIRMED');
      expect(provider.activeTrip?.id, 'trip-1');
      expect(provider.outstandingFees.length, 1);
    });

    test('existing booking with unchanged ID/status triggers REST refresh when server updatedAt is newer',
        () async {
      provider.updateActiveBooking(authoritativeBookingResponse);
      expect(provider.activeBooking?.status, 'CONFIRMED');
      expect(repository.getActiveBookingCalls, 0);

      final newerSyncBooking = SyncActiveBooking(
        id: 'booking-1',
        status: 'CONFIRMED',
        passengerId: 'p-1',
        pickupPointId: 'zone-1',
        fareQuotePaise: 3500,
        createdAt: DateTime.parse('2026-11-22T10:00:00.000Z'),
        updatedAt: DateTime.parse('2026-11-22T10:15:00.000Z'),
        entityVersion: 2,
      );

      repository.bookingToReturn = BookingResponse(
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        passengerId: 'p-1',
        pickupPointId: 'zone-1',
        agreedFareCeiling: '35.00',
        maxWaitDeadline: DateTime.parse('2026-11-22T10:20:00.000Z'),
        createdAt: DateTime.parse('2026-11-22T10:00:00.000Z'),
        updatedAt: DateTime.parse('2026-11-22T10:15:00.000Z'),
      );

      final state = SyncPassengerState(
        activeBooking: newerSyncBooking,
        activeTrip: sampleActiveTrip,
      );

      provider.handleSyncResponse(state, repository: repository);
      await Future<void>.delayed(Duration.zero);

      expect(repository.getActiveBookingCalls, 1);
      expect(provider.activeBooking?.updatedAt, DateTime.parse('2026-11-22T10:15:00.000Z'));
    });

    test('no active booking but outstanding cancellation fees present reconciles fee list without clearing fees',
        () {
      // Start with an active booking and no fees
      provider.updateActiveBooking(authoritativeBookingResponse);
      expect(provider.activeBooking, isNotNull);
      expect(provider.outstandingFees, isEmpty);

      final stateWithFees = SyncPassengerState(
        activeBooking: null,
        activeTrip: null,
        outstandingCancellationFees: sampleFees,
      );

      provider.handleSyncResponse(stateWithFees, repository: repository);

      // Active booking and trip are cleared, but outstanding fees are preserved & reconciled
      expect(provider.activeBooking, isNull);
      expect(provider.activeTrip, isNull);
      expect(provider.outstandingFees.length, 1);
      expect(provider.outstandingFees.first.id, 'fee-1');
      expect(provider.outstandingFees.first.feeAmountPaise, 3000);
      expect(repository.getActiveBookingCalls, 0);
    });

    test('non-null sync does not fabricate incomplete booking when repository is omitted',
        () {
      expect(provider.activeBooking, isNull);

      final state = SyncPassengerState(
        activeBooking: sampleSyncBooking,
        activeTrip: sampleActiveTrip,
      );

      provider.handleSyncResponse(state, repository: null);

      expect(provider.activeBooking, isNull);
      expect(provider.activeTrip?.id, 'trip-1');
    });

    test('null sync activeBooking with empty fees clears local activeBooking, activeTrip, and fees',
        () {
      provider.updateActiveBooking(authoritativeBookingResponse);
      expect(provider.activeBooking, isNotNull);

      final emptyState = const SyncPassengerState(
        activeBooking: null,
        activeGroup: null,
        activeTrip: null,
        outstandingCancellationFees: [],
      );

      provider.handleSyncResponse(emptyState, repository: repository);

      expect(provider.activeBooking, isNull);
      expect(provider.activeTrip, isNull);
      expect(provider.outstandingFees, isEmpty);
      expect(repository.getActiveBookingCalls, 0);
    });
  });
}
