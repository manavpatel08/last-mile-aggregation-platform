import 'package:flutter/foundation.dart';
import 'realtime_event.dart';

String _requireString(
  dynamic val,
  String fieldName, {
  bool allowEmpty = false,
}) {
  if (val is! String || (!allowEmpty && val.trim().isEmpty)) {
    throw FormatException(
      'Sync parsing error: "$fieldName" must be a non-empty string',
    );
  }
  return val.trim();
}

int _requireInt(dynamic val, String fieldName, {int? min}) {
  if (val is! num || val != val.toInt()) {
    throw FormatException(
      'Sync parsing error: "$fieldName" must be an integer, got: $val',
    );
  }
  final i = val.toInt();
  if (min != null && i < min) {
    throw FormatException(
      'Sync parsing error: "$fieldName" must be >= $min, got: $i',
    );
  }
  return i;
}

DateTime _requireTimestamp(dynamic val, String fieldName) {
  if (val is! String || val.trim().isEmpty) {
    throw FormatException(
      'Sync parsing error: "$fieldName" must be a non-empty timestamp string',
    );
  }
  final dt = DateTime.tryParse(val);
  if (dt == null) {
    throw FormatException(
      'Sync parsing error: "$fieldName" has invalid timestamp: $val',
    );
  }
  return dt;
}

bool _requireBool(dynamic val, String fieldName) {
  if (val is! bool) {
    throw FormatException(
      'Sync parsing error: "$fieldName" must be a boolean',
    );
  }
  return val;
}

Map<String, dynamic>? _optionalMap(dynamic val, String fieldName) {
  if (val == null) return null;
  if (val is Map<String, dynamic>) return val;
  if (val is Map) return Map<String, dynamic>.from(val);
  throw FormatException(
    'Sync parsing error: "$fieldName" must be a JSON object (Map) or null, got: ${val.runtimeType}',
  );
}

Map<String, dynamic> _requireMap(dynamic val, String fieldName) {
  if (val is Map<String, dynamic>) return val;
  if (val is Map) return Map<String, dynamic>.from(val);
  throw FormatException(
    'Sync parsing error: "$fieldName" must be a JSON object (Map), got: ${val.runtimeType}',
  );
}

/// Request body for `POST /api/v1/sync`.
@immutable
class SyncRequestDto {
  const SyncRequestDto({
    this.lastKnownEntityVersion,
    this.activeBookingId,
    this.activeTripId,
  });

  final int? lastKnownEntityVersion;
  final String? activeBookingId;
  final String? activeTripId;

  Map<String, dynamic> toJson() => {
        if (lastKnownEntityVersion != null)
          'lastKnownEntityVersion': lastKnownEntityVersion,
        if (activeBookingId != null) 'activeBookingId': activeBookingId,
        if (activeTripId != null) 'activeTripId': activeTripId,
      };
}

/// Active booking snapshot in passenger sync state.
@immutable
class SyncActiveBooking {
  const SyncActiveBooking({
    required this.id,
    required this.status,
    required this.passengerId,
    required this.pickupPointId,
    this.dropoffAddress,
    required this.fareQuotePaise,
    required this.createdAt,
    required this.updatedAt,
    required this.entityVersion,
  });

  final String id;
  final String status;
  final String passengerId;
  final String pickupPointId;
  final String? dropoffAddress;
  final int fareQuotePaise;
  final DateTime createdAt;
  final DateTime updatedAt;
  final int entityVersion;

  factory SyncActiveBooking.fromJson(Map<String, dynamic> json) {
    final rawDropoff = json['dropoffAddress'];
    final String? dropoff = (rawDropoff is String && rawDropoff.trim().isNotEmpty)
        ? rawDropoff.trim()
        : null;

    return SyncActiveBooking(
      id: _requireString(json['id'], 'activeBooking.id'),
      status: _requireString(json['status'], 'activeBooking.status'),
      passengerId: _requireString(json['passengerId'], 'activeBooking.passengerId'),
      pickupPointId: _requireString(json['pickupPointId'], 'activeBooking.pickupPointId'),
      dropoffAddress: dropoff,
      fareQuotePaise: _requireInt(json['fareQuotePaise'], 'activeBooking.fareQuotePaise', min: 0),
      createdAt: _requireTimestamp(json['createdAt'], 'activeBooking.createdAt'),
      updatedAt: _requireTimestamp(json['updatedAt'], 'activeBooking.updatedAt'),
      entityVersion: _requireInt(json['entityVersion'], 'activeBooking.entityVersion', min: 1),
    );
  }
}

/// Active group snapshot in passenger sync state.
@immutable
class SyncActiveGroup {
  const SyncActiveGroup({
    required this.id,
    required this.status,
    required this.groupVersion,
    required this.pickupPointId,
    required this.memberCount,
  });

  final String id;
  final String status;
  final int groupVersion;
  final String pickupPointId;
  final int memberCount;

  factory SyncActiveGroup.fromJson(Map<String, dynamic> json) {
    return SyncActiveGroup(
      id: _requireString(json['id'], 'activeGroup.id'),
      status: _requireString(json['status'], 'activeGroup.status'),
      groupVersion: _requireInt(json['groupVersion'], 'activeGroup.groupVersion', min: 1),
      pickupPointId: _requireString(json['pickupPointId'], 'activeGroup.pickupPointId'),
      memberCount: _requireInt(json['memberCount'], 'activeGroup.memberCount', min: 0),
    );
  }
}

/// Passenger active trip snapshot in passenger sync state.
@immutable
class SyncPassengerActiveTrip {
  const SyncPassengerActiveTrip({
    required this.id,
    required this.status,
    required this.tripVersion,
    required this.activeDriverId,
    this.driverName,
    this.vehicleNumber,
    this.driverLocation,
    this.etaSeconds,
    this.currentStopOrder,
    required this.farePaise,
  });

  final String id;
  final String status;
  final int tripVersion;
  final String activeDriverId;
  final String? driverName;
  final String? vehicleNumber;
  final DriverLocationBroadcastData? driverLocation;
  final int? etaSeconds;
  final int? currentStopOrder;
  final int farePaise;

  factory SyncPassengerActiveTrip.fromJson(Map<String, dynamic> json) {
    final driverId = _requireString(json['activeDriverId'], 'activeTrip.activeDriverId');

    final locMap = _optionalMap(json['driverLocation'], 'activeTrip.driverLocation');
    DriverLocationBroadcastData? location;
    if (locMap != null) {
      final rawLat = locMap['latitude'];
      final rawLng = locMap['longitude'];
      if (rawLat is! num || rawLng is! num) {
        throw const FormatException('Sync passenger activeTrip: driverLocation latitude/longitude must be numbers');
      }
      final double lat = rawLat.toDouble();
      final double lng = rawLng.toDouble();
      if (lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0) {
        throw const FormatException('Sync passenger activeTrip: driverLocation coordinates out of bounds');
      }
      final updatedAt = _requireTimestamp(locMap['updatedAt'], 'activeTrip.driverLocation.updatedAt');
      location = DriverLocationBroadcastData(
        driverId: driverId,
        latitude: lat,
        longitude: lng,
        updatedAt: updatedAt,
      );
    }

    final rawEta = json['etaSeconds'];
    final int? eta = rawEta != null ? _requireInt(rawEta, 'activeTrip.etaSeconds', min: 0) : null;

    final rawStopOrder = json['currentStopOrder'];
    final int? stopOrder = rawStopOrder != null
        ? _requireInt(rawStopOrder, 'activeTrip.currentStopOrder', min: 0)
        : null;

    return SyncPassengerActiveTrip(
      id: _requireString(json['id'], 'activeTrip.id'),
      status: _requireString(json['status'], 'activeTrip.status'),
      tripVersion: _requireInt(json['tripVersion'], 'activeTrip.tripVersion', min: 1),
      activeDriverId: driverId,
      driverName: json['driverName'] as String?,
      vehicleNumber: json['vehicleNumber'] as String?,
      driverLocation: location,
      etaSeconds: eta,
      currentStopOrder: stopOrder,
      farePaise: _requireInt(json['farePaise'], 'activeTrip.farePaise', min: 0),
    );
  }
}

/// Outstanding fee item in sync state.
@immutable
class SyncOutstandingFee {
  const SyncOutstandingFee({
    required this.id,
    required this.feeAmountPaise,
    required this.reason,
    required this.assessedAt,
  });

  final String id;
  final int feeAmountPaise;
  final String reason;
  final DateTime assessedAt;

  factory SyncOutstandingFee.fromJson(Map<String, dynamic> json) {
    return SyncOutstandingFee(
      id: _requireString(json['id'], 'outstandingCancellationFee.id'),
      feeAmountPaise: _requireInt(json['feeAmountPaise'], 'outstandingCancellationFee.feeAmountPaise', min: 0),
      reason: _requireString(json['reason'], 'outstandingCancellationFee.reason'),
      assessedAt: _requireTimestamp(json['assessedAt'], 'outstandingCancellationFee.assessedAt'),
    );
  }
}

/// Passenger authoritative state snapshot from sync.
@immutable
class SyncPassengerState {
  const SyncPassengerState({
    this.activeBooking,
    this.activeGroup,
    this.activeTrip,
    this.outstandingCancellationFees = const [],
  });

  final SyncActiveBooking? activeBooking;
  final SyncActiveGroup? activeGroup;
  final SyncPassengerActiveTrip? activeTrip;
  final List<SyncOutstandingFee> outstandingCancellationFees;

  factory SyncPassengerState.fromJson(Map<String, dynamic> json) {
    final bookingMap = _optionalMap(json['activeBooking'], 'SyncPassengerState.activeBooking');
    final groupMap = _optionalMap(json['activeGroup'], 'SyncPassengerState.activeGroup');
    final tripMap = _optionalMap(json['activeTrip'], 'SyncPassengerState.activeTrip');
    final rawFees = json['outstandingCancellationFees'];

    if (rawFees != null && rawFees is! List) {
      throw const FormatException('SyncPassengerState: "outstandingCancellationFees" must be a list');
    }
    final feeList = rawFees as List? ?? [];

    return SyncPassengerState(
      activeBooking: bookingMap != null ? SyncActiveBooking.fromJson(bookingMap) : null,
      activeGroup: groupMap != null ? SyncActiveGroup.fromJson(groupMap) : null,
      activeTrip: tripMap != null ? SyncPassengerActiveTrip.fromJson(tripMap) : null,
      outstandingCancellationFees: feeList
          .map((f) => SyncOutstandingFee.fromJson(_requireMap(f, 'outstandingCancellationFees[]')))
          .toList(),
    );
  }
}

/// Driver profile snapshot in driver sync state.
@immutable
class SyncDriverProfile {
  const SyncDriverProfile({
    required this.id,
    required this.verificationStatus,
    required this.operationalStatus,
    required this.isOnline,
  });

  final String id;
  final String verificationStatus;
  final String operationalStatus;
  final bool isOnline;

  factory SyncDriverProfile.fromJson(Map<String, dynamic> json) {
    return SyncDriverProfile(
      id: _requireString(json['id'], 'driverProfile.id', allowEmpty: true),
      verificationStatus: _requireString(json['verificationStatus'], 'driverProfile.verificationStatus'),
      operationalStatus: _requireString(json['operationalStatus'], 'driverProfile.operationalStatus'),
      isOnline: _requireBool(json['isOnline'], 'driverProfile.isOnline'),
    );
  }
}

/// Active dispatch offer in driver sync state.
@immutable
class SyncActiveOffer {
  const SyncActiveOffer({
    required this.id,
    required this.rideGroupId,
    required this.groupVersion,
    required this.expiresAt,
    required this.status,
  });

  final String id;
  final String rideGroupId;
  final int groupVersion;
  final DateTime expiresAt;
  final String status;

  factory SyncActiveOffer.fromJson(Map<String, dynamic> json) {
    return SyncActiveOffer(
      id: _requireString(json['id'], 'activeOffer.id'),
      rideGroupId: _requireString(json['rideGroupId'], 'activeOffer.rideGroupId'),
      groupVersion: _requireInt(json['groupVersion'], 'activeOffer.groupVersion', min: 1),
      expiresAt: _requireTimestamp(json['expiresAt'], 'activeOffer.expiresAt'),
      status: _requireString(json['status'], 'activeOffer.status'),
    );
  }
}

/// Passenger manifest item in driver sync active trip.
/// Note: `pickupOtp` is strictly never populated or exposed from sync (zero-trust).
@immutable
class SyncPassengerManifestItem {
  const SyncPassengerManifestItem({
    required this.passengerId,
    required this.bookingId,
    required this.status,
  });

  final String passengerId;
  final String bookingId;
  final String status;

  factory SyncPassengerManifestItem.fromJson(Map<String, dynamic> json) {
    return SyncPassengerManifestItem(
      passengerId: _requireString(json['passengerId'], 'passengerManifest.passengerId'),
      bookingId: _requireString(json['bookingId'], 'passengerManifest.bookingId'),
      status: _requireString(json['status'], 'passengerManifest.status'),
    );
  }
}

/// Active trip in driver sync state.
@immutable
class SyncDriverActiveTrip {
  const SyncDriverActiveTrip({
    required this.id,
    required this.status,
    required this.tripVersion,
    required this.rideGroupId,
    this.currentStopOrder,
    this.passengerManifest = const [],
  });

  final String id;
  final String status;
  final int tripVersion;
  final String rideGroupId;
  final int? currentStopOrder;
  final List<SyncPassengerManifestItem> passengerManifest;

  factory SyncDriverActiveTrip.fromJson(Map<String, dynamic> json) {
    final rawManifest = json['passengerManifest'];
    if (rawManifest != null && rawManifest is! List) {
      throw const FormatException('SyncDriverActiveTrip: "passengerManifest" must be a list');
    }
    final manifestList = rawManifest as List? ?? [];

    final rawStopOrder = json['currentStopOrder'];
    final int? stopOrder = rawStopOrder != null
        ? _requireInt(rawStopOrder, 'driverActiveTrip.currentStopOrder', min: 0)
        : null;

    return SyncDriverActiveTrip(
      id: _requireString(json['id'], 'driverActiveTrip.id'),
      status: _requireString(json['status'], 'driverActiveTrip.status'),
      tripVersion: _requireInt(json['tripVersion'], 'driverActiveTrip.tripVersion', min: 1),
      rideGroupId: _requireString(json['rideGroupId'], 'driverActiveTrip.rideGroupId'),
      currentStopOrder: stopOrder,
      passengerManifest: manifestList
          .map((p) => SyncPassengerManifestItem.fromJson(_requireMap(p, 'passengerManifest[]')))
          .toList(),
    );
  }
}

/// Driver authoritative state snapshot from sync.
@immutable
class SyncDriverState {
  const SyncDriverState({
    required this.driverProfile,
    this.activeOffer,
    this.activeTrip,
  });

  final SyncDriverProfile driverProfile;
  final SyncActiveOffer? activeOffer;
  final SyncDriverActiveTrip? activeTrip;

  factory SyncDriverState.fromJson(Map<String, dynamic> json) {
    final profileMap = _requireMap(json['driverProfile'], 'SyncDriverState.driverProfile');
    final offerMap = _optionalMap(json['activeOffer'], 'SyncDriverState.activeOffer');
    final tripMap = _optionalMap(json['activeTrip'], 'SyncDriverState.activeTrip');

    return SyncDriverState(
      driverProfile: SyncDriverProfile.fromJson(profileMap),
      activeOffer: offerMap != null ? SyncActiveOffer.fromJson(offerMap) : null,
      activeTrip: tripMap != null ? SyncDriverActiveTrip.fromJson(tripMap) : null,
    );
  }
}

/// Full response payload from `POST /api/v1/sync`.
@immutable
class SyncResponseDto {
  const SyncResponseDto({
    required this.success,
    required this.serverTimestamp,
    required this.role,
    required this.reconciled,
    this.passengerState,
    this.driverState,
  });

  final bool success;
  final DateTime serverTimestamp;
  final String role;
  final bool reconciled;
  final SyncPassengerState? passengerState;
  final SyncDriverState? driverState;

  factory SyncResponseDto.fromJson(Map<String, dynamic> json) {
    final passMap = _optionalMap(json['passengerState'], 'SyncResponseDto.passengerState');
    final driverMap = _optionalMap(json['driverState'], 'SyncResponseDto.driverState');

    return SyncResponseDto(
      success: _requireBool(json['success'], 'SyncResponseDto.success'),
      serverTimestamp: _requireTimestamp(json['serverTimestamp'], 'SyncResponseDto.serverTimestamp'),
      role: _requireString(json['role'], 'SyncResponseDto.role'),
      reconciled: _requireBool(json['reconciled'], 'SyncResponseDto.reconciled'),
      passengerState: passMap != null ? SyncPassengerState.fromJson(passMap) : null,
      driverState: driverMap != null ? SyncDriverState.fromJson(driverMap) : null,
    );
  }
}
