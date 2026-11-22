import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:geolocator/geolocator.dart';

import '../../../core/realtime/models/realtime_event.dart';
import '../../../core/realtime/socket_service.dart';
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

  /// Updates the active trip context.
  /// When non-null, telemetry switches to 4s cadence; when null, 10s idle cadence.
  void setActiveTripId(String? tripId);

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
  void setActiveTripId(String? tripId) {}

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
/// 7. Every tracking session is strictly isolated by [_currentSessionId] and [_inFlightOperationId]
///    to eliminate stop/restart race conditions.
/// 8. Single periodic timer: switches seamlessly between 10s idle and 4s in-trip cadence.
/// 9. Streams telemetry over Socket.IO when connected, suppressing duplicate REST calls.
///    Falls back to REST sequentially if socket is disconnected or emit fails/times out.
class GeolocatorDriverLocationTracker implements DriverLocationTracker {
  GeolocatorDriverLocationTracker({
    Duration? reportInterval,
    Duration? idleInterval,
    this.inTripInterval = const Duration(seconds: 4),
    LocationPlatformService? platformService,
    this.socketService,
  })  : idleInterval = idleInterval ?? reportInterval ?? const Duration(seconds: 10),
        _platformService = platformService ?? const GeolocatorPlatformService();

  final Duration idleInterval;
  final Duration inTripInterval;
  final LocationPlatformService _platformService;
  final SocketService? socketService;

  DriverRepository? _repository;
  Timer? _timer;
  bool _isTracking = false;
  AppLifecycleState _lifecycleState = AppLifecycleState.resumed;
  String? _activeTripId;

  // Session & Operation Isolation (prevents stop/restart race)
  int _currentSessionId = 0;
  int _operationCounter = 0;
  int? _inFlightOperationId;

  bool _hasPromptedPermission = false;
  LocationPermission? _lastPermission;
  bool _lastLocationServiceEnabled = true;

  @override
  bool get isTracking => _isTracking;

  LocationPermission? get lastPermission => _lastPermission;
  bool get lastLocationServiceEnabled => _lastLocationServiceEnabled;
  bool get isReportingLocation => _inFlightOperationId != null;
  String? get activeTripId => _activeTripId;

  @override
  void setActiveTripId(String? tripId) {
    if (_activeTripId == tripId) return;
    _activeTripId = tripId;
    if (_isTracking && _lifecycleState == AppLifecycleState.resumed) {
      _startPeriodicTimer(_currentSessionId);
    }
  }

  @override
  void startTracking({required DriverRepository repository}) {
    final sessionId = ++_currentSessionId;
    _repository = repository;
    _isTracking = true;

    if (_lifecycleState == AppLifecycleState.resumed) {
      _startPeriodicTimer(sessionId);
      _reportCurrentFix(sessionId);
    }
  }

  @override
  void stopTracking() {
    _currentSessionId++;
    _inFlightOperationId = null;
    _isTracking = false;
    _activeTripId = null;
    _cancelTimer();
    _repository = null;
  }

  @override
  void updateAppLifecycle(AppLifecycleState state) {
    _lifecycleState = state;

    if (!_isTracking) return;

    final sessionId = _currentSessionId;
    if (state == AppLifecycleState.resumed) {
      _startPeriodicTimer(sessionId);
      _reportCurrentFix(sessionId);
    } else {
      _cancelTimer();
    }
  }

  @override
  Future<void> retryPermission() async {
    _hasPromptedPermission = false;
    if (_isTracking && _lifecycleState == AppLifecycleState.resumed) {
      await _reportCurrentFix(_currentSessionId);
    }
  }

  void _startPeriodicTimer(int sessionId) {
    _cancelTimer();
    final interval = _activeTripId != null ? inTripInterval : idleInterval;
    _timer = Timer.periodic(interval, (_) {
      _reportCurrentFix(sessionId);
    });
  }

  void _cancelTimer() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _reportCurrentFix(int sessionId) async {
    if (!_isTracking ||
        _currentSessionId != sessionId ||
        _lifecycleState != AppLifecycleState.resumed) {
      return;
    }
    final repo = _repository;
    if (repo == null) return;

    if (_inFlightOperationId != null) {
      // Overlapping fix in flight for this session: skip
      return;
    }

    final operationId = ++_operationCounter;
    _inFlightOperationId = operationId;

    try {
      final serviceEnabled = await _platformService.isLocationServiceEnabled();
      _lastLocationServiceEnabled = serviceEnabled;
      if (!_isTracking ||
          _currentSessionId != sessionId ||
          _lifecycleState != AppLifecycleState.resumed ||
          _repository == null) {
        return;
      }
      if (!serviceEnabled) {
        return;
      }

      LocationPermission permission = await _platformService.checkPermission();
      if (!_isTracking ||
          _currentSessionId != sessionId ||
          _lifecycleState != AppLifecycleState.resumed ||
          _repository == null) {
        return;
      }
      _lastPermission = permission;

      if (permission == LocationPermission.denied) {
        if (!_hasPromptedPermission) {
          _hasPromptedPermission = true;
          permission = await _platformService.requestPermission();
          if (!_isTracking ||
              _currentSessionId != sessionId ||
              _lifecycleState != AppLifecycleState.resumed ||
              _repository == null) {
            return;
          }
          _lastPermission = permission;
        } else {
          return;
        }
      }

      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return;
      }

      final position = await _platformService.getCurrentPosition();
      if (!_isTracking ||
          _currentSessionId != sessionId ||
          _lifecycleState != AppLifecycleState.resumed ||
          _repository == null) {
        return;
      }

      // Sequential transport dispatch: Socket first, fallback to REST on failure/timeout
      bool socketDelivered = false;
      final socket = socketService;
      if (socket != null && socket.isConnected) {
        try {
          final payload = DriverLocationUpdatePayload(
            latitude: position.latitude,
            longitude: position.longitude,
            heading: position.heading >= 0 ? position.heading : null,
            speed: position.speed >= 0 ? position.speed : null,
            tripId: _activeTripId,
          );
          socketDelivered = await socket.emitLocationUpdate(payload);
        } catch (_) {
          socketDelivered = false;
        }
      }

      // Suppress REST if socket acknowledged; otherwise sequential REST fallback
      if (!socketDelivered && _repository != null) {
        await _repository!.reportLocation(
          latitude: position.latitude,
          longitude: position.longitude,
          heading: position.heading >= 0 ? position.heading : null,
          speed: position.speed >= 0 ? position.speed : null,
        );
      }
    } catch (_) {
      // Safe telemetry absorption: network/GPS failure absorbed safely
    } finally {
      // Stale operation protection: old operation never clears a newer session's in-flight state
      if (_currentSessionId == sessionId && _inFlightOperationId == operationId) {
        _inFlightOperationId = null;
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
  String? activeTripId;
  int setActiveTripIdCallCount = 0;

  @override
  bool get isTracking => _isTracking;

  @override
  void setActiveTripId(String? tripId) {
    setActiveTripIdCallCount++;
    activeTripId = tripId;
  }

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
    activeTripId = null;
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
