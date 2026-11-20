/// Shared estimated fare range.
class SharedFareRange {
  const SharedFareRange({
    required this.minFare,
    required this.maxFare,
  });

  factory SharedFareRange.fromJson(Map<String, dynamic> json) {
    return SharedFareRange(
      minFare: json['minFare']?.toString() ?? '0.00',
      maxFare: json['maxFare']?.toString() ?? '0.00',
    );
  }

  final String minFare;
  final String maxFare;

  Map<String, dynamic> toJson() => {
        'minFare': minFare,
        'maxFare': maxFare,
      };
}

/// 2-minute binding fare quote returned by `POST /api/v1/fares/quotes`.
class FareQuote {
  const FareQuote({
    required this.quoteId,
    required this.pickupPointId,
    required this.pickupPointName,
    required this.directDistanceMeters,
    required this.directDurationSec,
    required this.privateEstimatedFare,
    required this.sharedEstimatedRange,
    required this.agreedFareCeiling,
    required this.tariffVersion,
    required this.expiresAt,
  });

  factory FareQuote.fromJson(Map<String, dynamic> json) {
    return FareQuote(
      quoteId: json['quoteId'] as String,
      pickupPointId: json['pickupPointId'] as String? ?? '',
      pickupPointName: json['pickupPointName'] as String? ?? '',
      directDistanceMeters:
          (json['directDistanceMeters'] as num?)?.toDouble() ?? 0.0,
      directDurationSec: (json['directDurationSec'] as num?)?.toInt() ?? 0,
      privateEstimatedFare:
          json['privateEstimatedFare']?.toString() ?? '0.00',
      sharedEstimatedRange: SharedFareRange.fromJson(
        (json['sharedEstimatedRange'] as Map<String, dynamic>?) ?? const {},
      ),
      agreedFareCeiling: json['agreedFareCeiling']?.toString() ?? '0.00',
      tariffVersion: (json['tariffVersion'] as num?)?.toInt() ?? 1,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }

  final String quoteId;
  final String pickupPointId;
  final String pickupPointName;
  final double directDistanceMeters;
  final int directDurationSec;
  final String privateEstimatedFare;
  final SharedFareRange sharedEstimatedRange;
  final String agreedFareCeiling;
  final int tariffVersion;
  final DateTime expiresAt;

  bool get isExpired => DateTime.now().isAfter(expiresAt);

  Duration get remainingDuration {
    final diff = expiresAt.difference(DateTime.now());
    return diff.isNegative ? Duration.zero : diff;
  }

  Map<String, dynamic> toJson() => {
        'quoteId': quoteId,
        'pickupPointId': pickupPointId,
        'pickupPointName': pickupPointName,
        'directDistanceMeters': directDistanceMeters,
        'directDurationSec': directDurationSec,
        'privateEstimatedFare': privateEstimatedFare,
        'sharedEstimatedRange': sharedEstimatedRange.toJson(),
        'agreedFareCeiling': agreedFareCeiling,
        'tariffVersion': tariffVersion,
        'expiresAt': expiresAt.toIso8601String(),
      };
}
