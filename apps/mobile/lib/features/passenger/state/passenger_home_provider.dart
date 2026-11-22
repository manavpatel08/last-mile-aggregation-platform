import 'package:flutter/foundation.dart';

import '../../../core/realtime/models/sync_models.dart';
import '../../booking/data/booking_repository.dart';
import '../../booking/models/booking_response.dart';

/// Immutable descriptor for a placeholder section shown on the Passenger Home screen.
class PassengerPlaceholderItem {
  const PassengerPlaceholderItem({
    required this.id,
    required this.title,
    required this.description,
  });

  final String id;
  final String title;
  final String description;
}

/// Feature-scoped Provider foundation for Passenger Home presentation state.
class PassengerHomeProvider extends ChangeNotifier {
  final List<PassengerPlaceholderItem> _sections = const [
    PassengerPlaceholderItem(
      id: 'active_ride',
      title: 'Active Ride Tracking',
      description:
          'Driver assignment, boarding confirmation, and live GPS streaming will appear here.',
    ),
    PassengerPlaceholderItem(
      id: 'history',
      title: 'Ride History & Receipts',
      description:
          'Completed ride summaries and cash settlement records will be integrated here.',
    ),
  ];

  List<PassengerPlaceholderItem> get sections => _sections;

  BookingResponse? _activeBooking;
  bool _isLoadingActiveBooking = false;
  String? _activeBookingError;

  SyncPassengerActiveTrip? _activeTrip;
  List<SyncOutstandingFee> _outstandingFees = const [];
  DateTime? _lastSyncedBookingUpdatedAt;
  int? _lastSyncedBookingEntityVersion;

  BookingResponse? get activeBooking => _activeBooking;
  SyncPassengerActiveTrip? get activeTrip => _activeTrip;
  List<SyncOutstandingFee> get outstandingFees => _outstandingFees;
  DateTime? get lastSyncedBookingUpdatedAt => _lastSyncedBookingUpdatedAt;
  int? get lastSyncedBookingEntityVersion => _lastSyncedBookingEntityVersion;
  bool get isLoadingActiveBooking => _isLoadingActiveBooking;
  String? get activeBookingError => _activeBookingError;

  String get statusSummary => _activeBooking != null
      ? 'Active booking in progress (${_activeBooking!.status}). Ceiling: ₹${_activeBooking!.agreedFareCeiling}'
      : 'PDEU campus last-mile connectivity is active. Request a ride anytime.';

  void updateActiveBooking(BookingResponse? booking) {
    _activeBooking = booking;
    _lastSyncedBookingUpdatedAt = booking?.updatedAt;
    notifyListeners();
  }

  /// Handles incoming `booking.status.updated` realtime events.
  void onBookingStatusUpdated(Map<String, dynamic> data) {
    final status = data['status'] as String?;
    if (status == 'CANCELLED' || status == 'EXPIRED') {
      _activeBooking = null;
      _lastSyncedBookingUpdatedAt = null;
      _lastSyncedBookingEntityVersion = null;
      notifyListeners();
    }
  }

  /// Handles authoritative passenger state updates from `POST /api/v1/sync`.
  void handleSyncResponse(
    SyncPassengerState? state, {
    BookingRepository? repository,
  }) {
    if (state == null) return;

    // Always reconcile outstanding cancellation fees from the sync snapshot,
    // regardless of whether an active booking exists.
    _outstandingFees = state.outstandingCancellationFees;

    if (state.activeBooking == null) {
      _lastSyncedBookingUpdatedAt = null;
      _lastSyncedBookingEntityVersion = null;
      _activeBooking = null;
      _activeTrip = null;
      notifyListeners();
      return;
    }

    _activeTrip = state.activeTrip;

    final incoming = state.activeBooking!;

    final bool isDifferentBooking = _activeBooking == null ||
        _activeBooking!.bookingId != incoming.id;

    final bool isStatusChanged = _activeBooking != null &&
        _activeBooking!.status != incoming.status;

    final bool isServerUpdatedAtNewer = _activeBooking?.updatedAt != null
        ? incoming.updatedAt.isAfter(_activeBooking!.updatedAt!)
        : (_lastSyncedBookingUpdatedAt != null &&
            incoming.updatedAt.isAfter(_lastSyncedBookingUpdatedAt!));

    final bool isPickupPointChanged = _activeBooking?.pickupPointId != null &&
        _activeBooking!.pickupPointId != incoming.pickupPointId;

    // Meaningful authoritative fields determine whether a REST refresh is required.
    // Entity version is derived from activeGroup.groupVersion on the server and is
    // not relied upon alone to trigger booking refreshes.
    final bool needsRefresh = isDifferentBooking ||
        isStatusChanged ||
        isServerUpdatedAtNewer ||
        isPickupPointChanged;

    _lastSyncedBookingUpdatedAt = incoming.updatedAt;
    _lastSyncedBookingEntityVersion = incoming.entityVersion;

    if (needsRefresh && repository != null) {
      loadActiveBooking(
        repository,
        syncedUpdatedAt: incoming.updatedAt,
        syncedVersion: incoming.entityVersion,
      );
    } else {
      notifyListeners();
    }
  }

  Future<void> loadActiveBooking(
    BookingRepository bookingRepository, {
    DateTime? syncedUpdatedAt,
    int? syncedVersion,
  }) async {
    _isLoadingActiveBooking = true;
    _activeBookingError = null;
    notifyListeners();

    try {
      final booking = await bookingRepository.getActiveBooking();
      _activeBooking = booking;
      if (booking?.updatedAt != null) {
        _lastSyncedBookingUpdatedAt = booking!.updatedAt;
      } else if (syncedUpdatedAt != null) {
        _lastSyncedBookingUpdatedAt = syncedUpdatedAt;
      }
      if (syncedVersion != null) {
        _lastSyncedBookingEntityVersion = syncedVersion;
      }
    } catch (e) {
      _activeBookingError = e.toString();
    } finally {
      _isLoadingActiveBooking = false;
      notifyListeners();
    }
  }
}
