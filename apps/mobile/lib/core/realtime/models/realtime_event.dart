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
    final rawOccurredAt = json['occurredAt'];
    DateTime parsedOccurredAt;
    if (rawOccurredAt is String) {
      parsedOccurredAt = DateTime.tryParse(rawOccurredAt) ?? DateTime.now();
    } else {
      parsedOccurredAt = DateTime.now();
    }

    final rawData = json['data'];
    final T parsedData;
    if (fromDataJson != null) {
      parsedData = fromDataJson(rawData);
    } else {
      parsedData = rawData as T;
    }

    return StandardRealtimeEvent<T>(
      eventId: json['eventId'] as String? ?? '',
      event: json['event'] as String? ?? '',
      entityType: json['entityType'] as String? ?? '',
      entityId: json['entityId'] as String? ?? '',
      entityVersion: (json['entityVersion'] as num?)?.toInt() ?? 1,
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
    final rawUpdatedAt = json['updatedAt'];
    DateTime parsedTime;
    if (rawUpdatedAt is String) {
      parsedTime = DateTime.tryParse(rawUpdatedAt) ?? DateTime.now();
    } else {
      parsedTime = DateTime.now();
    }

    return DriverLocationBroadcastData(
      driverId: json['driverId'] as String? ?? '',
      tripId: json['tripId'] as String?,
      latitude: (json['latitude'] as num?)?.toDouble() ?? 0.0,
      longitude: (json['longitude'] as num?)?.toDouble() ?? 0.0,
      heading: (json['heading'] as num?)?.toDouble(),
      speed: (json['speed'] as num?)?.toDouble(),
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
    return RoomSubscriptionAck(
      success: json['success'] as bool? ?? false,
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
