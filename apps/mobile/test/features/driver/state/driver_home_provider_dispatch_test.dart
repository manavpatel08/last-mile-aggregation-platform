import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/driver/models/accept_offer_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_dispatch_offer.dart';
import 'package:lastmile_mobile/features/driver/models/driver_status_response.dart';
import 'package:lastmile_mobile/features/driver/presentation/models/dispatch_offer_item.dart';
import 'package:lastmile_mobile/features/driver/services/driver_location_tracker.dart';
import 'package:lastmile_mobile/features/driver/state/driver_home_provider.dart';

import '../../../helpers/test_fakes.dart';

void main() {
  const approvedOnlineStatus = DriverStatusResponse(
    id: 'dp-1',
    verificationStatus: 'APPROVED',
    operationalStatus: 'AVAILABLE',
    isOnline: true,
    vehiclesCount: 1,
  );

  const approvedOfflineStatus = DriverStatusResponse(
    id: 'dp-1',
    verificationStatus: 'APPROVED',
    operationalStatus: 'OFFLINE',
    isOnline: false,
    vehiclesCount: 1,
  );

  final sampleOffer1 = DriverDispatchOffer(
    offerId: 'off-101',
    dispatchAttemptId: 'att-101',
    rideGroupId: 'grp-101',
    groupVersion: 1,
    pickupPoint: const DriverPickupPoint(id: 'pnt-1', name: 'PDEU Gate 1'),
    passengerCount: 2,
    totalEstimatedFare: '32.00',
    totalDistanceMeters: 1800,
    totalDurationSec: 240,
    offeredAt: DateTime.now(),
    expiresAt: DateTime.now().add(const Duration(seconds: 20)),
    remainingSeconds: 20,
  );

  final sampleOffer2 = DriverDispatchOffer(
    offerId: 'off-102',
    dispatchAttemptId: 'att-102',
    rideGroupId: 'grp-102',
    groupVersion: 1,
    pickupPoint: const DriverPickupPoint(id: 'pnt-2', name: 'High-Rise Gate'),
    passengerCount: 3,
    totalEstimatedFare: '48.00',
    totalDistanceMeters: 2400,
    totalDurationSec: 320,
    offeredAt: DateTime.now(),
    expiresAt: DateTime.now().add(const Duration(seconds: 20)),
    remainingSeconds: 20,
  );

  group('DriverHomeProvider Availability & Dispatch Offers', () {
    late FakeDriverRepository fakeRepo;
    late FakeDriverLocationTracker fakeTracker;
    late DriverHomeProvider provider;

    setUp(() {
      fakeRepo = FakeDriverRepository(statusResponse: approvedOfflineStatus);
      fakeTracker = FakeDriverLocationTracker();
      provider = DriverHomeProvider(
        driverRepository: fakeRepo,
        locationTracker: fakeTracker,
      );
    });

    test('initial state has disconnected offers and no tracking', () {
      expect(provider.inboxState, DispatchInboxState.disconnected);
      expect(provider.offers, isEmpty);
      expect(provider.isUpdatingStatus, isFalse);
      expect(fakeTracker.isTracking, isFalse);
    });

    test('setOnline toggles online status and starts tracking and loads offers', () async {
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');
      expect(provider.isOnline, isFalse);

      fakeRepo.updateStatusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];

      final success = await provider.setOnline(true);

      expect(success, isTrue);
      expect(provider.isOnline, isTrue);
      expect(provider.operationalStatus, 'AVAILABLE');
      expect(fakeRepo.updateStatusCallCount, 1);
      expect(fakeRepo.lastUpdateStatusIsOnline, isTrue);
      expect(fakeTracker.isTracking, isTrue);

      expect(provider.inboxState, DispatchInboxState.ready);
      expect(provider.offers.length, 1);
      expect(provider.offers[0].id, 'off-101');
    });

    test('setOnline handles 409 Conflict without altering confirmed online state', () async {
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      fakeRepo.shouldThrowOnUpdateStatus = true;
      fakeRepo.updateStatusException = const ApiException(
        statusCode: 409,
        errorCode: 'CONFLICT',
        message: 'Cannot go offline while driver has an active trip',
      );

      final success = await provider.setOnline(false);

      expect(success, isFalse);
      expect(provider.statusUpdateError, 'Cannot go offline while driver has an active trip');
      expect(provider.isOnline, isFalse); // Stays at server-confirmed state
    });

    test('setOnline prevents duplicate requests while in flight', () async {
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');
      fakeRepo.updateStatusResponse = approvedOnlineStatus;

      final f1 = provider.setOnline(true);
      final f2 = provider.setOnline(true); // Should be ignored by guard

      final results = await Future.wait([f1, f2]);
      expect(results[0], isTrue);
      expect(results[1], isFalse);
      expect(fakeRepo.updateStatusCallCount, 1);
    });

    test('non-approved driver cannot call setOnline', () async {
      await provider.loadDashboard(verificationStatus: 'PENDING', userId: 'user-pending');

      final success = await provider.setOnline(true);
      expect(success, isFalse);
      expect(provider.statusUpdateError, contains('not approved'));
      expect(fakeRepo.updateStatusCallCount, 0);
    });

    test('loadOffers sets empty inbox when backend returns empty array', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = const [];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      expect(provider.inboxState, DispatchInboxState.empty);
      expect(provider.offers, isEmpty);
    });

    test('loadOffers sets error inbox when backend throws ApiException', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.shouldThrowOnOffers = true;
      fakeRepo.offersException = const ApiException(
        statusCode: 500,
        errorCode: 'SERVER_ERROR',
        message: 'Failed to retrieve dispatch offers',
      );

      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      expect(provider.inboxState, DispatchInboxState.error);
      expect(provider.offersError, 'Failed to retrieve dispatch offers');
    });

    test('acceptOffer sends unique Idempotency-Key and updates driver status and offers', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1, sampleOffer2];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      expect(provider.offers.length, 2);

      fakeRepo.acceptOfferResponse = const AcceptOfferResponse(
        assignmentId: 'asgn-1',
        tripId: 'trip-1',
        rideGroupId: 'grp-101',
        passengerCount: 2,
        totalEstimatedFare: '32.00',
        navigationRoute: NavigationRouteData(geometry: {}, stops: []),
      );

      // Subsequent fetch after accept returns remaining offer
      fakeRepo.offersResponse = [sampleOffer2];

      final success = await provider.acceptOffer('off-101');

      expect(success, isTrue);
      expect(fakeRepo.acceptOfferCallCount, 1);
      expect(fakeRepo.lastAcceptedOfferId, 'off-101');
      expect(fakeRepo.lastAcceptedIdempotencyKey, isNotNull);
      expect(fakeRepo.lastAcceptedIdempotencyKey, isNotEmpty);

      expect(provider.operationalStatus, 'RESERVED');
      expect(provider.offers.length, 1);
      expect(provider.offers[0].id, 'off-102');
    });

    test('acceptOffer handles OFFER_EXPIRED conflict and reconciles offers', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      fakeRepo.shouldThrowOnAcceptOffer = true;
      fakeRepo.acceptOfferException = const ApiException(
        statusCode: 409,
        errorCode: 'OFFER_EXPIRED',
        message: 'Offer has expired',
      );

      // Reconciled fetch returns empty
      fakeRepo.shouldThrowOnOffers = false;
      fakeRepo.offersResponse = const [];

      final success = await provider.acceptOffer('off-101');

      expect(success, isFalse);
      expect(provider.offersError, 'Offer has expired');
      expect(provider.inboxState, DispatchInboxState.empty);
    });

    test('rejectOffer sends Idempotency-Key with reason and removes offer from inbox', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1, sampleOffer2];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      final success = await provider.rejectOffer('off-101', reason: 'Heading to lunch');

      expect(success, isTrue);
      expect(fakeRepo.rejectOfferCallCount, 1);
      expect(fakeRepo.lastRejectedOfferId, 'off-101');
      expect(fakeRepo.lastRejectedReason, 'Heading to lunch');
      expect(fakeRepo.lastRejectedIdempotencyKey, isNotNull);

      expect(provider.offers.length, 1);
      expect(provider.offers[0].id, 'off-102');
    });

    test('rejectOffer falls back to empty state when all offers rejected', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      final success = await provider.rejectOffer('off-101');

      expect(success, isTrue);
      expect(provider.offers, isEmpty);
      expect(provider.inboxState, DispatchInboxState.empty);
    });

    test('clear stops location tracking, resets generation, and cleans up offers and availability', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      expect(fakeTracker.isTracking, isTrue);
      expect(provider.offers, isNotEmpty);

      final prevGen = provider.requestGeneration;
      provider.clear();

      expect(provider.requestGeneration, greaterThan(prevGen));
      expect(fakeTracker.isTracking, isFalse);
      expect(provider.offers, isEmpty);
      expect(provider.inboxState, DispatchInboxState.disconnected);
      expect(provider.currentUserId, isNull);
    });
  });
}
