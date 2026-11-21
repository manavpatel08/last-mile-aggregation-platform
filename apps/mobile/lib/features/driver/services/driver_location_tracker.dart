import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:geolocator/geolocator.dart';

import '../data/driver_repository.dart';

/// Contract managing periodic foreground GPS telemetry reporting for online drivers.
abstract class DriverLocationTracker {
  /// Begins foreground periodic GPS telemetry reporting.
  void startTracking({required DriverRepository repository});

  /// Immediately stops GPS telemetry reporting.
  void stopTracking();

  /// Updates current application lifecycle state to enforce foreground-only reporting.
  void updateAppLifecycle(AppLifecycleState state);

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
  void dispose() {}
}

/// Production implementation of [DriverLocationTracker] using [Geolocator].
///
/// Guardrails:
/// 1. Runs strictly while driver is online and app lifecycle is [AppLifecycleState.resumed].
/// 2. Stops tracking on offline, logout, account switch, or backgrounding.
/// 3. Does NOT implement background location tracking.
/// 4. Catches permission denials and transient telemetry errors without throwing uncaught exceptions.
class GeolocatorDriverLocationTracker implements DriverLocationTracker {
  GeolocatorDriverLocationTracker({
    this.reportInterval = const Duration(seconds: 10),
  });

  final Duration reportInterval;

  DriverRepository? _repository;
  Timer? _timer;
  bool _isTracking = false;
  AppLifecycleState _lifecycleState = AppLifecycleState.resumed;

  @override
  bool get isTracking => _isTracking;

  @override
  void startTracking({required DriverRepository repository}) {
    _repository = repository;
    _isTracking = true;

    if (_lifecycleState == AppLifecycleState.resumed) {
      _startPeriodicTimer();
      _reportCurrentFix();
    }
  }

  @override
  void stopTracking() {
    _isTracking = false;
    _cancelTimer();
    _repository = null;
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

    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) return;

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied) return;
      }

      if (permission == LocationPermission.deniedForever) return;

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 5),
        ),
      );

      if (!_isTracking || _lifecycleState != AppLifecycleState.resumed) return;

      await repo.reportLocation(
        latitude: position.latitude,
        longitude: position.longitude,
        heading: position.heading >= 0 ? position.heading : null,
        speed: position.speed >= 0 ? position.speed : null,
      );
    } catch (_) {
      // Safe absorption: telemetry failures must never crash driver app
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
  void dispose() {
    stopTracking();
  }
}
