/// Result of validating a destination point with the backend.
class DestinationValidationResult {
  const DestinationValidationResult({
    required this.isInsideServiceRegion,
    this.matchedZoneId,
    this.matchedZoneName,
  });

  factory DestinationValidationResult.fromJson(Map<String, dynamic> json) {
    return DestinationValidationResult(
      isInsideServiceRegion: json['isInsideServiceRegion'] as bool? ?? false,
      matchedZoneId: json['matchedZoneId'] as String?,
      matchedZoneName: json['matchedZoneName'] as String?,
    );
  }

  final bool isInsideServiceRegion;
  final String? matchedZoneId;
  final String? matchedZoneName;
}

/// Result of validating a pickup point distance with the backend.
class PickupValidationResult {
  const PickupValidationResult({
    required this.isValid,
    required this.distanceMeters,
    required this.allowedRadiusMeters,
    this.pickupPointName,
  });

  factory PickupValidationResult.fromJson(Map<String, dynamic> json) {
    final pickupPoint = json['pickupPoint'] as Map<String, dynamic>?;
    return PickupValidationResult(
      isValid: json['isValid'] as bool? ?? false,
      distanceMeters: (json['distanceMeters'] as num?)?.toDouble() ?? 0.0,
      allowedRadiusMeters:
          (json['allowedRadiusMeters'] as num?)?.toDouble() ?? 150.0,
      pickupPointName: pickupPoint?['name'] as String?,
    );
  }

  final bool isValid;
  final double distanceMeters;
  final double allowedRadiusMeters;
  final String? pickupPointName;
}
