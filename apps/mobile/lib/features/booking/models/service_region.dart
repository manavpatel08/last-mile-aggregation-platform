import 'package:latlong2/latlong.dart';

/// Represents an authorized service region with boundary geometry.
class ServiceRegion {
  const ServiceRegion({
    required this.id,
    required this.name,
    required this.isActive,
    this.boundaryGeoJson,
  });

  factory ServiceRegion.fromJson(Map<String, dynamic> json) {
    return ServiceRegion(
      id: json['id'] as String,
      name: json['name'] as String,
      isActive: json['isActive'] as bool? ?? true,
      boundaryGeoJson: json['boundaryGeoJson'],
    );
  }

  final String id;
  final String name;
  final bool isActive;
  final dynamic boundaryGeoJson;

  /// Parses coordinates from GeoJSON Polygon / MultiPolygon into [LatLng] lists.
  List<LatLng> get polygonCoordinates {
    if (boundaryGeoJson is! Map<String, dynamic>) {
      return const [];
    }

    final geoJson = boundaryGeoJson as Map<String, dynamic>;
    final type = geoJson['type'] as String?;
    final coordinates = geoJson['coordinates'];

    if (coordinates is! List) return const [];

    try {
      if (type == 'Polygon' && coordinates.isNotEmpty) {
        // Linear ring: List of [lng, lat]
        final outerRing = coordinates.first;
        if (outerRing is List) {
          return outerRing.map<LatLng>((pt) {
            final list = pt as List;
            return LatLng(
              (list[1] as num).toDouble(),
              (list[0] as num).toDouble(),
            );
          }).toList();
        }
      } else if (type == 'MultiPolygon' && coordinates.isNotEmpty) {
        final firstPoly = coordinates.first;
        if (firstPoly is List && firstPoly.isNotEmpty) {
          final outerRing = firstPoly.first;
          if (outerRing is List) {
            return outerRing.map<LatLng>((pt) {
              final list = pt as List;
              return LatLng(
                (list[1] as num).toDouble(),
                (list[0] as num).toDouble(),
              );
            }).toList();
          }
        }
      }
    } catch (_) {
      return const [];
    }

    return const [];
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'isActive': isActive,
        'boundaryGeoJson': boundaryGeoJson,
      };
}
