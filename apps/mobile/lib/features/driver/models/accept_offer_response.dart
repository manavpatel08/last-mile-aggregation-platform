import 'package:flutter/foundation.dart';

/// Navigation stop model returned inside [AcceptOfferResponse].
@immutable
class NavigationStop {
  const NavigationStop({
    required this.stopOrder,
    required this.stopType,
    required this.latitude,
    required this.longitude,
  });

  factory NavigationStop.fromJson(Map<String, dynamic> json) {
    final rawStopOrder = json['stopOrder'];
    if (rawStopOrder == null || rawStopOrder is! num) {
      throw const FormatException('Missing or invalid stopOrder in NavigationStop');
    }
    final rawStopType = json['stopType'];
    if (rawStopType == null || rawStopType is! String || rawStopType.trim().isEmpty) {
      throw const FormatException('Missing or invalid stopType in NavigationStop');
    }
    final rawLatitude = json['latitude'];
    if (rawLatitude == null || rawLatitude is! num) {
      throw const FormatException('Missing or invalid latitude in NavigationStop');
    }
    final rawLongitude = json['longitude'];
    if (rawLongitude == null || rawLongitude is! num) {
      throw const FormatException('Missing or invalid longitude in NavigationStop');
    }

    return NavigationStop(
      stopOrder: rawStopOrder.toInt(),
      stopType: rawStopType.trim(),
      latitude: rawLatitude.toDouble(),
      longitude: rawLongitude.toDouble(),
    );
  }

  final int stopOrder;
  final String stopType;
  final double latitude;
  final double longitude;

  Map<String, dynamic> toJson() => {
        'stopOrder': stopOrder,
        'stopType': stopType,
        'latitude': latitude,
        'longitude': longitude,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is NavigationStop &&
          runtimeType == other.runtimeType &&
          stopOrder == other.stopOrder &&
          stopType == other.stopType &&
          latitude == other.latitude &&
          longitude == other.longitude;

  @override
  int get hashCode => Object.hash(stopOrder, stopType, latitude, longitude);
}

/// Navigation route details returned inside [AcceptOfferResponse].
@immutable
class NavigationRouteData {
  const NavigationRouteData({
    required this.geometry,
    required this.stops,
  });

  factory NavigationRouteData.fromJson(Map<String, dynamic> json) {
    final rawGeometry = json['geometry'];
    if (rawGeometry == null) {
      throw const FormatException('Missing geometry in NavigationRouteData');
    }

    final rawStops = json['stops'];
    if (rawStops == null || rawStops is! List) {
      throw const FormatException('Missing or invalid stops in NavigationRouteData');
    }

    final List<NavigationStop> stopsList = rawStops.map((item) {
      if (item is! Map<String, dynamic>) {
        throw const FormatException('Navigation stop item is not a JSON object');
      }
      return NavigationStop.fromJson(item);
    }).toList();

    return NavigationRouteData(
      geometry: rawGeometry is Map<String, dynamic>
          ? Map<String, dynamic>.unmodifiable(rawGeometry)
          : rawGeometry,
      stops: List<NavigationStop>.unmodifiable(stopsList),
    );
  }

  final dynamic geometry;
  final List<NavigationStop> stops;

  Map<String, dynamic> toJson() => {
        'geometry': geometry,
        'stops': stops.map((s) => s.toJson()).toList(),
      };
}

/// Authoritative response model returned by `POST /api/v1/drivers/offers/:id/accept`.
@immutable
class AcceptOfferResponse {
  const AcceptOfferResponse({
    required this.assignmentId,
    required this.tripId,
    required this.rideGroupId,
    required this.passengerCount,
    required this.totalEstimatedFare,
    required this.navigationRoute,
  });

  factory AcceptOfferResponse.fromJson(Map<String, dynamic> json) {
    final rawAssignmentId = json['assignmentId'];
    if (rawAssignmentId == null ||
        rawAssignmentId is! String ||
        rawAssignmentId.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid assignmentId in AcceptOfferResponse',
      );
    }

    final rawTripId = json['tripId'];
    if (rawTripId == null || rawTripId is! String || rawTripId.trim().isEmpty) {
      throw const FormatException('Missing or invalid tripId in AcceptOfferResponse');
    }

    final rawRideGroupId = json['rideGroupId'];
    if (rawRideGroupId == null ||
        rawRideGroupId is! String ||
        rawRideGroupId.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid rideGroupId in AcceptOfferResponse',
      );
    }

    final rawPassengerCount = json['passengerCount'];
    if (rawPassengerCount == null || rawPassengerCount is! num) {
      throw const FormatException(
        'Missing or invalid passengerCount in AcceptOfferResponse',
      );
    }

    final rawTotalEstimatedFare = json['totalEstimatedFare'];
    if (rawTotalEstimatedFare == null ||
        rawTotalEstimatedFare is! String ||
        rawTotalEstimatedFare.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid totalEstimatedFare in AcceptOfferResponse',
      );
    }

    final rawNavigationRoute = json['navigationRoute'];
    if (rawNavigationRoute == null || rawNavigationRoute is! Map<String, dynamic>) {
      throw const FormatException(
        'Missing or invalid navigationRoute in AcceptOfferResponse',
      );
    }

    return AcceptOfferResponse(
      assignmentId: rawAssignmentId.trim(),
      tripId: rawTripId.trim(),
      rideGroupId: rawRideGroupId.trim(),
      passengerCount: rawPassengerCount.toInt(),
      totalEstimatedFare: rawTotalEstimatedFare.trim(),
      navigationRoute: NavigationRouteData.fromJson(rawNavigationRoute),
    );
  }

  final String assignmentId;
  final String tripId;
  final String rideGroupId;
  final int passengerCount;
  final String totalEstimatedFare;
  final NavigationRouteData navigationRoute;

  Map<String, dynamic> toJson() => {
        'assignmentId': assignmentId,
        'tripId': tripId,
        'rideGroupId': rideGroupId,
        'passengerCount': passengerCount,
        'totalEstimatedFare': totalEstimatedFare,
        'navigationRoute': navigationRoute.toJson(),
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AcceptOfferResponse &&
          runtimeType == other.runtimeType &&
          assignmentId == other.assignmentId &&
          tripId == other.tripId &&
          rideGroupId == other.rideGroupId &&
          passengerCount == other.passengerCount &&
          totalEstimatedFare == other.totalEstimatedFare;

  @override
  int get hashCode => Object.hash(
        assignmentId,
        tripId,
        rideGroupId,
        passengerCount,
        totalEstimatedFare,
      );
}
