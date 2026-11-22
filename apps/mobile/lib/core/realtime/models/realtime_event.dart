import 'package:flutter/foundation.dart';

/// Standard realtime event envelope broadcast over Socket.IO.
/// Matches `StandardRealtimeEvent<T>` defined in backend `realtime.interfaces.ts`.
@immutable
class StandardRealtimeEvent<T> {
  const StandardRealtimeEvent({
    required this.eventId,
    required this.event,
    required this.entityType,
    required this.entityId,
    required this.entityVersion,
    required this.occurredAt,
    required this.data,
  });

  final String eventId;
  final String event;
  final String entityType;
  final String entityId;
  final int entityVersion;
  final DateTime occurredAt;
  final T data;

  factory StandardRealtimeEvent.fromJson(
    Map<String, dynamic> json, [
    T Function(dynamic dataJson)? fromDataJson,
  ]) {
    final rawEventId = json['eventId'];
    if (rawEventId is! String || rawEventId.trim().isEmpty) {
      throw const FormatException('StandardRealtimeEvent: missing or empty "eventId"');
    }
    final rawEvent = json['event'];
    if (rawEvent is! String || rawEvent.trim().isEmpty) {
      throw const FormatException('StandardRealtimeEvent: missing or empty "event"');
    }
    final rawEntityType = json['entityType'];
    if (rawEntityType is! String || rawEntityType.trim().isEmpty) {
      throw const FormatException('StandardRealtimeEvent: missing or empty "entityType"');
    }
    final rawEntityId = json['entityId'];
    if (rawEntityId is! String || rawEntityId.trim().isEmpty) {
      throw const FormatException('StandardRealtimeEvent: missing or empty "entityId"');
    }

    final rawVersion = json['entityVersion'];
    if (rawVersion is! num || rawVersion != rawVersion.toInt() || rawVersion < 1) {
      throw const FormatException('StandardRealtimeEvent: "entityVersion" must be a positive integer >= 1');
    }
    final int parsedVersion = rawVersion.toInt();

    final rawOccurredAt = json['occurredAt'];
    if (rawOccurredAt is! String || rawOccurredAt.trim().isEmpty) {
      throw const FormatException('StandardRealtimeEvent: missing or empty "occurredAt"');
    }
    final parsedOccurredAt = DateTime.tryParse(rawOccurredAt);
    if (parsedOccurredAt == null) {
      throw FormatException('StandardRealtimeEvent: invalid "occurredAt" timestamp: $rawOccurredAt');
    }

    if (!json.containsKey('data')) {
      throw const FormatException('StandardRealtimeEvent: missing "data" payload');
    }
    final rawData = json['data'];
    final T parsedData;
    if (fromDataJson != null) {
      parsedData = fromDataJson(rawData);
    } else {
      parsedData = rawData as T;
    }

    return StandardRealtimeEvent<T>(
      eventId: rawEventId.trim(),
      event: rawEvent.trim(),
      entityType: rawEntityType.trim(),
      entityId: rawEntityId.trim(),
      entityVersion: parsedVersion,
      occurredAt: parsedOccurredAt,
      data: parsedData,
    );
  }

  Map<String, dynamic> toJson([dynamic Function(T data)? toDataJson]) => {
        'eventId': eventId,
        'event': event,
        'entityType': entityType,
        'entityId': entityId,
        'entityVersion': entityVersion,
        'occurredAt': occurredAt.toIso8601String(),
        'data': toDataJson != null ? toDataJson(data) : data,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is StandardRealtimeEvent &&
          runtimeType == other.runtimeType &&
          eventId == other.eventId &&
          event == other.event &&
          entityId == other.entityId &&
          entityVersion == other.entityVersion;

  @override
  int get hashCode => Object.hash(eventId, event, entityId, entityVersion);
}

/// Broadcast data for live driver GPS telemetry (`driver.location.updated`).
@immutable
class DriverLocationBroadcastData {
  const DriverLocationBroadcastData({
    required this.driverId,
    this.tripId,
    required this.latitude,
    required this.longitude,
    this.heading,
    this.speed,
    required this.updatedAt,
  });

  final String driverId;
  final String? tripId;
  final double latitude;
  final double longitude;
  final double? heading;
  final double? speed;
  final DateTime updatedAt;

  factory DriverLocationBroadcastData.fromJson(Map<String, dynamic> json) {
    final rawDriverId = json['driverId'];
    if (rawDriverId is! String || rawDriverId.trim().isEmpty) {
      throw const FormatException('DriverLocationBroadcastData: missing or empty "driverId"');
    }

    final rawLat = json['latitude'];
    if (rawLat is! num) {
      throw const FormatException('DriverLocationBroadcastData: "latitude" must be a number');
    }
    final double latitude = rawLat.toDouble();
    if (latitude < -90.0 || latitude > 90.0) {
      throw FormatException('DriverLocationBroadcastData: latitude must be between -90 and 90, got: $latitude');
    }

    final rawLng = json['longitude'];
    if (rawLng is! num) {
      throw const FormatException('DriverLocationBroadcastData: "longitude" must be a number');
    }
    final double longitude = rawLng.toDouble();
    if (longitude < -180.0 || longitude > 180.0) {
      throw FormatException('DriverLocationBroadcastData: longitude must be between -180 and 180, got: $longitude');
    }

    final rawUpdatedAt = json['updatedAt'];
    if (rawUpdatedAt is! String || rawUpdatedAt.trim().isEmpty) {
      throw const FormatException('DriverLocationBroadcastData: missing or empty "updatedAt"');
    }
    final parsedTime = DateTime.tryParse(rawUpdatedAt);
    if (parsedTime == null) {
      throw FormatException('DriverLocationBroadcastData: invalid "updatedAt" timestamp: $rawUpdatedAt');
    }

    final rawTripId = json['tripId'];
    final String? tripId = (rawTripId is String && rawTripId.trim().isNotEmpty)
        ? rawTripId.trim()
        : null;

    final rawHeading = json['heading'];
    final double? heading = rawHeading is num ? rawHeading.toDouble() : null;

    final rawSpeed = json['speed'];
    final double? speed =
        (rawSpeed is num && rawSpeed >= 0) ? rawSpeed.toDouble() : null;

    return DriverLocationBroadcastData(
      driverId: rawDriverId.trim(),
      tripId: tripId,
      latitude: latitude,
      longitude: longitude,
      heading: heading,
      speed: speed,
      updatedAt: parsedTime,
    );
  }

  Map<String, dynamic> toJson() => {
        'driverId': driverId,
        if (tripId != null) 'tripId': tripId,
        'latitude': latitude,
        'longitude': longitude,
        if (heading != null) 'heading': heading,
        if (speed != null) 'speed': speed,
        'updatedAt': updatedAt.toIso8601String(),
      };
}

/// Outgoing telemetry payload emitted by driver client via `driver.location.update`.
@immutable
class DriverLocationUpdatePayload {
  const DriverLocationUpdatePayload({
    required this.latitude,
    required this.longitude,
    this.heading,
    this.speed,
    this.tripId,
  });

  final double latitude;
  final double longitude;
  final double? heading;
  final double? speed;
  final String? tripId;

  Map<String, dynamic> toJson() => {
        'latitude': latitude,
        'longitude': longitude,
        if (heading != null) 'heading': heading,
        if (speed != null) 'speed': speed,
        if (tripId != null) 'tripId': tripId,
      };
}

/// Acknowledgment response returned by room subscription commands.
@immutable
class RoomSubscriptionAck {
  const RoomSubscriptionAck({
    required this.success,
    this.room,
    this.error,
    this.message,
  });

  final bool success;
  final String? room;
  final String? error;
  final String? message;

  factory RoomSubscriptionAck.fromJson(Map<String, dynamic> json) {
    final rawSuccess = json['success'];
    if (rawSuccess is! bool) {
      throw const FormatException('RoomSubscriptionAck: missing or invalid "success" boolean');
    }
    return RoomSubscriptionAck(
      success: rawSuccess,
      room: json['room'] as String?,
      error: json['error'] as String?,
      message: json['message'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'success': success,
        if (room != null) 'room': room,
        if (error != null) 'error': error,
        if (message != null) 'message': message,
      };
}
