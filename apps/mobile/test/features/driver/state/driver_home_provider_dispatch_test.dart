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

  const approvedReservedStatus = DriverStatusResponse(
    id: 'dp-1',
    verificationStatus: 'APPROVED',
    operationalStatus: 'RESERVED',
    isOnline: true,
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

    tearDown(() {
      provider.dispose();
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

    test('acceptOffer sends unique Idempotency-Key and updates driver status and offers without stuck flags', () async {
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

      // Status changes to RESERVED and subsequent fetch after accept returns remaining offer
      fakeRepo.statusResponse = approvedReservedStatus;
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
      // Verifies flags are cleanly reset and not permanently stuck
      expect(provider.isProcessingAction, isFalse);
      expect(provider.isRefreshing, isFalse);
      expect(provider.isLoading, isFalse);
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
      expect(provider.isProcessingAction, isFalse);
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
      expect(provider.isProcessingAction, isFalse);
    });

    test('rejectOffer falls back to empty state when all offers rejected', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      final success = await provider.rejectOffer('off-101');

      expect(success, isTrue);
      expect(provider.offers, isEmpty);
      expect(provider.inboxState, DispatchInboxState.empty);
      expect(provider.isProcessingAction, isFalse);
    });

    test('clear stops location tracking, resets generation, and cleans up offers and availability', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      expect(fakeTracker.isTracking, isTrue);
      expect(provider.offers, isNotEmpty);

      final prevGen = provider.sessionGeneration;
      provider.clear();

      expect(provider.sessionGeneration, greaterThan(prevGen));
      expect(fakeTracker.isTracking, isFalse);
      expect(provider.offers, isEmpty);
      expect(provider.inboxState, DispatchInboxState.disconnected);
      expect(provider.currentUserId, isNull);
    });

    test('concurrency: refresh during availability mutation completes both cleanly without invalidation', () async {
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');
      fakeRepo.updateStatusResponse = approvedOnlineStatus;

      // Start setOnline and refreshDashboard concurrently
      final f1 = provider.setOnline(true);
      final f2 = provider.refreshDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      await Future.wait([f1, f2]);

      expect(provider.isOnline, isTrue);
      expect(provider.isUpdatingStatus, isFalse);
      expect(provider.isRefreshing, isFalse);
    });

    test('concurrency: logout/account switch during in-flight operations resets all flags and drops responses', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      // Start in-flight accept
      final acceptFuture = provider.acceptOffer('off-101');

      // Abrupt logout during in-flight accept
      provider.clear();

      expect(provider.isProcessingAction, isFalse);
      expect(provider.currentUserId, isNull);
      expect(provider.offers, isEmpty);

      // Original future completes with false because session was invalidated
      final result = await acceptFuture;
      expect(result, isFalse);
      expect(provider.isProcessingAction, isFalse);
    });

    test('countdown: ticks remaining seconds and transitions to expired at 0', () async {
      final shortOffer = DriverDispatchOffer(
        offerId: 'off-short',
        dispatchAttemptId: 'att-1',
        rideGroupId: 'grp-1',
        groupVersion: 1,
        pickupPoint: const DriverPickupPoint(id: 'pnt-1', name: 'PDEU Gate 1'),
        passengerCount: 2,
        totalEstimatedFare: '32.00',
        totalDistanceMeters: 1000,
        totalDurationSec: 120,
        offeredAt: DateTime.now(),
        expiresAt: DateTime.now().add(const Duration(seconds: 2)),
        remainingSeconds: 2,
      );

      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [shortOffer];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      expect(provider.offers.first.remainingSeconds, 2);
      expect(provider.offers.first.isExpired, isFalse);

      // Wait 1.1s for first tick
      await Future<void>.delayed(const Duration(milliseconds: 1100));
      expect(provider.offers.first.remainingSeconds, 1);
      expect(provider.offers.first.isExpired, isFalse);

      // Wait another 1.1s for second tick (reaches 0)
      await Future<void>.delayed(const Duration(milliseconds: 1100));
      expect(provider.offers.first.remainingSeconds, 0);
      expect(provider.offers.first.isExpired, isTrue);
      expect(provider.offers.first.status, DispatchOfferStatus.expired);

      // Expired offer cannot be accepted
      final success = await provider.acceptOffer('off-short');
      expect(success, isFalse);
      expect(fakeRepo.acceptOfferCallCount, 0);
    });

    test('ambiguous accept failure: RESERVED status alone never confirms acceptance, marked uncertain for retry', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      // Accept call throws network timeout
      fakeRepo.shouldThrowOnAcceptOffer = true;
      fakeRepo.acceptOfferException = const ApiException(
        statusCode: null,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'The request timed out.',
      );

      // Even if server status says RESERVED, client must NOT speculate or claim success!
      fakeRepo.statusResponse = approvedReservedStatus;
      fakeRepo.offersResponse = [sampleOffer1];

      final success = await provider.acceptOffer('off-101');

      // Must NOT claim success without authoritative 200 response
      expect(success, isFalse);
      expect(provider.unresolvedOfferId, 'off-101');
      expect(
        provider.offersError,
        'Acceptance outcome could not be confirmed. Please check your network and retry.',
      );
      expect(provider.actionSuccessMessage, isNull);
      expect(provider.isProcessingAction, isFalse);
    });

    test('ambiguous acceptance followed by empty pending-offer list can still be retried with identical key and original offer ID', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');
      expect(provider.offers.length, 1);

      // First call throws network error, and server accepted it so pending offers is now empty
      fakeRepo.shouldThrowOnAcceptOffer = true;
      fakeRepo.acceptOfferException = const ApiException(
        statusCode: null,
        errorCode: 'NETWORK_UNAVAILABLE',
        message: 'Network connection lost.',
      );
      fakeRepo.offersResponse = const []; // Pending offers is now empty!

      final f1 = await provider.acceptOffer('off-101');
      expect(f1, isFalse);
      expect(provider.unresolvedOfferId, 'off-101');
      expect(provider.offers, isEmpty); // Offer card disappeared from pending list!
      expect(provider.inboxState, DispatchInboxState.empty);
      expect(
        provider.offersError,
        'Acceptance outcome could not be confirmed. Please check your network and retry.',
      );
      final firstKey = fakeRepo.lastAcceptedIdempotencyKey;
      expect(firstKey, isNotNull);

      // Driver retries acceptance despite the offer card no longer existing in pending offers
      fakeRepo.shouldThrowOnAcceptOffer = false;
      fakeRepo.acceptOfferException = null;
      fakeRepo.acceptOfferResponse = const AcceptOfferResponse(
        assignmentId: 'asgn-1',
        tripId: 'trip-1',
        rideGroupId: 'grp-101',
        passengerCount: 2,
        totalEstimatedFare: '32.00',
        navigationRoute: NavigationRouteData(geometry: {}, stops: []),
      );
      fakeRepo.statusResponse = approvedReservedStatus;

      final f2 = await provider.acceptOffer('off-101');
      expect(f2, isTrue);
      expect(provider.unresolvedOfferId, isNull); // Authoritative 200 resolves the operation
      expect(provider.actionSuccessMessage, 'Offer accepted successfully!');
      expect(provider.operationalStatus, 'RESERVED');
      final secondKey = fakeRepo.lastAcceptedIdempotencyKey;

      // Verifies exact same idempotency key and offer ID were reused for the retry!
      expect(fakeRepo.lastAcceptedOfferId, 'off-101');
      expect(secondKey, equals(firstKey));
    });

    test('retryUnresolvedOffer delegates to acceptOffer for the unresolved offer', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      fakeRepo.shouldThrowOnAcceptOffer = true;
      fakeRepo.acceptOfferException = const ApiException(
        statusCode: 504,
        errorCode: 'GATEWAY_TIMEOUT',
        message: 'Gateway timeout',
      );
      fakeRepo.offersResponse = const [];

      final f1 = await provider.acceptOffer('off-101');
      expect(f1, isFalse);
      expect(provider.unresolvedOfferId, 'off-101');

      fakeRepo.shouldThrowOnAcceptOffer = false;
      fakeRepo.acceptOfferException = null;
      fakeRepo.acceptOfferResponse = const AcceptOfferResponse(
        assignmentId: 'asgn-1',
        tripId: 'trip-1',
        rideGroupId: 'grp-101',
        passengerCount: 2,
        totalEstimatedFare: '32.00',
        navigationRoute: NavigationRouteData(geometry: {}, stops: []),
      );
      fakeRepo.statusResponse = approvedReservedStatus;

      final f2 = await provider.retryUnresolvedOffer();
      expect(f2, isTrue);
      expect(provider.unresolvedOfferId, isNull);
      expect(fakeRepo.lastAcceptedOfferId, 'off-101');
    });

    test('unresolved acceptance blocks starting conflicting acceptance of another offer', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1, sampleOffer2];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      // First offer fails ambiguously
      fakeRepo.shouldThrowOnAcceptOffer = true;
      fakeRepo.acceptOfferException = const ApiException(
        statusCode: 504,
        errorCode: 'GATEWAY_TIMEOUT',
        message: 'Gateway timeout',
      );

      final f1 = await provider.acceptOffer('off-101');
      expect(f1, isFalse);
      expect(provider.unresolvedOfferId, 'off-101');

      // Driver attempts to accept different offer while off-101 is unresolved
      final f2 = await provider.acceptOffer('off-102');
      expect(f2, isFalse);
      expect(fakeRepo.lastAcceptedOfferId, 'off-101'); // off-102 was never dispatched
      expect(
        provider.offersError,
        contains('Another offer acceptance is unresolved'),
      );
    });

    test('ambiguous reject failure: does not claim success when offer is no longer pending, preserves key', () async {
      fakeRepo.statusResponse = approvedOnlineStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      // Reject call throws 503
      fakeRepo.shouldThrowOnRejectOffer = true;
      fakeRepo.rejectOfferException = const ApiException(
        statusCode: 503,
        errorCode: 'SERVICE_UNAVAILABLE',
        message: 'Gateway timeout',
      );

      // Offer is no longer in pending offers (e.g. expired or withdrawn)
      fakeRepo.offersResponse = const [];

      final success = await provider.rejectOffer('off-101');

      // Must NOT claim success; must show neutral message that final outcome could not be confirmed
      expect(success, isFalse);
      expect(provider.offers, isEmpty);
      expect(provider.inboxState, DispatchInboxState.empty);
      expect(
        provider.offersError,
        'Offer is no longer pending. Final outcome could not be confirmed.',
      );
      expect(provider.isProcessingAction, isFalse);
    });

    test('cannot accept offer when driver is already RESERVED', () async {
      fakeRepo.statusResponse = approvedReservedStatus;
      fakeRepo.offersResponse = [sampleOffer1];
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-1');

      final success = await provider.acceptOffer('off-101');
      expect(success, isFalse);
      expect(fakeRepo.acceptOfferCallCount, 0);
    });
  });
}
