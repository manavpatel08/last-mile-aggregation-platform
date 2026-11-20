/// Request payload for `POST /api/v1/bookings`.
class BookingRequest {
  const BookingRequest({
    required this.quoteId,
    required this.requestedType,
    required this.minGroupPreference,
    required this.passengerPickupLocation,
    required this.upfrontConsentAgreed,
  });

  final String quoteId;
  final String requestedType; // 'SHARED' or 'PRIVATE'
  final int minGroupPreference; // 2..4
  final BookingLocation passengerPickupLocation;
  final bool upfrontConsentAgreed;

  Map<String, dynamic> toJson() => {
        'quoteId': quoteId,
        'requestedType': requestedType,
        'minGroupPreference': minGroupPreference,
        'passengerPickupLocation': passengerPickupLocation.toJson(),
        'upfrontConsentAgreed': upfrontConsentAgreed,
      };
}

/// Coordinate model for booking pickup and destination.
class BookingLocation {
  const BookingLocation({
    required this.latitude,
    required this.longitude,
  });

  factory BookingLocation.fromJson(Map<String, dynamic> json) {
    return BookingLocation(
      latitude: (json['latitude'] as num).toDouble(),
      longitude: (json['longitude'] as num).toDouble(),
    );
  }

  final double latitude;
  final double longitude;

  Map<String, dynamic> toJson() => {
        'latitude': latitude,
        'longitude': longitude,
      };
}
