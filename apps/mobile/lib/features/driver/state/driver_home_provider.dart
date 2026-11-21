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

  String get statusSummary {
    if (_status != null) {
      final onlineText = _status!.isOnline ? 'Online' : 'Offline';
      return 'Operational Status: ${_status!.operationalStatus} ($onlineText). Registered vehicles: $vehicleCount.';
    }
    return 'Driver application foundation is ready. Operational driver access is enforced by backend verification status.';
  }

  /// Loads driver dashboard data (operational status and registered vehicles).
  ///
  /// CRITICAL GUARD (AGENTS.md §1.3 & Requirement 4):
  /// `GET /api/v1/drivers/status` is protected by `@RequireDriverApproval()`.
  /// If [verificationStatus] is not 'APPROVED' (i.e. PENDING, REJECTED, SUSPENDED),
  /// do NOT call `getDriverStatus()`.
  Future<void> loadDashboard({
    required String verificationStatus,
    DriverRepository? repository,
  }) async {
    final repo = repository ?? driverRepository;
    if (repo == null) {
      _error = 'Driver repository not available';
      notifyListeners();
      return;
    }

    if (_isLoading) return;

    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      final isApproved = verificationStatus == 'APPROVED';

      if (isApproved) {
        final results = await Future.wait([
          repo.getDriverStatus(),
          repo.getVehicles(),
        ]);
        _status = results[0] as DriverStatusResponse;
        _vehicles = results[1] as List<DriverVehicle>;
      } else {
        // For non-approved drivers (PENDING, REJECTED, SUSPENDED):
        // Never call the approval-protected operational-status endpoint!
        _status = null;
        try {
          _vehicles = await repo.getVehicles();
        } catch (_) {
          // If vehicle fetch fails for a non-approved candidate, keep list empty safely
          _vehicles = const [];
        }
      }
      _error = null;
      _hasLoaded = true;
    } catch (e) {
      _error = e is ApiException
          ? e.message
          : 'Failed to load driver dashboard: ${e.toString()}';
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  /// Refreshes dashboard data without showing fullscreen loading spinner.
  Future<void> refreshDashboard({
    required String verificationStatus,
    DriverRepository? repository,
  }) async {
    final repo = repository ?? driverRepository;
    if (repo == null || _isRefreshing || _isLoading) return;

    _isRefreshing = true;
    notifyListeners();

    try {
      final isApproved = verificationStatus == 'APPROVED';

      if (isApproved) {
        final results = await Future.wait([
          repo.getDriverStatus(),
          repo.getVehicles(),
        ]);
        _status = results[0] as DriverStatusResponse;
        _vehicles = results[1] as List<DriverVehicle>;
      } else {
        _status = null;
        try {
          _vehicles = await repo.getVehicles();
        } catch (_) {
          _vehicles = const [];
        }
      }
      _error = null;
      _hasLoaded = true;
    } catch (e) {
      _error = e is ApiException
          ? e.message
          : 'Failed to refresh driver dashboard: ${e.toString()}';
    } finally {
      _isRefreshing = false;
      notifyListeners();
    }
  }

  void clearError() {
    _error = null;
    notifyListeners();
  }
}
