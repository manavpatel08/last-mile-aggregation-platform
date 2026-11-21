import 'package:flutter/foundation.dart';

import '../presentation/models/dispatch_offer_item.dart';

/// Pickup point metadata contained in a driver dispatch offer.
@immutable
class DriverPickupPoint {
  const DriverPickupPoint({
    required this.id,
    required this.name,
  });

  factory DriverPickupPoint.fromJson(Map<String, dynamic> json) {
    final rawId = json['id'];
    if (rawId == null || rawId is! String || rawId.trim().isEmpty) {
      throw const FormatException('Missing or invalid id in DriverPickupPoint');
    }
    final rawName = json['name'];
    if (rawName == null || rawName is! String || rawName.trim().isEmpty) {
      throw const FormatException('Missing or invalid name in DriverPickupPoint');
    }
    return DriverPickupPoint(
      id: rawId.trim(),
      name: rawName.trim(),
    );
  }

  final String id;
  final String name;

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DriverPickupPoint &&
          runtimeType == other.runtimeType &&
          id == other.id &&
          name == other.name;

  @override
  int get hashCode => Object.hash(id, name);
}

/// Strict typed model representing a pending driver dispatch offer
/// returned by `GET /api/v1/drivers/offers/pending`.
@immutable
class DriverDispatchOffer {
  const DriverDispatchOffer({
    required this.offerId,
    required this.dispatchAttemptId,
    required this.rideGroupId,
    required this.groupVersion,
    required this.pickupPoint,
    required this.passengerCount,
    required this.totalEstimatedFare,
    required this.totalDistanceMeters,
    required this.totalDurationSec,
    required this.offeredAt,
    required this.expiresAt,
    required this.remainingSeconds,
  });

  factory DriverDispatchOffer.fromJson(Map<String, dynamic> json) {
    final rawOfferId = json['offerId'];
    if (rawOfferId == null || rawOfferId is! String || rawOfferId.trim().isEmpty) {
      throw const FormatException('Missing or invalid offerId in DriverDispatchOffer');
    }

    final rawDispatchAttemptId = json['dispatchAttemptId'];
    if (rawDispatchAttemptId == null ||
        rawDispatchAttemptId is! String ||
        rawDispatchAttemptId.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid dispatchAttemptId in DriverDispatchOffer',
      );
    }

    final rawRideGroupId = json['rideGroupId'];
    if (rawRideGroupId == null ||
        rawRideGroupId is! String ||
        rawRideGroupId.trim().isEmpty) {
      throw const FormatException('Missing or invalid rideGroupId in DriverDispatchOffer');
    }

    final rawGroupVersion = json['groupVersion'];
    if (rawGroupVersion == null || rawGroupVersion is! num) {
      throw const FormatException('Missing or invalid groupVersion in DriverDispatchOffer');
    }

    final rawPickupPoint = json['pickupPoint'];
    if (rawPickupPoint == null || rawPickupPoint is! Map<String, dynamic>) {
      throw const FormatException('Missing or invalid pickupPoint in DriverDispatchOffer');
    }

    final rawPassengerCount = json['passengerCount'];
    if (rawPassengerCount == null || rawPassengerCount is! num) {
      throw const FormatException(
        'Missing or invalid passengerCount in DriverDispatchOffer',
      );
    }

    final rawTotalEstimatedFare = json['totalEstimatedFare'];
    if (rawTotalEstimatedFare == null ||
        rawTotalEstimatedFare is! String ||
        rawTotalEstimatedFare.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid totalEstimatedFare in DriverDispatchOffer',
      );
    }

    final rawTotalDistanceMeters = json['totalDistanceMeters'];
    if (rawTotalDistanceMeters == null || rawTotalDistanceMeters is! num) {
      throw const FormatException(
        'Missing or invalid totalDistanceMeters in DriverDispatchOffer',
      );
    }

    final rawTotalDurationSec = json['totalDurationSec'];
    if (rawTotalDurationSec == null || rawTotalDurationSec is! num) {
      throw const FormatException(
        'Missing or invalid totalDurationSec in DriverDispatchOffer',
      );
    }

    final rawOfferedAt = json['offeredAt'];
    if (rawOfferedAt == null || rawOfferedAt is! String) {
      throw const FormatException('Missing or invalid offeredAt in DriverDispatchOffer');
    }
    final parsedOfferedAt = DateTime.tryParse(rawOfferedAt);
    if (parsedOfferedAt == null) {
      throw const FormatException('Malformed offeredAt ISO date string');
    }

    final rawExpiresAt = json['expiresAt'];
    if (rawExpiresAt == null || rawExpiresAt is! String) {
      throw const FormatException('Missing or invalid expiresAt in DriverDispatchOffer');
    }
    final parsedExpiresAt = DateTime.tryParse(rawExpiresAt);
    if (parsedExpiresAt == null) {
      throw const FormatException('Malformed expiresAt ISO date string');
    }

    final rawRemainingSeconds = json['remainingSeconds'];
    if (rawRemainingSeconds == null || rawRemainingSeconds is! num) {
      throw const FormatException(
        'Missing or invalid remainingSeconds in DriverDispatchOffer',
      );
    }

    return DriverDispatchOffer(
      offerId: rawOfferId.trim(),
      dispatchAttemptId: rawDispatchAttemptId.trim(),
      rideGroupId: rawRideGroupId.trim(),
      groupVersion: rawGroupVersion.toInt(),
      pickupPoint: DriverPickupPoint.fromJson(rawPickupPoint),
      passengerCount: rawPassengerCount.toInt(),
      totalEstimatedFare: rawTotalEstimatedFare.trim(),
      totalDistanceMeters: rawTotalDistanceMeters.toInt(),
      totalDurationSec: rawTotalDurationSec.toInt(),
      offeredAt: parsedOfferedAt,
      expiresAt: parsedExpiresAt,
      remainingSeconds: rawRemainingSeconds.toInt(),
    );
  }

  final String offerId;
  final String dispatchAttemptId;
  final String rideGroupId;
  final int groupVersion;
  final DriverPickupPoint pickupPoint;
  final int passengerCount;
  final String totalEstimatedFare;
  final int totalDistanceMeters;
  final int totalDurationSec;
  final DateTime offeredAt;
  final DateTime expiresAt;
  final int remainingSeconds;

  bool get isExpired {
    final now = DateTime.now();
    return now.isAfter(expiresAt) || remainingSeconds <= 0;
  }

  /// Converts this backend offer model to an immutable presentation [DispatchOfferItem].
  DispatchOfferItem toPresentationItem({
    DispatchOfferStatus status = DispatchOfferStatus.pending,
  }) {
    final effectiveStatus = isExpired ? DispatchOfferStatus.expired : status;

    final distanceKm = totalDistanceMeters > 0
        ? '${(totalDistanceMeters / 1000).toStringAsFixed(1)} km'
        : null;

    final fareFormatted = totalEstimatedFare.startsWith('₹')
        ? totalEstimatedFare
        : '₹$totalEstimatedFare';

    return DispatchOfferItem(
      id: offerId,
      groupId: rideGroupId,
      pickupLocationName: pickupPoint.name,
      dropoffLocationName: 'Gandhinagar Drop-off Corridor ($passengerCount riders)',
      passengerCount: passengerCount,
      estimatedEarnings: fareFormatted,
      estimatedDistance: distanceKm,
      status: effectiveStatus,
    );
  }

  Map<String, dynamic> toJson() => {
        'offerId': offerId,
        'dispatchAttemptId': dispatchAttemptId,
        'rideGroupId': rideGroupId,
        'groupVersion': groupVersion,
        'pickupPoint': pickupPoint.toJson(),
        'passengerCount': passengerCount,
        'totalEstimatedFare': totalEstimatedFare,
        'totalDistanceMeters': totalDistanceMeters,
        'totalDurationSec': totalDurationSec,
        'offeredAt': offeredAt.toIso8601String(),
        'expiresAt': expiresAt.toIso8601String(),
        'remainingSeconds': remainingSeconds,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DriverDispatchOffer &&
          runtimeType == other.runtimeType &&
          offerId == other.offerId &&
          dispatchAttemptId == other.dispatchAttemptId &&
          rideGroupId == other.rideGroupId &&
          groupVersion == other.groupVersion &&
          pickupPoint == other.pickupPoint &&
          passengerCount == other.passengerCount &&
          totalEstimatedFare == other.totalEstimatedFare &&
          totalDistanceMeters == other.totalDistanceMeters &&
          totalDurationSec == other.totalDurationSec &&
          offeredAt == other.offeredAt &&
          expiresAt == other.expiresAt &&
          remainingSeconds == other.remainingSeconds;

  @override
  int get hashCode => Object.hash(
        offerId,
        dispatchAttemptId,
        rideGroupId,
        groupVersion,
        pickupPoint,
        passengerCount,
        totalEstimatedFare,
        totalDistanceMeters,
        totalDurationSec,
        offeredAt,
        expiresAt,
        remainingSeconds,
      );
}
