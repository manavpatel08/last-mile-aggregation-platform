import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/realtime/backoff_policy.dart';

class _ConstantRandom implements Random {
  _ConstantRandom(this.fixedValue);
  final double fixedValue;

  @override
  double nextDouble() => fixedValue;

  @override
  bool nextBool() => false;

  @override
  int nextInt(int max) => 0;
}

void main() {
  group('ExponentialBackoffPolicy', () {
    test('attempt 0 returns Duration.zero', () {
      final policy = ExponentialBackoffPolicy();
      expect(policy.getDelay(0), Duration.zero);
      expect(policy.getDelay(-1), Duration.zero);
    });

    test('follows schedule [1, 2, 5, 10, 20] capped at 30 with zero jitter', () {
      // fixedValue 0.5 results in (0.5 * 2 * 0.2 - 0.2) = 0.0 -> exact multiplier 1.0
      final policy = ExponentialBackoffPolicy(random: _ConstantRandom(0.5));

      expect(policy.getDelay(1), const Duration(seconds: 1));
      expect(policy.getDelay(2), const Duration(seconds: 2));
      expect(policy.getDelay(3), const Duration(seconds: 5));
      expect(policy.getDelay(4), const Duration(seconds: 10));
      expect(policy.getDelay(5), const Duration(seconds: 20));
      expect(policy.getDelay(6), const Duration(seconds: 30));
      expect(policy.getDelay(10), const Duration(seconds: 30));
    });

    test('applies -20% jitter at lower bound and +20% jitter at upper bound', () {
      // Lower bound: fixedValue 0.0 -> -20%
      final minPolicy = ExponentialBackoffPolicy(random: _ConstantRandom(0.0));
      // Base for attempt 4 is 10s -> -20% is 8s (8000ms)
      expect(minPolicy.getDelay(4), const Duration(milliseconds: 8000));

      // Upper bound: fixedValue 1.0 -> +20%
      final maxPolicy = ExponentialBackoffPolicy(random: _ConstantRandom(1.0));
      // Base for attempt 4 is 10s -> +20% is 12s (12000ms)
      expect(maxPolicy.getDelay(4), const Duration(milliseconds: 12000));
    });

    test('clamps minimum delay to 500ms and maximum delay to 30000ms', () {
      final minPolicy = ExponentialBackoffPolicy(random: _ConstantRandom(0.0));
      // Attempt 1 base is 1000ms -> -20% = 800ms >= 500ms
      expect(minPolicy.getDelay(1).inMilliseconds, greaterThanOrEqualTo(500));

      final maxPolicy = ExponentialBackoffPolicy(random: _ConstantRandom(1.0));
      // Attempt 6 base is 30s -> capped at 30s (30000ms)
      expect(maxPolicy.getDelay(6).inMilliseconds, lessThanOrEqualTo(30000));
    });
  });
}
