import 'package:flutter/widgets.dart';
import 'package:uuid/uuid.dart';

import '../../../core/network/api_exception.dart';
import '../data/driver_repository.dart';
import '../models/driver_status_response.dart';
import '../models/driver_vehicle.dart';
import '../presentation/models/dispatch_offer_item.dart';
import '../services/driver_location_tracker.dart';

/// Immutable descriptor for a placeholder section shown on the Driver Home screen.
class DriverPlaceholderItem {
  const DriverPlaceholderItem({
    required this.id,
    required this.title,
    required this.description,
  });

  final String id;
  final String title;
  final String description;
}

/// Feature-scoped Provider managing Driver Home presentation, readiness dashboard,
/// driver availability toggle, dispatch offers inbox, and foreground GPS tracking.
class DriverHomeProvider extends ChangeNotifier {
  DriverHomeProvider({
    this.driverRepository,
    DriverLocationTracker? locationTracker,
  }) : _locationTracker = locationTracker ?? const NoOpDriverLocationTracker();

  final DriverRepository? driverRepository;
  final DriverLocationTracker _locationTracker;

  final List<DriverPlaceholderItem> _sections = const [
    DriverPlaceholderItem(
      id: 'onboarding',
      title: 'Driver Onboarding & Verification',
      description:
          'Document submission and administrator approval status will be integrated here.',
    ),
    DriverPlaceholderItem(
      id: 'dispatch',
      title: 'Dispatch Offers',
      description:
          'Sequential 1-to-1 ride group dispatch offers will appear here once dispatch APIs are connected.',
    ),
    DriverPlaceholderItem(
      id: 'active_trip',
      title: 'Active Trip & Passenger Manifest',
      description:
          'Pickup arrival, boarding verification, drop-off progression, and cash confirmation will appear here.',
    ),
  ];

  List<DriverPlaceholderItem> get sections => _sections;

  // Readiness Dashboard State
  bool _isLoading = false;
  bool _isRefreshing = false;
  String? _error;
  DriverStatusResponse? _status;
  List<DriverVehicle> _vehicles = const [];
  bool _hasLoaded = false;
  String? _currentUserId;
  int _requestGeneration = 0;

  // Availability & Dispatch Offers State (TASK-009 Phase 2)
  bool _isUpdatingStatus = false;
  String? _statusUpdateError;
  DispatchInboxState _inboxState = DispatchInboxState.disconnected;
  List<DispatchOfferItem> _offers = const [];
  String? _offersError;
  bool _isProcessingAction = false;
  final Map<String, String> _offerIdempotencyKeys = {};

  bool get isLoading => _isLoading;
  bool get isRefreshing => _isRefreshing;
  String? get error => _error;
  bool get hasError => _error != null;
  DriverStatusResponse? get status => _status;
  List<DriverVehicle> get vehicles => _vehicles;
  int get vehicleCount => _status?.vehiclesCount ?? _vehicles.length;
  bool? get isOnline => _status?.isOnline;
  bool get hasStatus => _status != null;
  String? get operationalStatus => _status?.operationalStatus;
  bool get hasLoaded => _hasLoaded;
  String? get currentUserId => _currentUserId;

  bool get isUpdatingStatus => _isUpdatingStatus;
  String? get statusUpdateError => _statusUpdateError;
  DispatchInboxState get inboxState => _inboxState;
  List<DispatchOfferItem> get offers => _offers;
  String? get offersError => _offersError;
  bool get isProcessingAction => _isProcessingAction;

  @visibleForTesting
  DriverLocationTracker get locationTracker => _locationTracker;

  @visibleForTesting
  int get requestGeneration => _requestGeneration;

  bool _isCurrentRequest(int generation, String? userId) {
    return generation == _requestGeneration && userId == _currentUserId;
  }

  String get statusSummary {
    if (_status != null) {
      final onlineText = _status!.isOnline ? 'Online' : 'Offline';
      return 'Operational Status: ${_status!.operationalStatus} ($onlineText). Registered vehicles: $vehicleCount.';
    }
    return 'Driver application foundation is ready. Operational driver access is enforced by backend verification status.';
  }

  /// Clears all user-session, dashboard, availability, and dispatch offer state across logout or account switch.
  ///
  /// Increments [_requestGeneration] so all in-flight asynchronous operations
  /// from the previous account session are immediately invalidated.
  void clear() {
    _requestGeneration++;
    _currentUserId = null;
    _isLoading = false;
    _isRefreshing = false;
    _error = null;
    _status = null;
    _vehicles = const [];
    _hasLoaded = false;
    _isUpdatingStatus = false;
    _statusUpdateError = null;
    _inboxState = DispatchInboxState.disconnected;
    _offers = const [];
    _offersError = null;
    _isProcessingAction = false;
    _offerIdempotencyKeys.clear();
    _locationTracker.stopTracking();
    notifyListeners();
  }

  /// Resets dashboard state specifically for a new user ID.
  ///
  /// Increments [_requestGeneration] so all in-flight asynchronous operations
  /// from the previous account session are immediately invalidated.
  void clearForUser(String? userId) {
    _requestGeneration++;
    _currentUserId = userId;
    _isLoading = false;
    _isRefreshing = false;
    _error = null;
    _status = null;
    _vehicles = const [];
    _hasLoaded = false;
    _isUpdatingStatus = false;
    _statusUpdateError = null;
    _inboxState = DispatchInboxState.disconnected;
    _offers = const [];
    _offersError = null;
    _isProcessingAction = false;
    _offerIdempotencyKeys.clear();
    _locationTracker.stopTracking();
    notifyListeners();
  }

  /// Updates app lifecycle state for foreground-only GPS telemetry.
  void updateAppLifecycle(AppLifecycleState state) {
    _locationTracker.updateAppLifecycle(state);
  }

  /// Loads driver dashboard data (operational status and registered vehicles).
  ///
  /// CRITICAL GUARD (AGENTS.md §1.3 & Requirement 4):
  /// `GET /api/v1/drivers/status` is protected by `@RequireDriverApproval()`.
  /// If [verificationStatus] is not 'APPROVED' (i.e. PENDING, REJECTED, SUSPENDED),
  /// do NOT call `getDriverStatus()`.
  Future<void> loadDashboard({
    required String verificationStatus,
    String? userId,
    DriverRepository? repository,
  }) async {
    final repo = repository ?? driverRepository;
    if (repo == null) {
      _error = 'Driver repository not available';
      notifyListeners();
      return;
    }

    if (userId != null && userId != _currentUserId) {
      _requestGeneration++;
      _currentUserId = userId;
      _status = null;
      _vehicles = const [];
      _error = null;
      _hasLoaded = false;
      _isLoading = false;
      _isRefreshing = false;
      _isUpdatingStatus = false;
      _statusUpdateError = null;
      _inboxState = DispatchInboxState.disconnected;
      _offers = const [];
      _offersError = null;
      _isProcessingAction = false;
      _offerIdempotencyKeys.clear();
      _locationTracker.stopTracking();
    } else if (userId != null) {
      _currentUserId = userId;
    }

    if (_isLoading) return;

    final requestGen = ++_requestGeneration;
    final requestUser = _currentUserId;

    _isLoading = true;
    _isRefreshing = false;
    _error = null;
    notifyListeners();

    try {
      final isApproved = verificationStatus == 'APPROVED';

      if (isApproved) {
        final results = await Future.wait([
          repo.getDriverStatus(),
          repo.getVehicles(),
        ]);
        if (!_isCurrentRequest(requestGen, requestUser)) return;
        _status = results[0] as DriverStatusResponse;
        _vehicles = results[1] as List<DriverVehicle>;

        // Coordinate online foreground location reporting and offers
        if (_status!.isOnline) {
          _locationTracker.startTracking(repository: repo);
          await _fetchOffersInternal(repo: repo, requestGen: requestGen, requestUser: requestUser);
        } else {
          _locationTracker.stopTracking();
          _inboxState = DispatchInboxState.disconnected;
          _offers = const [];
        }
      } else {
        // For non-approved drivers:
        // Never call the approval-protected operational-status endpoint!
        final fetchedVehicles = await repo.getVehicles();
        if (!_isCurrentRequest(requestGen, requestUser)) return;
        _status = null;
        _vehicles = fetchedVehicles;
        _locationTracker.stopTracking();
        _inboxState = DispatchInboxState.disconnected;
        _offers = const [];
      }
      _error = null;
      _hasLoaded = true;
    } catch (e) {
      if (!_isCurrentRequest(requestGen, requestUser)) return;
      _error = e is ApiException
          ? e.message
          : 'Failed to load driver dashboard: ${e.toString()}';
    } finally {
      if (_isCurrentRequest(requestGen, requestUser)) {
        _isLoading = false;
        notifyListeners();
      }
    }
  }

  /// Refreshes dashboard data without showing fullscreen loading spinner.
  Future<void> refreshDashboard({
    required String verificationStatus,
    String? userId,
    DriverRepository? repository,
  }) async {
    final repo = repository ?? driverRepository;

    if (userId != null && userId != _currentUserId) {
      _requestGeneration++;
      _currentUserId = userId;
      _status = null;
      _vehicles = const [];
      _error = null;
      _hasLoaded = false;
      _isLoading = false;
      _isRefreshing = false;
      _isUpdatingStatus = false;
      _statusUpdateError = null;
      _inboxState = DispatchInboxState.disconnected;
      _offers = const [];
      _offersError = null;
      _isProcessingAction = false;
      _offerIdempotencyKeys.clear();
      _locationTracker.stopTracking();
    } else if (userId != null) {
      _currentUserId = userId;
    }

    if (repo == null || _isRefreshing || _isLoading) return;

    final requestGen = ++_requestGeneration;
    final requestUser = _currentUserId;

    _isRefreshing = true;
    notifyListeners();

    try {
      final isApproved = verificationStatus == 'APPROVED';

      if (isApproved) {
        final results = await Future.wait([
          repo.getDriverStatus(),
          repo.getVehicles(),
        ]);
        if (!_isCurrentRequest(requestGen, requestUser)) return;
        _status = results[0] as DriverStatusResponse;
        _vehicles = results[1] as List<DriverVehicle>;

        if (_status!.isOnline) {
          _locationTracker.startTracking(repository: repo);
          await _fetchOffersInternal(repo: repo, requestGen: requestGen, requestUser: requestUser);
        } else {
          _locationTracker.stopTracking();
          _inboxState = DispatchInboxState.disconnected;
          _offers = const [];
        }
      } else {
        final updatedVehicles = await repo.getVehicles();
        if (!_isCurrentRequest(requestGen, requestUser)) return;
        _status = null;
        _vehicles = updatedVehicles;
        _locationTracker.stopTracking();
        _inboxState = DispatchInboxState.disconnected;
        _offers = const [];
      }
      _error = null;
      _hasLoaded = true;
    } catch (e) {
      if (!_isCurrentRequest(requestGen, requestUser)) return;
      _error = e is ApiException
          ? e.message
          : 'Failed to refresh driver dashboard: ${e.toString()}';
    } finally {
      if (_isCurrentRequest(requestGen, requestUser)) {
        _isRefreshing = false;
        notifyListeners();
      }
    }
  }

  /// Updates driver online/offline duty status (`PATCH /api/v1/drivers/status`).
  ///
  /// CRITICAL INVARIANTS:
  /// 1. Enforces driver approval gating: only approved drivers can mutate status.
  /// 2. Sets [_isUpdatingStatus] while in flight to prevent duplicate taps.
  /// 3. Does NOT optimistically alter [_status]; only sets authoritative server response.
  /// 4. Handles 409 Conflict (e.g. driver has active trip/assignment) and captures message.
  Future<bool> setOnline(bool online, {DriverRepository? repository}) async {
    final repo = repository ?? driverRepository;
    if (repo == null || _isUpdatingStatus) return false;

    if (_status == null || !_status!.isApproved) {
      _statusUpdateError = 'Driver operational status is not approved';
      notifyListeners();
      return false;
    }

    final requestGen = ++_requestGeneration;
    final requestUser = _currentUserId;

    _isUpdatingStatus = true;
    _statusUpdateError = null;
    notifyListeners();

    try {
      final updatedStatus = await repo.updateStatus(isOnline: online);
      if (!_isCurrentRequest(requestGen, requestUser)) return false;

      _status = updatedStatus;
      _statusUpdateError = null;

      if (updatedStatus.isOnline) {
        _locationTracker.startTracking(repository: repo);
        await _fetchOffersInternal(repo: repo, requestGen: requestGen, requestUser: requestUser);
      } else {
        _locationTracker.stopTracking();
        _inboxState = DispatchInboxState.disconnected;
        _offers = const [];
      }
      return true;
    } catch (e) {
      if (!_isCurrentRequest(requestGen, requestUser)) return false;
      _statusUpdateError = e is ApiException ? e.message : e.toString();
      return false;
    } finally {
      if (_isCurrentRequest(requestGen, requestUser)) {
        _isUpdatingStatus = false;
        notifyListeners();
      }
    }
  }

  /// Retrieves pending dispatch offers (`GET /api/v1/drivers/offers/pending`).
  Future<void> loadOffers({DriverRepository? repository}) async {
    final repo = repository ?? driverRepository;
    if (repo == null) return;

    if (_status == null || !_status!.isApproved || !_status!.isOnline) {
      _inboxState = DispatchInboxState.disconnected;
      _offers = const [];
      notifyListeners();
      return;
    }

    final requestGen = ++_requestGeneration;
    final requestUser = _currentUserId;

    _inboxState = DispatchInboxState.loading;
    _offersError = null;
    notifyListeners();

    await _fetchOffersInternal(repo: repo, requestGen: requestGen, requestUser: requestUser);
    if (_isCurrentRequest(requestGen, requestUser)) {
      notifyListeners();
    }
  }

  Future<void> _fetchOffersInternal({
    required DriverRepository repo,
    required int requestGen,
    required String? requestUser,
  }) async {
    try {
      final offersList = await repo.getPendingOffers();
      if (!_isCurrentRequest(requestGen, requestUser)) return;

      if (offersList.isEmpty) {
        _inboxState = DispatchInboxState.empty;
        _offers = const [];
      } else {
        _inboxState = DispatchInboxState.ready;
        _offers = offersList.map((o) => o.toPresentationItem()).toList();
      }
      _offersError = null;
    } catch (e) {
      if (!_isCurrentRequest(requestGen, requestUser)) return;
      _inboxState = DispatchInboxState.error;
      _offersError = e is ApiException ? e.message : e.toString();
    }
  }

  /// Driver accepts a dispatch offer with mandatory `Idempotency-Key`
  /// (`POST /api/v1/drivers/offers/:id/accept`).
  Future<bool> acceptOffer(String offerId, {DriverRepository? repository}) async {
    final repo = repository ?? driverRepository;
    if (repo == null || _isProcessingAction) return false;

    final offerIndex = _offers.indexWhere((o) => o.id == offerId);
    if (offerIndex == -1) return false;

    final targetOffer = _offers[offerIndex];
    if (targetOffer.isActionPending || targetOffer.isExpired) return false;

    final requestGen = ++_requestGeneration;
    final requestUser = _currentUserId;

    _isProcessingAction = true;
    _offers = [
      for (int i = 0; i < _offers.length; i++)
        if (i == offerIndex)
          DispatchOfferItem(
            id: targetOffer.id,
            groupId: targetOffer.groupId,
            pickupLocationName: targetOffer.pickupLocationName,
            dropoffLocationName: targetOffer.dropoffLocationName,
            passengerCount: targetOffer.passengerCount,
            estimatedEarnings: targetOffer.estimatedEarnings,
            estimatedDistance: targetOffer.estimatedDistance,
            detourPercentage: targetOffer.detourPercentage,
            status: DispatchOfferStatus.accepting,
          )
        else
          _offers[i],
    ];
    notifyListeners();

    final idempotencyKey = _offerIdempotencyKeys.putIfAbsent(
      offerId,
      () => const Uuid().v4(),
    );

    try {
      await repo.acceptOffer(
        offerId: offerId,
        idempotencyKey: idempotencyKey,
      );
      if (!_isCurrentRequest(requestGen, requestUser)) return false;

      // Update local operational status to RESERVED
      if (_status != null) {
        _status = DriverStatusResponse(
          id: _status!.id,
          verificationStatus: _status!.verificationStatus,
          operationalStatus: 'RESERVED',
          isOnline: _status!.isOnline,
          vehiclesCount: _status!.vehiclesCount,
        );
      }

      // Authoritative refresh of offers and dashboard
      await Future.wait([
        refreshDashboard(
          verificationStatus: _status?.verificationStatus ?? 'APPROVED',
          userId: _currentUserId,
          repository: repo,
        ),
        loadOffers(repository: repo),
      ]);

      return true;
    } catch (e) {
      if (!_isCurrentRequest(requestGen, requestUser)) return false;
      final actionError = e is ApiException ? e.message : e.toString();
      // On failure (e.g. OFFER_EXPIRED, OFFER_ALREADY_TAKEN), reconcile pending offers
      await _fetchOffersInternal(
        repo: repo,
        requestGen: requestGen,
        requestUser: requestUser,
      );
      _offersError = actionError;
      return false;
    } finally {
      if (_isCurrentRequest(requestGen, requestUser)) {
        _isProcessingAction = false;
        notifyListeners();
      }
    }
  }

  /// Driver explicitly rejects a dispatch offer (`POST /api/v1/drivers/offers/:id/reject`).
  Future<bool> rejectOffer(
    String offerId, {
    String? reason,
    DriverRepository? repository,
  }) async {
    final repo = repository ?? driverRepository;
    if (repo == null || _isProcessingAction) return false;

    final offerIndex = _offers.indexWhere((o) => o.id == offerId);
    if (offerIndex == -1) return false;

    final targetOffer = _offers[offerIndex];
    if (targetOffer.isActionPending || targetOffer.isExpired) return false;

    final requestGen = ++_requestGeneration;
    final requestUser = _currentUserId;

    _isProcessingAction = true;
    _offers = [
      for (int i = 0; i < _offers.length; i++)
        if (i == offerIndex)
          DispatchOfferItem(
            id: targetOffer.id,
            groupId: targetOffer.groupId,
            pickupLocationName: targetOffer.pickupLocationName,
            dropoffLocationName: targetOffer.dropoffLocationName,
            passengerCount: targetOffer.passengerCount,
            estimatedEarnings: targetOffer.estimatedEarnings,
            estimatedDistance: targetOffer.estimatedDistance,
            detourPercentage: targetOffer.detourPercentage,
            status: DispatchOfferStatus.declining,
          )
        else
          _offers[i],
    ];
    notifyListeners();

    final idempotencyKey = _offerIdempotencyKeys.putIfAbsent(
      'reject_$offerId',
      () => const Uuid().v4(),
    );

    try {
      await repo.rejectOffer(
        offerId: offerId,
        idempotencyKey: idempotencyKey,
        reason: reason,
      );
      if (!_isCurrentRequest(requestGen, requestUser)) return false;

      _offers = _offers.where((o) => o.id != offerId).toList();
      if (_offers.isEmpty) {
        _inboxState = DispatchInboxState.empty;
      }
      return true;
    } catch (e) {
      if (!_isCurrentRequest(requestGen, requestUser)) return false;
      final actionError = e is ApiException ? e.message : e.toString();
      await _fetchOffersInternal(
        repo: repo,
        requestGen: requestGen,
        requestUser: requestUser,
      );
      _offersError = actionError;
      return false;
    } finally {
      if (_isCurrentRequest(requestGen, requestUser)) {
        _isProcessingAction = false;
        notifyListeners();
      }
    }
  }

  void clearError() {
    _error = null;
    notifyListeners();
  }

  void clearStatusUpdateError() {
    _statusUpdateError = null;
    notifyListeners();
  }

  void clearOffersError() {
    _offersError = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _locationTracker.dispose();
    super.dispose();
  }
}
