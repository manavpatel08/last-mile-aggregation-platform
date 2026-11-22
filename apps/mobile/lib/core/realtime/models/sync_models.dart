import 'package:flutter/foundation.dart';
import 'realtime_event.dart';

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
    return SyncActiveBooking(
      id: json['id'] as String? ?? '',
      status: json['status'] as String? ?? '',
      passengerId: json['passengerId'] as String? ?? '',
      pickupPointId: json['pickupPointId'] as String? ?? '',
      dropoffAddress: json['dropoffAddress'] as String?,
      fareQuotePaise: (json['fareQuotePaise'] as num?)?.toInt() ?? 0,
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.now(),
      updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.now(),
      entityVersion: (json['entityVersion'] as num?)?.toInt() ?? 1,
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
      id: json['id'] as String? ?? '',
      status: json['status'] as String? ?? '',
      groupVersion: (json['groupVersion'] as num?)?.toInt() ?? 1,
      pickupPointId: json['pickupPointId'] as String? ?? '',
      memberCount: (json['memberCount'] as num?)?.toInt() ?? 0,
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
    final rawLoc = json['driverLocation'];
    DriverLocationBroadcastData? location;
    if (rawLoc is Map<String, dynamic>) {
      location = DriverLocationBroadcastData(
        driverId: json['activeDriverId'] as String? ?? '',
        latitude: (rawLoc['latitude'] as num?)?.toDouble() ?? 0.0,
        longitude: (rawLoc['longitude'] as num?)?.toDouble() ?? 0.0,
        updatedAt: DateTime.tryParse(rawLoc['updatedAt'] as String? ?? '') ??
            DateTime.now(),
      );
    }

    return SyncPassengerActiveTrip(
      id: json['id'] as String? ?? '',
      status: json['status'] as String? ?? '',
      tripVersion: (json['tripVersion'] as num?)?.toInt() ?? 1,
      activeDriverId: json['activeDriverId'] as String? ?? '',
      driverName: json['driverName'] as String?,
      vehicleNumber: json['vehicleNumber'] as String?,
      driverLocation: location,
      etaSeconds: (json['etaSeconds'] as num?)?.toInt(),
      currentStopOrder: (json['currentStopOrder'] as num?)?.toInt(),
      farePaise: (json['farePaise'] as num?)?.toInt() ?? 0,
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
      id: json['id'] as String? ?? '',
      feeAmountPaise: (json['feeAmountPaise'] as num?)?.toInt() ?? 0,
      reason: json['reason'] as String? ?? '',
      assessedAt: DateTime.tryParse(json['assessedAt'] as String? ?? '') ??
          DateTime.now(),
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
    final rawBooking = json['activeBooking'];
    final rawGroup = json['activeGroup'];
    final rawTrip = json['activeTrip'];
    final rawFees = json['outstandingCancellationFees'] as List? ?? [];

    return SyncPassengerState(
      activeBooking: rawBooking is Map<String, dynamic>
          ? SyncActiveBooking.fromJson(rawBooking)
          : null,
      activeGroup: rawGroup is Map<String, dynamic>
          ? SyncActiveGroup.fromJson(rawGroup)
          : null,
      activeTrip: rawTrip is Map<String, dynamic>
          ? SyncPassengerActiveTrip.fromJson(rawTrip)
          : null,
      outstandingCancellationFees: rawFees
          .whereType<Map<String, dynamic>>()
          .map(SyncOutstandingFee.fromJson)
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
      id: json['id'] as String? ?? '',
      verificationStatus: json['verificationStatus'] as String? ?? '',
      operationalStatus: json['operationalStatus'] as String? ?? '',
      isOnline: json['isOnline'] as bool? ?? false,
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
      id: json['id'] as String? ?? '',
      rideGroupId: json['rideGroupId'] as String? ?? '',
      groupVersion: (json['groupVersion'] as num?)?.toInt() ?? 1,
      expiresAt: DateTime.tryParse(json['expiresAt'] as String? ?? '') ??
          DateTime.now(),
      status: json['status'] as String? ?? '',
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
      passengerId: json['passengerId'] as String? ?? '',
      bookingId: json['bookingId'] as String? ?? '',
      status: json['status'] as String? ?? '',
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
    final rawManifest = json['passengerManifest'] as List? ?? [];
    return SyncDriverActiveTrip(
      id: json['id'] as String? ?? '',
      status: json['status'] as String? ?? '',
      tripVersion: (json['tripVersion'] as num?)?.toInt() ?? 1,
      rideGroupId: json['rideGroupId'] as String? ?? '',
      currentStopOrder: (json['currentStopOrder'] as num?)?.toInt(),
      passengerManifest: rawManifest
          .whereType<Map<String, dynamic>>()
          .map(SyncPassengerManifestItem.fromJson)
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
    final rawProfile = json['driverProfile'];
    final rawOffer = json['activeOffer'];
    final rawTrip = json['activeTrip'];

    return SyncDriverState(
      driverProfile: rawProfile is Map<String, dynamic>
          ? SyncDriverProfile.fromJson(rawProfile)
          : const SyncDriverProfile(
              id: '',
              verificationStatus: 'NOT_REGISTERED',
              operationalStatus: 'INACTIVE',
              isOnline: false,
            ),
      activeOffer: rawOffer is Map<String, dynamic>
          ? SyncActiveOffer.fromJson(rawOffer)
          : null,
      activeTrip: rawTrip is Map<String, dynamic>
          ? SyncDriverActiveTrip.fromJson(rawTrip)
          : null,
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
    final rawPass = json['passengerState'];
    final rawDriver = json['driverState'];

    return SyncResponseDto(
      success: json['success'] as bool? ?? false,
      serverTimestamp:
          DateTime.tryParse(json['serverTimestamp'] as String? ?? '') ??
              DateTime.now(),
      role: json['role'] as String? ?? '',
      reconciled: json['reconciled'] as bool? ?? false,
      passengerState: rawPass is Map<String, dynamic>
          ? SyncPassengerState.fromJson(rawPass)
          : null,
      driverState: rawDriver is Map<String, dynamic>
          ? SyncDriverState.fromJson(rawDriver)
          : null,
    );
  }
}
