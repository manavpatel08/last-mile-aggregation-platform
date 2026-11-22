import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'models/sync_models.dart';
import 'socket_client.dart';
import 'socket_service.dart';
import 'sync_repository.dart';

/// Service coordinating authoritative state reconciliation via `POST /api/v1/sync`
/// upon Socket.IO reconnection and application foregrounding.
class SyncService extends ChangeNotifier {
  SyncService({
    required this.syncRepository,
    required this.socketService,
  }) {
    _socketSubscription =
        socketService.stateStream.listen(_onSocketStateChanged);
  }

  final SyncRepository syncRepository;
  final SocketService socketService;

  final _syncResponseController = StreamController<SyncResponseDto>.broadcast();
  StreamSubscription<SocketConnectionState>? _socketSubscription;

  SocketConnectionState _lastSocketState = SocketConnectionState.disconnected;
  SyncResponseDto? _lastResponse;
  bool _isSyncing = false;
  bool _isDisposed = false;

  int? _lastKnownEntityVersion;
  String? _activeBookingId;
  String? _activeTripId;

  SyncResponseDto? get lastResponse => _lastResponse;
  bool get isSyncing => _isSyncing;
  Stream<SyncResponseDto> get syncStream => _syncResponseController.stream;

  int? get lastKnownEntityVersion => _lastKnownEntityVersion;
  String? get activeBookingId => _activeBookingId;
  String? get activeTripId => _activeTripId;

  /// Updates tracked entity IDs and versions passed in subsequent sync calls.
  void updateTrackingContext({
    int? version,
    String? bookingId,
    String? tripId,
    bool clearBooking = false,
    bool clearTrip = false,
  }) {
    if (version != null) _lastKnownEntityVersion = version;
    if (clearBooking) {
      _activeBookingId = null;
    } else if (bookingId != null) {
      _activeBookingId = bookingId;
    }
    if (clearTrip) {
      _activeTripId = null;
    } else if (tripId != null) {
      _activeTripId = tripId;
    }
  }

  void _onSocketStateChanged(SocketConnectionState state) {
    if (_isDisposed) return;
    // Trigger sync when transitioning from disconnected/reconnecting into connected
    if (state == SocketConnectionState.connected &&
        _lastSocketState != SocketConnectionState.connected) {
      reconcile();
    }
    _lastSocketState = state;
  }

  /// Hook called when Flutter application returns to foreground (`AppLifecycleState.resumed`).
  void onAppLifecycleStateChanged(AppLifecycleState state) {
    if (_isDisposed) return;
    if (state == AppLifecycleState.resumed) {
      reconcile();
    }
  }

  /// Executes state reconciliation against PostgreSQL truth via `POST /api/v1/sync`.
  Future<SyncResponseDto?> reconcile() async {
    if (_isDisposed || _isSyncing) return null;

    _isSyncing = true;
    notifyListeners();

    try {
      final request = SyncRequestDto(
        lastKnownEntityVersion: _lastKnownEntityVersion,
        activeBookingId: _activeBookingId,
        activeTripId: _activeTripId,
      );

      final response = await syncRepository.syncState(request);
      _lastResponse = response;

      // Update tracked versions and IDs from authoritative response
      if (response.passengerState != null) {
        final booking = response.passengerState?.activeBooking;
        final trip = response.passengerState?.activeTrip;
        final group = response.passengerState?.activeGroup;

        _activeBookingId = booking?.id;
        _activeTripId = trip?.id;
        _lastKnownEntityVersion =
            group?.groupVersion ?? trip?.tripVersion ?? booking?.entityVersion;
      } else if (response.driverState != null) {
        final trip = response.driverState?.activeTrip;
        final offer = response.driverState?.activeOffer;

        _activeTripId = trip?.id;
        _lastKnownEntityVersion = trip?.tripVersion ?? offer?.groupVersion;
      }

      if (!_syncResponseController.isClosed) {
        _syncResponseController.add(response);
      }
      notifyListeners();
      return response;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[SyncService] Reconciliation failed: $e');
      }
      return null;
    } finally {
      _isSyncing = false;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    if (_isDisposed) return;
    _isDisposed = true;
    _socketSubscription?.cancel();
    _syncResponseController.close();
    super.dispose();
  }
}
