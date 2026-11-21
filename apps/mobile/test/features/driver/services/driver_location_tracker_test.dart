import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/features/driver/services/driver_location_tracker.dart';

import '../../../helpers/test_fakes.dart';

void main() {
  group('FakeDriverLocationTracker', () {
    test('tracks start, stop, and lifecycle transitions deterministically', () {
      final tracker = FakeDriverLocationTracker();
      final repo = FakeDriverRepository();

      expect(tracker.isTracking, isFalse);

      tracker.startTracking(repository: repo);
      expect(tracker.isTracking, isTrue);
      expect(tracker.startCallCount, 1);
      expect(tracker.lastRepository, equals(repo));

      tracker.updateAppLifecycle(AppLifecycleState.paused);
      expect(tracker.lifecycleUpdateCount, 1);
      expect(tracker.lastLifecycleState, AppLifecycleState.paused);

      tracker.updateAppLifecycle(AppLifecycleState.resumed);
      expect(tracker.lifecycleUpdateCount, 2);
      expect(tracker.lastLifecycleState, AppLifecycleState.resumed);

      tracker.stopTracking();
      expect(tracker.isTracking, isFalse);
      expect(tracker.stopCallCount, 1);
      expect(tracker.lastRepository, isNull);
    });

    test('dispose calls stopTracking safely', () {
      final tracker = FakeDriverLocationTracker();
      final repo = FakeDriverRepository();

      tracker.startTracking(repository: repo);
      expect(tracker.isTracking, isTrue);

      tracker.dispose();
      expect(tracker.isTracking, isFalse);
      expect(tracker.stopCallCount, 1);
    });
  });

  group('NoOpDriverLocationTracker', () {
    test('safe no-op execution', () {
      const tracker = NoOpDriverLocationTracker();
      final repo = FakeDriverRepository();

      expect(tracker.isTracking, isFalse);
      tracker.startTracking(repository: repo);
      expect(tracker.isTracking, isFalse);
      tracker.updateAppLifecycle(AppLifecycleState.paused);
      tracker.stopTracking();
      tracker.dispose();
      expect(tracker.isTracking, isFalse);
    });
  });
}
