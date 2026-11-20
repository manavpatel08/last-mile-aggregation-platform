/// Represents an authorized pickup hub (e.g. PDEU Main Gate).
class PickupPoint {
  const PickupPoint({
    required this.id,
    required this.name,
    required this.serviceZoneId,
    required this.radiusMeters,
    required this.latitude,
    required this.longitude,
    required this.isActive,
  });

  factory PickupPoint.fromJson(Map<String, dynamic> json) {
    return PickupPoint(
      id: json['id'] as String,
      name: json['name'] as String,
      serviceZoneId: json['serviceZoneId'] as String? ?? '',
      radiusMeters: (json['radiusMeters'] as num?)?.toDouble() ?? 150.0,
      latitude: (json['latitude'] as num).toDouble(),
      longitude: (json['longitude'] as num).toDouble(),
      isActive: json['isActive'] as bool? ?? true,
    );
  }

  final String id;
  final String name;
  final String serviceZoneId;
  final double radiusMeters;
  final double latitude;
  final double longitude;
  final bool isActive;

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'serviceZoneId': serviceZoneId,
        'radiusMeters': radiusMeters,
        'latitude': latitude,
        'longitude': longitude,
        'isActive': isActive,
      };
}
