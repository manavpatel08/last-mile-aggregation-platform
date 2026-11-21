import 'package:flutter/foundation.dart';

import '../../../core/network/api_exception.dart';
import '../data/driver_repository.dart';
import '../models/driver_status_response.dart';
import '../models/driver_vehicle.dart';

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

/// Feature-scoped Provider managing Driver Home presentation and readiness dashboard state.
class DriverHomeProvider extends ChangeNotifier {
  DriverHomeProvider({this.driverRepository});

  final DriverRepository? driverRepository;

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

  bool get isLoading => _isLoading;
  bool get isRefreshing => _isRefreshing;
  String? get error => _error;
  bool get hasError => _error != null;
  DriverStatusResponse? get status => _status;
  List<DriverVehicle> get vehicles => _vehicles;
  int get vehicleCount => _status?.vehiclesCount ?? _vehicles.length;
  bool get isOnline => _status?.isOnline ?? false;
  String get operationalStatus => _status?.operationalStatus ?? 'OFFLINE';
  bool get hasLoaded => _hasLoaded;
  String? get currentUserId => _currentUserId;

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

  /// Clears all user-session and dashboard state across logout or account switch.
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
    notifyListeners();
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

    // Account isolation: If user changed, clear previous user state immediately,
    // reset loading flags, and bump generation so all in-flight requests from the
    // previous account are invalidated and cannot block the new user.
    if (userId != null && userId != _currentUserId) {
      _requestGeneration++;
      _currentUserId = userId;
      _status = null;
      _vehicles = const [];
      _error = null;
      _hasLoaded = false;
      _isLoading = false;
      _isRefreshing = false;
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
      } else {
        // For non-approved drivers (PENDING, REJECTED, SUSPENDED):
        // Never call the approval-protected operational-status endpoint!
        final fetchedVehicles = await repo.getVehicles();
        if (!_isCurrentRequest(requestGen, requestUser)) return;
        _status = null;
        _vehicles = fetchedVehicles;
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
      } else {
        // Preserve existing vehicle data during a failed refresh:
        // Await the vehicle list before updating _vehicles so errors leave existing data intact.
        final updatedVehicles = await repo.getVehicles();
        if (!_isCurrentRequest(requestGen, requestUser)) return;
        _status = null;
        _vehicles = updatedVehicles;
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

  void clearError() {
    _error = null;
    notifyListeners();
  }
}
