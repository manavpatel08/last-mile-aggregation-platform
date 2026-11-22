import 'dart:math';

/// Contract calculating reconnection backoff delay with jitter.
abstract interface class BackoffPolicy {
  /// Returns the delay duration for the specified 1-based attempt.
  Duration getDelay(int attempt);

  /// Resets backoff progression.
  void reset();
}

/// Standard exponential backoff policy:
/// Steps: 1s, 2s, 5s, 10s, 20s, capped at maximum 30s.
/// Random jitter: +/- 20% to prevent thundering herds.
class ExponentialBackoffPolicy implements BackoffPolicy {
  ExponentialBackoffPolicy({
    this.schedule = const [1, 2, 5, 10, 20],
    this.maxSeconds = 30,
    this.jitterRatio = 0.2,
    Random? random,
  }) : _random = random ?? Random();

  final List<int> schedule;
  final int maxSeconds;
  final double jitterRatio;
  final Random _random;

  @override
  Duration getDelay(int attempt) {
    if (attempt <= 0) return Duration.zero;

    final baseSec = attempt <= schedule.length
        ? schedule[attempt - 1]
        : maxSeconds;

    // Apply jitter: +/- jitterRatio
    final jitterMultiplier = 1.0 + (_random.nextDouble() * 2 * jitterRatio - jitterRatio);
    final calculatedMs = (baseSec * 1000 * jitterMultiplier).round();
    final clampedMs = calculatedMs.clamp(500, maxSeconds * 1000);

    return Duration(milliseconds: clampedMs);
  }

  @override
  void reset() {}
}
