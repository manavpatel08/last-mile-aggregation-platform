import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:geolocator/geolocator.dart';

import '../data/driver_repository.dart';

/// Platform abstraction for location services, isolating native [Geolocator]
/// calls for unit testing and deterministic simulation.
abstract class LocationPlatformService {
  Future<bool> isLocationServiceEnabled();
  Future<LocationPermission> checkPermission();
  Future<LocationPermission> requestPermission();
  Future<Position> getCurrentPosition({LocationSettings? locationSettings});
}

/// Production implementation of [LocationPlatformService] invoking native [Geolocator].
class GeolocatorPlatformService implements LocationPlatformService {
  const GeolocatorPlatformService();

  @override
  Future<bool> isLocationServiceEnabled() => Geolocator.isLocationServiceEnabled();

  @override
  Future<LocationPermission> checkPermission() => Geolocator.checkPermission();

  @override
  Future<LocationPermission> requestPermission() => Geolocator.requestPermission();

  @override
  Future<Position> getCurrentPosition({LocationSettings? locationSettings}) =>
      Geolocator.getCurrentPosition(
        locationSettings: locationSettings ??
            const LocationSettings(
              accuracy: LocationAccuracy.high,
              timeLimit: Duration(seconds: 5),
            ),
      );
}

/// Contract managing periodic foreground GPS telemetry reporting for online drivers.
abstract class DriverLocationTracker {
  /// Begins foreground periodic GPS telemetry reporting.
  void startTracking({required DriverRepository repository});

  /// Immediately stops GPS telemetry reporting.
  void stopTracking();

  /// Updates current application lifecycle state to enforce foreground-only reporting.
  void updateAppLifecycle(AppLifecycleState state);

  /// Explicitly re-checks and requests location permission (recovery path).
  Future<void> retryPermission();

  /// Whether GPS telemetry reporting is currently active.
  bool get isTracking;

  /// Releases resources.
  void dispose();
}

/// Safe no-op implementation of [DriverLocationTracker] used when location tracking
/// is disabled or in unit/widget test environments without native location services.
class NoOpDriverLocationTracker implements DriverLocationTracker {
  const NoOpDriverLocationTracker();

  @override
  bool get isTracking => false;

  @override
  void startTracking({required DriverRepository repository}) {}

  @override
  void stopTracking() {}

  @override
  void updateAppLifecycle(AppLifecycleState state) {}

  @override
  Future<void> retryPermission() async {}

  @override
  void dispose() {}
}

/// Production implementation of [DriverLocationTracker] using [GeolocatorPlatformService].
///
/// Guardrails:
/// 1. Runs strictly while driver is online and app lifecycle is [AppLifecycleState.resumed].
/// 2. Stops tracking on offline, logout, account switch, or backgrounding.
/// 3. Does NOT implement background location tracking.
/// 4. Catches permission denials and transient telemetry errors without throwing uncaught exceptions.
/// 5. Never repeatedly prompts for permissions on periodic ticks after initial denial.
/// 6. Guards against overlapping in-flight location fixes.
/// 7. Checks operation generation tokens across async points to drop obsolete fixes.
class GeolocatorDriverLocationTracker implements DriverLocationTracker {
  GeolocatorDriverLocationTracker({
    this.reportInterval = const Duration(seconds: 10),
    LocationPlatformService? platformService,
  }) : _platformService = platformService ?? const GeolocatorPlatformService();

  final Duration reportInterval;
  final LocationPlatformService _platformService;

  DriverRepository? _repository;
  Timer? _timer;
  bool _isTracking = false;
  AppLifecycleState _lifecycleState = AppLifecycleState.resumed;

  bool _isReportingLocation = false;
  int _trackingGeneration = 0;
  bool _hasPromptedPermission = false;
  LocationPermission? _lastPermission;
  bool _lastLocationServiceEnabled = true;

  @override
  bool get isTracking => _isTracking;

  LocationPermission? get lastPermission => _lastPermission;
  bool get lastLocationServiceEnabled => _lastLocationServiceEnabled;
  bool get isReportingLocation => _isReportingLocation;

  @override
  void startTracking({required DriverRepository repository}) {
    _repository = repository;
    _isTracking = true;
    _trackingGeneration++;

    if (_lifecycleState == AppLifecycleState.resumed) {
      _startPeriodicTimer();
      _reportCurrentFix();
    }
  }

  @override
  void stopTracking() {
    _isTracking = false;
    _trackingGeneration++;
    _cancelTimer();
    _repository = null;
    _isReportingLocation = false;
  }

  @override
  void updateAppLifecycle(AppLifecycleState state) {
    _lifecycleState = state;

    if (!_isTracking) return;

    if (state == AppLifecycleState.resumed) {
      _startPeriodicTimer();
      _reportCurrentFix();
    } else {
      _cancelTimer();
    }
  }

  @override
  Future<void> retryPermission() async {
    _hasPromptedPermission = false;
    if (_isTracking && _lifecycleState == AppLifecycleState.resumed) {
      await _reportCurrentFix();
    }
  }

  void _startPeriodicTimer() {
    _cancelTimer();
    _timer = Timer.periodic(reportInterval, (_) {
      _reportCurrentFix();
    });
  }

  void _cancelTimer() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _reportCurrentFix() async {
    final repo = _repository;
    if (repo == null || !_isTracking || _lifecycleState != AppLifecycleState.resumed) {
      return;
    }
    if (_isReportingLocation) {
      // Prevent overlapping location requests
      return;
    }

    final currentGen = _trackingGeneration;
    _isReportingLocation = true;

    try {
      final serviceEnabled = await _platformService.isLocationServiceEnabled();
      _lastLocationServiceEnabled = serviceEnabled;
      if (!_isTracking ||
          _lifecycleState != AppLifecycleState.resumed ||
          _trackingGeneration != currentGen ||
          _repository == null) {
        return;
      }
      if (!serviceEnabled) {
        return;
      }

      LocationPermission permission = await _platformService.checkPermission();
      if (!_isTracking ||
          _lifecycleState != AppLifecycleState.resumed ||
          _trackingGeneration != currentGen ||
          _repository == null) {
        return;
      }
      _lastPermission = permission;

      if (permission == LocationPermission.denied) {
        if (!_hasPromptedPermission) {
          _hasPromptedPermission = true;
          permission = await _platformService.requestPermission();
          if (!_isTracking ||
              _lifecycleState != AppLifecycleState.resumed ||
              _trackingGeneration != currentGen ||
              _repository == null) {
            return;
          }
          _lastPermission = permission;
        } else {
          // Do not repeatedly prompt the driver on every periodic tick
          return;
        }
      }

      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return;
      }

      final position = await _platformService.getCurrentPosition();
      if (!_isTracking ||
          _lifecycleState != AppLifecycleState.resumed ||
          _trackingGeneration != currentGen ||
          _repository == null) {
        return;
      }

      await _repository!.reportLocation(
        latitude: position.latitude,
        longitude: position.longitude,
        heading: position.heading >= 0 ? position.heading : null,
        speed: position.speed >= 0 ? position.speed : null,
      );
    } catch (_) {
      // Safe telemetry absorption: network or GPS errors must never crash the app
    } finally {
      if (_trackingGeneration == currentGen) {
        _isReportingLocation = false;
      }
    }
  }

  @override
  void dispose() {
    stopTracking();
  }
}

/// Deterministic fake implementation of [DriverLocationTracker] for testing.
class FakeDriverLocationTracker implements DriverLocationTracker {
  FakeDriverLocationTracker({bool initialTracking = false})
      : _isTracking = initialTracking;

  bool _isTracking;
  DriverRepository? lastRepository;
  int startCallCount = 0;
  int stopCallCount = 0;
  int lifecycleUpdateCount = 0;
  int retryPermissionCallCount = 0;
  AppLifecycleState lastLifecycleState = AppLifecycleState.resumed;

  @override
  bool get isTracking => _isTracking;

  @override
  void startTracking({required DriverRepository repository}) {
    startCallCount++;
    _isTracking = true;
    lastRepository = repository;
  }

  @override
  void stopTracking() {
    stopCallCount++;
    _isTracking = false;
    lastRepository = null;
  }

  @override
  void updateAppLifecycle(AppLifecycleState state) {
    lifecycleUpdateCount++;
    lastLifecycleState = state;
  }

  @override
  Future<void> retryPermission() async {
    retryPermissionCallCount++;
  }

  @override
  void dispose() {
    stopTracking();
  }
}
