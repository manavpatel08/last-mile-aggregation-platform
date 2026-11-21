import 'package:flutter/foundation.dart';

/// Typed representation of driver operational readiness and online state
/// returned by `GET /api/v1/drivers/status`.
@immutable
class DriverStatusResponse {
  const DriverStatusResponse({
    required this.id,
    required this.verificationStatus,
    required this.operationalStatus,
    required this.isOnline,
    required this.vehiclesCount,
  });

  factory DriverStatusResponse.fromJson(Map<String, dynamic> json) {
    final rawId = json['id'];
    if (rawId == null || rawId is! String || rawId.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid driver profile id in DriverStatusResponse',
      );
    }

    final rawVerificationStatus = json['verificationStatus'];
    if (rawVerificationStatus == null ||
        rawVerificationStatus is! String ||
        rawVerificationStatus.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid verificationStatus in DriverStatusResponse',
      );
    }

    final rawOperationalStatus = json['operationalStatus'];
    if (rawOperationalStatus == null ||
        rawOperationalStatus is! String ||
        rawOperationalStatus.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid operationalStatus in DriverStatusResponse',
      );
    }

    final rawIsOnline = json['isOnline'];
    if (rawIsOnline == null || rawIsOnline is! bool) {
      throw const FormatException(
        'Missing or invalid isOnline in DriverStatusResponse',
      );
    }

    final rawVehiclesCount = json['vehiclesCount'];
    if (rawVehiclesCount == null || rawVehiclesCount is! num) {
      throw const FormatException(
        'Missing or invalid vehiclesCount in DriverStatusResponse',
      );
    }

    return DriverStatusResponse(
      id: rawId.trim(),
      verificationStatus: rawVerificationStatus.trim(),
      operationalStatus: rawOperationalStatus.trim(),
      isOnline: rawIsOnline,
      vehiclesCount: rawVehiclesCount.toInt(),
    );
  }

  final String id;
  final String verificationStatus;
  final String operationalStatus;
  final bool isOnline;
  final int vehiclesCount;

  bool get isApproved => verificationStatus == 'APPROVED';
  bool get isAvailable => operationalStatus == 'AVAILABLE';

  Map<String, dynamic> toJson() => {
        'id': id,
        'verificationStatus': verificationStatus,
        'operationalStatus': operationalStatus,
        'isOnline': isOnline,
        'vehiclesCount': vehiclesCount,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DriverStatusResponse &&
          runtimeType == other.runtimeType &&
          id == other.id &&
          verificationStatus == other.verificationStatus &&
          operationalStatus == other.operationalStatus &&
          isOnline == other.isOnline &&
          vehiclesCount == other.vehiclesCount;

  @override
  int get hashCode => Object.hash(
        id,
        verificationStatus,
        operationalStatus,
        isOnline,
        vehiclesCount,
      );
}
