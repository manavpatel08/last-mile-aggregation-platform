import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:uuid/uuid.dart';

import '../../../core/network/api_exception.dart';
import '../data/driver_repository.dart';
import '../models/accept_offer_response.dart';
import '../models/driver_dispatch_offer.dart';
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
    this.enableCountdownTimer = true,
  }) : _locationTracker = locationTracker ?? const NoOpDriverLocationTracker();

  final DriverRepository? driverRepository;
  final DriverLocationTracker _locationTracker;
  final bool enableCountdownTimer;

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

  // Session Tracking (increments on clear/logout/account switch)
  int _sessionGeneration = 0;
  String? _currentUserId;

  // Independent Request Tracking Generations (decoupled concurrency)
  int _dashboardRequestGeneration = 0;
  int _offersRequestGeneration = 0;
  int _statusMutationGeneration = 0;
  int _actionRequestGeneration = 0;

  // Readiness Dashboard State
  bool _isLoading = false;
  bool _isRefreshing = false;
  String? _error;
  DriverStatusResponse? _status;
  List<DriverVehicle> _vehicles = const [];
  bool _hasLoaded = false;

  // Availability State
  bool _isUpdatingStatus = false;
  String? _statusUpdateError;

  // Dispatch Offers State (TASK-009 Phase 2)
  DispatchInboxState _inboxState = DispatchInboxState.disconnected;
  List<DispatchOfferItem> _offers = const [];
  String? _offersError;
  String? _actionSuccessMessage;
  bool _isProcessingAction = false;
  String? _unresolvedOfferId;
  final Map<String, String> _offerIdempotencyKeys = {};
  String? _activeTripId;
  AcceptOfferResponse? _lastAcceptedOffer;

  // Presentation Countdown Timer
  Timer? _countdownTimer;

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
  String? get actionSuccessMessage => _actionSuccessMessage;
  bool get isProcessingAction => _isProcessingAction;
  String? get unresolvedOfferId => _unresolvedOfferId;
  String? get activeTripId => _activeTripId;
  AcceptOfferResponse? get lastAcceptedOffer => _lastAcceptedOffer;

  /// Clears active trip reference on trip completion or dismissal.
  void clearActiveTrip() {
    _activeTripId = null;
    _lastAcceptedOffer = null;
    notifyListeners();
  }

  @visibleForTesting
  DriverLocationTracker get locationTracker => _locationTracker;

  @visibleForTesting
  int get sessionGeneration => _sessionGeneration;

  @visibleForTesting
  int get requestGeneration => _sessionGeneration;

  @visibleForTesting
  int get dashboardRequestGeneration => _dashboardRequestGeneration;

  @visibleForTesting
  int get offersRequestGeneration => _offersRequestGeneration;

  @visibleForTesting
  int get actionRequestGeneration => _actionRequestGeneration;

  bool _isCurrentSession(int sessionGen, String? userId) {
    return sessionGen == _sessionGeneration && userId == _currentUserId;
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
  /// Increments [_sessionGeneration] and all operation generations so in-flight
  /// asynchronous operations from the previous account session are completely dropped.
  void clear() {
    _sessionGeneration++;
    _dashboardRequestGeneration++;
    _offersRequestGeneration++;
    _statusMutationGeneration++;
    _actionRequestGeneration++;
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
    _actionSuccessMessage = null;
    _isProcessingAction = false;
    _unresolvedOfferId = null;
    _offerIdempotencyKeys.clear();
    _activeTripId = null;
    _lastAcceptedOffer = null;
    _cancelCountdownTimer();
    _locationTracker.stopTracking();
    notifyListeners();
  }

  /// Resets dashboard state specifically for a new user ID.
  void clearForUser(String? userId) {
    _sessionGeneration++;
    _dashboardRequestGeneration++;
    _offersRequestGeneration++;
    _statusMutationGeneration++;
    _actionRequestGeneration++;
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
    _actionSuccessMessage = null;
    _isProcessingAction = false;
    _unresolvedOfferId = null;
    _offerIdempotencyKeys.clear();
    _activeTripId = null;
    _lastAcceptedOffer = null;
    _cancelCountdownTimer();
    _locationTracker.stopTracking();
    notifyListeners();
  }

  /// Updates app lifecycle state for foreground-only GPS telemetry.
  void updateAppLifecycle(AppLifecycleState state) {
    _locationTracker.updateAppLifecycle(state);
  }

  /// Explicitly halts foreground GPS telemetry when the driver leaves Driver Home
  /// (e.g. switching to Passenger mode or unmounting the screen) without mutating
  /// server-side online duty status.
  void stopTrackingOnExitDriverMode() {
    _locationTracker.stopTracking();
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
      clearForUser(userId);
    } else if (userId != null) {
      _currentUserId = userId;
    }

    if (_isLoading) return;

    final sessionGen = _sessionGeneration;
    final sessionUser = _currentUserId;
    final requestGen = ++_dashboardRequestGeneration;

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
        if (!_isCurrentSession(sessionGen, sessionUser) ||
            requestGen != _dashboardRequestGeneration) {
          return;
        }
        _status = results[0] as DriverStatusResponse;
        _vehicles = results[1] as List<DriverVehicle>;

        // Coordinate online foreground location reporting and offers
        if (_status!.isOnline) {
          _locationTracker.startTracking(repository: repo);
          await _fetchOffersInternal(
            repo: repo,
            sessionGen: sessionGen,
            sessionUser: sessionUser,
          );
        } else {
          _locationTracker.stopTracking();
          _cancelCountdownTimer();
          _inboxState = DispatchInboxState.disconnected;
          _offers = const [];
        }
      } else {
        // For non-approved drivers:
        // Never call the approval-protected operational-status endpoint!
        final fetchedVehicles = await repo.getVehicles();
        if (!_isCurrentSession(sessionGen, sessionUser) ||
            requestGen != _dashboardRequestGeneration) {
          return;
        }
        _status = null;
        _vehicles = fetchedVehicles;
        _locationTracker.stopTracking();
        _cancelCountdownTimer();
        _inboxState = DispatchInboxState.disconnected;
        _offers = const [];
      }
      _error = null;
      _hasLoaded = true;
    } catch (e) {
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _dashboardRequestGeneration) {
        return;
      }
      _error = e is ApiException
          ? e.message
          : 'Failed to load driver dashboard: ${e.toString()}';
    } finally {
      if (_isCurrentSession(sessionGen, sessionUser) &&
          requestGen == _dashboardRequestGeneration) {
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
      clearForUser(userId);
    } else if (userId != null) {
      _currentUserId = userId;
    }

    if (repo == null || _isRefreshing || _isLoading) return;

    final sessionGen = _sessionGeneration;
    final sessionUser = _currentUserId;
    final requestGen = ++_dashboardRequestGeneration;

    _isRefreshing = true;
    notifyListeners();

    try {
      final isApproved = verificationStatus == 'APPROVED';

      if (isApproved) {
        final results = await Future.wait([
          repo.getDriverStatus(),
          repo.getVehicles(),
        ]);
        if (!_isCurrentSession(sessionGen, sessionUser) ||
            requestGen != _dashboardRequestGeneration) {
          return;
        }
        _status = results[0] as DriverStatusResponse;
        _vehicles = results[1] as List<DriverVehicle>;

        if (_status!.isOnline) {
          _locationTracker.startTracking(repository: repo);
          await _fetchOffersInternal(
            repo: repo,
            sessionGen: sessionGen,
            sessionUser: sessionUser,
          );
        } else {
          _locationTracker.stopTracking();
          _cancelCountdownTimer();
          _inboxState = DispatchInboxState.disconnected;
          _offers = const [];
        }
      } else {
        final updatedVehicles = await repo.getVehicles();
        if (!_isCurrentSession(sessionGen, sessionUser) ||
            requestGen != _dashboardRequestGeneration) {
          return;
        }
        _status = null;
        _vehicles = updatedVehicles;
        _locationTracker.stopTracking();
        _cancelCountdownTimer();
        _inboxState = DispatchInboxState.disconnected;
        _offers = const [];
      }
      _error = null;
      _hasLoaded = true;
    } catch (e) {
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _dashboardRequestGeneration) {
        return;
      }
      _error = e is ApiException
          ? e.message
          : 'Failed to refresh driver dashboard: ${e.toString()}';
    } finally {
      if (_isCurrentSession(sessionGen, sessionUser) &&
          requestGen == _dashboardRequestGeneration) {
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

    final sessionGen = _sessionGeneration;
    final sessionUser = _currentUserId;
    final requestGen = ++_statusMutationGeneration;

    _isUpdatingStatus = true;
    _statusUpdateError = null;
    notifyListeners();

    try {
      final updatedStatus = await repo.updateStatus(isOnline: online);
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _statusMutationGeneration) {
        return false;
      }

      _status = updatedStatus;
      _statusUpdateError = null;

      if (updatedStatus.isOnline) {
        _locationTracker.startTracking(repository: repo);
        await _fetchOffersInternal(
          repo: repo,
          sessionGen: sessionGen,
          sessionUser: sessionUser,
        );
      } else {
        _locationTracker.stopTracking();
        _cancelCountdownTimer();
        _inboxState = DispatchInboxState.disconnected;
        _offers = const [];
      }
      return true;
    } catch (e) {
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _statusMutationGeneration) {
        return false;
      }
      _statusUpdateError = e is ApiException ? e.message : e.toString();
      return false;
    } finally {
      if (_isCurrentSession(sessionGen, sessionUser) &&
          requestGen == _statusMutationGeneration) {
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
      _cancelCountdownTimer();
      notifyListeners();
      return;
    }

    final sessionGen = _sessionGeneration;
    final sessionUser = _currentUserId;

    _inboxState = DispatchInboxState.loading;
    _offersError = null;
    notifyListeners();

    await _fetchOffersInternal(
      repo: repo,
      sessionGen: sessionGen,
      sessionUser: sessionUser,
    );
    if (_isCurrentSession(sessionGen, sessionUser)) {
      notifyListeners();
    }
  }

  /// Reconciles offers and status when the application resumes from the background.
  Future<void> reconcileOnResume({DriverRepository? repository}) async {
    final repo = repository ?? driverRepository;
    if (repo == null) return;
    if (_status == null || !_status!.isApproved || !_status!.isOnline) return;

    final sessionGen = _sessionGeneration;
    final sessionUser = _currentUserId;

    await _fetchOffersInternal(
      repo: repo,
      sessionGen: sessionGen,
      sessionUser: sessionUser,
    );
    if (_isCurrentSession(sessionGen, sessionUser)) {
      notifyListeners();
    }
  }

  Future<void> _fetchOffersInternal({
    required DriverRepository repo,
    required int sessionGen,
    required String? sessionUser,
  }) async {
    final requestGen = ++_offersRequestGeneration;
    try {
      final offersList = await repo.getPendingOffers();
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _offersRequestGeneration) {
        return;
      }

      if (offersList.isEmpty) {
        _inboxState = DispatchInboxState.empty;
        _offers = const [];
        _cancelCountdownTimer();
      } else {
        _inboxState = DispatchInboxState.ready;
        _offers = offersList.map((o) => o.toPresentationItem()).toList();
        _startCountdownTimer();
      }
      _offersError = null;
    } catch (e) {
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _offersRequestGeneration) {
        return;
      }
      _inboxState = DispatchInboxState.error;
      _offersError = e is ApiException ? e.message : e.toString();
      _cancelCountdownTimer();
    }
  }

  void _startCountdownTimer() {
    _countdownTimer?.cancel();
    if (!enableCountdownTimer || _offers.isEmpty) return;

    final hasPendingUnexpired = _offers.any(
      (o) =>
          !o.isExpired &&
          o.status == DispatchOfferStatus.pending &&
          (o.remainingSeconds != null && o.remainingSeconds! > 0),
    );
    if (!hasPendingUnexpired) return;

    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      _tickCountdown();
    });
  }

  void _cancelCountdownTimer() {
    _countdownTimer?.cancel();
    _countdownTimer = null;
  }

  void _tickCountdown() {
    bool hasChanged = false;
    bool hasRemaining = false;

    final updated = <DispatchOfferItem>[];
    for (final offer in _offers) {
      if (offer.status == DispatchOfferStatus.pending &&
          offer.remainingSeconds != null &&
          offer.remainingSeconds! > 0) {
        final nextRemaining = offer.remainingSeconds! - 1;
        hasChanged = true;
        if (nextRemaining <= 0) {
          updated.add(offer.copyWith(
            remainingSeconds: 0,
            status: DispatchOfferStatus.expired,
          ));
        } else {
          hasRemaining = true;
          updated.add(offer.copyWith(remainingSeconds: nextRemaining));
        }
      } else {
        updated.add(offer);
        if (offer.status == DispatchOfferStatus.pending &&
            offer.remainingSeconds != null &&
            offer.remainingSeconds! > 0) {
          hasRemaining = true;
        }
      }
    }

    if (hasChanged) {
      _offers = List.unmodifiable(updated);
      notifyListeners();
    }

    if (!hasRemaining) {
      _cancelCountdownTimer();
    }
  }

  /// Driver accepts a dispatch offer with mandatory `Idempotency-Key`
  /// (`POST /api/v1/drivers/offers/:id/accept`).
  ///
  /// Concurrency & Ambiguity Guardrails (AGENTS.md & Review Directive):
  /// 1. Action is isolated from dashboard/offer request counters.
  /// 2. If driver is already RESERVED, secondary accept is blocked.
  /// 3. If an offer acceptance is unresolved, conflicting acceptances of other offers are blocked.
  /// 4. Idempotency key is retained on ambiguous failure for retries of the same logical attempt.
  /// 5. Never treats `operationalStatus == 'RESERVED'` as proof that a specific offer was accepted.
  /// 6. Only claims success when the backend returns an authoritative 200 response with AcceptOfferResponse.
  /// 7. Coordinated post-accept refresh updates status and offers without clashing.
  Future<bool> acceptOffer(String offerId, {DriverRepository? repository}) async {
    final repo = repository ?? driverRepository;
    if (repo == null || _isProcessingAction) return false;

    // Reject offer acceptance if already actively assigned
    if (_status?.operationalStatus == 'RESERVED') return false;

    // Prevent starting conflicting acceptances while another offer is unresolved
    if (_unresolvedOfferId != null && _unresolvedOfferId != offerId) {
      _offersError =
          'Another offer acceptance is unresolved. Please resolve or retry the previous offer.';
      notifyListeners();
      return false;
    }

    final isRetryOfUnresolved = _unresolvedOfferId == offerId;
    final offerIndex = _offers.indexWhere((o) => o.id == offerId);
    if (offerIndex == -1 && !isRetryOfUnresolved) return false;

    if (offerIndex != -1) {
      final targetOffer = _offers[offerIndex];
      if (targetOffer.isActionPending || targetOffer.isExpired) return false;
    }

    final sessionGen = _sessionGeneration;
    final sessionUser = _currentUserId;
    final requestGen = ++_actionRequestGeneration;

    _isProcessingAction = true;
    _actionSuccessMessage = null;
    if (offerIndex != -1) {
      _offers = [
        for (int i = 0; i < _offers.length; i++)
          if (i == offerIndex)
            _offers[i].copyWith(status: DispatchOfferStatus.accepting)
          else
            _offers[i],
      ];
    }
    notifyListeners();

    final idempotencyKey = _offerIdempotencyKeys.putIfAbsent(
      offerId,
      () => const Uuid().v4(),
    );

    try {
      final response = await repo.acceptOffer(
        offerId: offerId,
        idempotencyKey: idempotencyKey,
      );
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _actionRequestGeneration) {
        return false;
      }

      // Successful authoritative 200 acceptance: clear unresolved state & prune key
      _unresolvedOfferId = null;
      _offerIdempotencyKeys.remove(offerId);
      _actionSuccessMessage = 'Offer accepted successfully!';
      _offersError = null;
      _activeTripId = response.tripId;
      _lastAcceptedOffer = response;

      if (_status != null) {
        _status = DriverStatusResponse(
          id: _status!.id,
          verificationStatus: _status!.verificationStatus,
          operationalStatus: 'RESERVED',
          isOnline: _status!.isOnline,
          vehiclesCount: _status!.vehiclesCount,
        );
      }

      // Coordinated post-accept reconciliation (no cross-invalidation)
      await _reconcileAfterSuccessfulAccept(
        repo: repo,
        sessionGen: sessionGen,
        sessionUser: sessionUser,
      );

      return true;
    } catch (e) {
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _actionRequestGeneration) {
        return false;
      }
      final actionError = e is ApiException ? e.message : e.toString();

      final isAmbiguous = (e is ApiException &&
              (e.statusCode == null ||
                  e.statusCode == 502 ||
                  e.statusCode == 503 ||
                  e.statusCode == 504 ||
                  e.errorCode == 'NETWORK_UNAVAILABLE' ||
                  e.errorCode == 'REQUEST_TIMEOUT')) ||
          e is! ApiException;

      // Reconcile remaining offers to show current visible state
      await _fetchOffersInternal(
        repo: repo,
        sessionGen: sessionGen,
        sessionUser: sessionUser,
      );

      // Restore offer status to pending if still present and stuck in accepting
      _offers = [
        for (final o in _offers)
          if (o.id == offerId && o.status == DispatchOfferStatus.accepting)
            o.copyWith(status: DispatchOfferStatus.pending)
          else
            o,
      ];

      if (isAmbiguous) {
        // Ambiguous failure: never treat RESERVED as proof of this offer.
        // Retain original idempotency key for retry of the same logical attempt.
        _unresolvedOfferId = offerId;
        _offersError =
            'Acceptance outcome could not be confirmed. Please check your network and retry.';
        return false;
      }

      // Definitive failure: clear unresolved state and prune idempotency key
      if (_unresolvedOfferId == offerId) {
        _unresolvedOfferId = null;
      }
      _offerIdempotencyKeys.remove(offerId);
      _offersError = actionError;
      return false;
    } finally {
      if (_isCurrentSession(sessionGen, sessionUser) &&
          requestGen == _actionRequestGeneration) {
        _isProcessingAction = false;
        notifyListeners();
      }
    }
  }

  /// Retries accepting the current unresolved offer using the original offer ID
  /// and identical idempotency key, even if the offer is no longer in pending offers.
  Future<bool> retryUnresolvedOffer({DriverRepository? repository}) async {
    final unresolvedId = _unresolvedOfferId;
    if (unresolvedId == null) return false;
    return acceptOffer(unresolvedId, repository: repository);
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

    final sessionGen = _sessionGeneration;
    final sessionUser = _currentUserId;
    final requestGen = ++_actionRequestGeneration;

    _isProcessingAction = true;
    _actionSuccessMessage = null;
    _offers = [
      for (int i = 0; i < _offers.length; i++)
        if (i == offerIndex)
          _offers[i].copyWith(status: DispatchOfferStatus.declining)
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
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _actionRequestGeneration) {
        return false;
      }

      _offerIdempotencyKeys.remove('reject_$offerId');
      _offers = _offers.where((o) => o.id != offerId).toList();
      if (_offers.isEmpty) {
        _inboxState = DispatchInboxState.empty;
        _cancelCountdownTimer();
      }
      return true;
    } catch (e) {
      if (!_isCurrentSession(sessionGen, sessionUser) ||
          requestGen != _actionRequestGeneration) {
        return false;
      }
      final actionError = e is ApiException ? e.message : e.toString();

      final isAmbiguous = (e is ApiException &&
              (e.statusCode == null ||
                  e.statusCode == 502 ||
                  e.statusCode == 503 ||
                  e.statusCode == 504 ||
                  e.errorCode == 'NETWORK_UNAVAILABLE' ||
                  e.errorCode == 'REQUEST_TIMEOUT')) ||
          e is! ApiException;

      await _fetchOffersInternal(
        repo: repo,
        sessionGen: sessionGen,
        sessionUser: sessionUser,
      );

      // Restore offer status to pending if still present and stuck in declining
      _offers = [
        for (final o in _offers)
          if (o.id == offerId && o.status == DispatchOfferStatus.declining)
            o.copyWith(status: DispatchOfferStatus.pending)
          else
            o,
      ];

      final stillPresent = _offers.any((o) => o.id == offerId);
      if (isAmbiguous) {
        if (!stillPresent) {
          // If rejection fails ambiguously and offer is no longer in pending offers,
          // do not automatically claim success. Show neutral message and preserve idempotency key.
          _offersError =
              'Offer is no longer pending. Final outcome could not be confirmed.';
        } else {
          _offersError =
              'Rejection outcome could not be confirmed. Please check your network and retry.';
        }
        return false;
      }

      _offerIdempotencyKeys.remove('reject_$offerId');
      _offersError = actionError;
      return false;
    } finally {
      if (_isCurrentSession(sessionGen, sessionUser) &&
          requestGen == _actionRequestGeneration) {
        _isProcessingAction = false;
        notifyListeners();
      }
    }
  }

  /// Single coordinated reconciliation method for status and offers after successful acceptance.
  Future<void> _reconcileAfterSuccessfulAccept({
    required DriverRepository repo,
    required int sessionGen,
    required String? sessionUser,
  }) async {
    try {
      final results = await Future.wait([
        repo.getDriverStatus(),
        repo.getPendingOffers(),
      ]);
      if (!_isCurrentSession(sessionGen, sessionUser)) return;

      _status = results[0] as DriverStatusResponse;
      final pendingOffers = results[1] as List<DriverDispatchOffer>;

      if (pendingOffers.isEmpty) {
        _inboxState = DispatchInboxState.empty;
        _offers = const [];
        _cancelCountdownTimer();
      } else {
        _inboxState = DispatchInboxState.ready;
        _offers = pendingOffers.map((o) => o.toPresentationItem()).toList();
        _startCountdownTimer();
      }
    } catch (_) {
      // Maintain local RESERVED status if post-accept refresh encounters an issue
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

  void clearActionSuccessMessage() {
    _actionSuccessMessage = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _cancelCountdownTimer();
    _locationTracker.dispose();
    super.dispose();
  }
}
