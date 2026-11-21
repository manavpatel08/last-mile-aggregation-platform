import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:lastmile_mobile/features/driver/services/driver_location_tracker.dart';

import '../../../helpers/test_fakes.dart';

class TestLocationPlatformService implements LocationPlatformService {
  bool serviceEnabled = true;
  LocationPermission currentPermission = LocationPermission.whileInUse;
  LocationPermission permissionToGrantOnRequest = LocationPermission.whileInUse;

  int isServiceEnabledCallCount = 0;
  int checkPermissionCallCount = 0;
  int requestPermissionCallCount = 0;
  int getPositionCallCount = 0;

  Completer<Position>? positionCompleter;
  Position? nextPosition;

  @override
  Future<bool> isLocationServiceEnabled() async {
    isServiceEnabledCallCount++;
    return serviceEnabled;
  }

  @override
  Future<LocationPermission> checkPermission() async {
    checkPermissionCallCount++;
    return currentPermission;
  }

  @override
  Future<LocationPermission> requestPermission() async {
    requestPermissionCallCount++;
    currentPermission = permissionToGrantOnRequest;
    return currentPermission;
  }

  @override
  Future<Position> getCurrentPosition({LocationSettings? locationSettings}) async {
    getPositionCallCount++;
    if (positionCompleter != null) {
      return await positionCompleter!.future;
    }
    return nextPosition ??
        Position(
          longitude: 72.6668,
          latitude: 23.1550,
          timestamp: DateTime.now(),
          accuracy: 5.0,
          altitude: 0.0,
          altitudeAccuracy: 0.0,
          heading: 90.0,
          headingAccuracy: 0.0,
          speed: 15.0,
          speedAccuracy: 0.0,
        );
  }
}

void main() {
  group('GeolocatorDriverLocationTracker Production Tracker', () {
    late TestLocationPlatformService platformService;
    late FakeDriverRepository fakeRepo;
    late GeolocatorDriverLocationTracker tracker;

    setUp(() {
      platformService = TestLocationPlatformService();
      fakeRepo = FakeDriverRepository();
      tracker = GeolocatorDriverLocationTracker(
        reportInterval: const Duration(milliseconds: 100),
        platformService: platformService,
      );
    });

    tearDown(() {
      tracker.dispose();
    });

    test('1. Permission granted: reports location to repository', () async {
      platformService.currentPermission = LocationPermission.whileInUse;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(tracker.isTracking, isTrue);
      expect(platformService.isServiceEnabledCallCount, 1);
      expect(platformService.checkPermissionCallCount, 1);
      expect(platformService.getPositionCallCount, 1);
      expect(fakeRepo.reportLocationCallCount, 1);
      expect(fakeRepo.lastReportedLocation?['latitude'], 23.1550);
      expect(fakeRepo.lastReportedLocation?['longitude'], 72.6668);
      expect(fakeRepo.lastReportedLocation?['heading'], 90.0);
      expect(fakeRepo.lastReportedLocation?['speed'], 15.0);
    });

    test('2. Permission denied initially: requests permission once and reports when granted', () async {
      platformService.currentPermission = LocationPermission.denied;
      platformService.permissionToGrantOnRequest = LocationPermission.whileInUse;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(platformService.requestPermissionCallCount, 1);
      expect(fakeRepo.reportLocationCallCount, 1);
    });

    test('3. Permission denied: does not repeatedly call requestPermission on subsequent timer ticks', () async {
      platformService.currentPermission = LocationPermission.denied;
      platformService.permissionToGrantOnRequest = LocationPermission.denied;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 250)); // Multiple ticks

      expect(platformService.requestPermissionCallCount, 1);
      expect(platformService.checkPermissionCallCount, greaterThanOrEqualTo(2));
      expect(fakeRepo.reportLocationCallCount, 0);
    });

    test('4. Permission denied forever: does not request permission or report', () async {
      platformService.currentPermission = LocationPermission.deniedForever;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(platformService.requestPermissionCallCount, 0);
      expect(platformService.getPositionCallCount, 0);
      expect(fakeRepo.reportLocationCallCount, 0);
    });

    test('5. Location services disabled: does not query permission or report', () async {
      platformService.serviceEnabled = false;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(platformService.isServiceEnabledCallCount, 1);
      expect(platformService.checkPermissionCallCount, 0);
      expect(fakeRepo.reportLocationCallCount, 0);
    });

    test('6. Backgrounding and resuming: stops timer on paused, resumes on resumed', () async {
      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(fakeRepo.reportLocationCallCount, 1);

      // App moves to background
      tracker.updateAppLifecycle(AppLifecycleState.paused);
      await Future<void>.delayed(const Duration(milliseconds: 150));
      // No extra reports while backgrounded
      expect(fakeRepo.reportLocationCallCount, 1);

      // App returns to foreground
      tracker.updateAppLifecycle(AppLifecycleState.resumed);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(fakeRepo.reportLocationCallCount, 2);
    });

    test('7. Stopping tracking during in-flight location request drops the fix', () async {
      final positionCompleter = Completer<Position>();
      platformService.positionCompleter = positionCompleter;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(platformService.getPositionCallCount, 1);
      expect(fakeRepo.reportLocationCallCount, 0);

      // Driver goes offline or stops tracking while GPS fix is acquiring
      tracker.stopTracking();
      expect(tracker.isTracking, isFalse);

      // Delayed position finally returns
      positionCompleter.complete(
        Position(
          longitude: 72.6668,
          latitude: 23.1550,
          timestamp: DateTime.now(),
          accuracy: 5.0,
          altitude: 0.0,
          altitudeAccuracy: 0.0,
          heading: 90.0,
          headingAccuracy: 0.0,
          speed: 15.0,
          speedAccuracy: 0.0,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // Verifies generation check dropped the obsolete fix!
      expect(fakeRepo.reportLocationCallCount, 0);
    });

    test('8. Logout / account switch during in-flight operation drops telemetry', () async {
      final positionCompleter = Completer<Position>();
      platformService.positionCompleter = positionCompleter;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // Logout triggers stopTracking
      tracker.stopTracking();

      positionCompleter.complete(
        Position(
          longitude: 72.6668,
          latitude: 23.1550,
          timestamp: DateTime.now(),
          accuracy: 5.0,
          altitude: 0.0,
          altitudeAccuracy: 0.0,
          heading: 90.0,
          headingAccuracy: 0.0,
          speed: 15.0,
          speedAccuracy: 0.0,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(fakeRepo.reportLocationCallCount, 0);
    });

    test('9. Overlapping timer ticks: in-flight request prevents duplicate concurrent queries', () async {
      final positionCompleter = Completer<Position>();
      platformService.positionCompleter = positionCompleter;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 250)); // Several ticks elapsed

      // Only 1 position query in flight because overlapping ticks were guarded!
      expect(platformService.getPositionCallCount, 1);

      positionCompleter.complete(
        Position(
          longitude: 72.6668,
          latitude: 23.1550,
          timestamp: DateTime.now(),
          accuracy: 5.0,
          altitude: 0.0,
          altitudeAccuracy: 0.0,
          heading: 90.0,
          headingAccuracy: 0.0,
          speed: 15.0,
          speedAccuracy: 0.0,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(fakeRepo.reportLocationCallCount, 1);
    });

    test('10. API telemetry failure is absorbed safely without throwing', () async {
      fakeRepo.shouldThrowOnReportLocation = true;
      fakeRepo.reportLocationException = Exception('Network error during GPS report');

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(fakeRepo.reportLocationCallCount, 1);
      expect(tracker.isTracking, isTrue); // Tracker remains alive
    });

    test('11. retryPermission resets permission prompted state', () async {
      platformService.currentPermission = LocationPermission.denied;
      platformService.permissionToGrantOnRequest = LocationPermission.denied;

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(platformService.requestPermissionCallCount, 1);

      // Now user opens settings and grants
      platformService.permissionToGrantOnRequest = LocationPermission.whileInUse;
      await tracker.retryPermission();
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(platformService.requestPermissionCallCount, 2);
      expect(fakeRepo.reportLocationCallCount, 1);
    });

    test('12. Stop tracking during in-flight fix and restart new session: old fix is dropped, new session reports cleanly', () async {
      final oldPositionCompleter = Completer<Position>();
      platformService.positionCompleter = oldPositionCompleter;

      // Session 1 starts
      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(platformService.getPositionCallCount, 1);
      expect(fakeRepo.reportLocationCallCount, 0);

      // Session 1 stopped while fix is pending
      tracker.stopTracking();
      expect(tracker.isTracking, isFalse);

      // Session 2 starts with a fresh repository before old fix completes
      final secondRepo = FakeDriverRepository();
      platformService.positionCompleter = null; // Next call will return immediate position
      platformService.nextPosition = Position(
        longitude: 72.6670,
        latitude: 23.1560,
        timestamp: DateTime.now(),
        accuracy: 5.0,
        altitude: 0.0,
        altitudeAccuracy: 0.0,
        heading: 180.0,
        headingAccuracy: 0.0,
        speed: 20.0,
        speedAccuracy: 0.0,
      );

      tracker.startTracking(repository: secondRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // Session 2 successfully reported its own fix
      expect(secondRepo.reportLocationCallCount, 1);
      expect(secondRepo.lastReportedLocation?['latitude'], 23.1560);
      expect(secondRepo.lastReportedLocation?['longitude'], 72.6670);

      // Now old position from Session 1 finally completes
      oldPositionCompleter.complete(
        Position(
          longitude: 72.6600,
          latitude: 23.1500,
          timestamp: DateTime.now(),
          accuracy: 5.0,
          altitude: 0.0,
          altitudeAccuracy: 0.0,
          heading: 0.0,
          headingAccuracy: 0.0,
          speed: 0.0,
          speedAccuracy: 0.0,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // Old session fix was dropped: neither first repo nor second repo received the stale fix
      expect(fakeRepo.reportLocationCallCount, 0);
      expect(secondRepo.reportLocationCallCount, 1);
    });

    test('13. Temporary telemetry failure clears in-flight state and allows subsequent successful report', () async {
      fakeRepo.shouldThrowOnReportLocation = true;
      fakeRepo.reportLocationException = Exception('Transient connection failure');

      tracker.startTracking(repository: fakeRepo);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(fakeRepo.reportLocationCallCount, 1);
      // Ensure in-flight operation flag was cleared even after exception
      expect(tracker.isReportingLocation, isFalse);

      // Network recovers before next timer tick
      fakeRepo.shouldThrowOnReportLocation = false;
      await Future<void>.delayed(const Duration(milliseconds: 120));

      // Subsequent periodic tick succeeds cleanly
      expect(fakeRepo.reportLocationCallCount, greaterThanOrEqualTo(2));
    });
  });

  group('FakeDriverLocationTracker & NoOpDriverLocationTracker', () {
    test('FakeDriverLocationTracker tracks calls deterministically', () async {
      final tracker = FakeDriverLocationTracker();
      final repo = FakeDriverRepository();

      tracker.startTracking(repository: repo);
      expect(tracker.isTracking, isTrue);
      expect(tracker.startCallCount, 1);

      await tracker.retryPermission();
      expect(tracker.retryPermissionCallCount, 1);

      tracker.stopTracking();
      expect(tracker.isTracking, isFalse);
      expect(tracker.stopCallCount, 1);
    });

    test('NoOpDriverLocationTracker safe no-op execution', () async {
      const tracker = NoOpDriverLocationTracker();
      final repo = FakeDriverRepository();

      tracker.startTracking(repository: repo);
      expect(tracker.isTracking, isFalse);
      await tracker.retryPermission();
      tracker.stopTracking();
      tracker.dispose();
      expect(tracker.isTracking, isFalse);
    });
  });
}
