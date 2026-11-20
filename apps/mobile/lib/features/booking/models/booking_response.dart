import 'booking_request.dart';

/// Response payload from `POST /api/v1/bookings` or `GET /api/v1/bookings/active`.
class BookingResponse {
  const BookingResponse({
    required this.bookingId,
    required this.status,
    required this.agreedFareCeiling,
    required this.maxWaitDeadline,
    this.passengerId,
    this.pickupPointId,
    this.pickupPointName,
    this.requestedType,
    this.minGroupPreference,
    this.finalAllocatedFarePaise,
    this.cancellationReason,
    this.cancelledAt,
    this.createdAt,
    this.passengerPickupLocation,
    this.destinationLocation,
  });

  factory BookingResponse.fromJson(Map<String, dynamic> json) {
    String ceiling = '0.00';
    if (json['agreedFareCeiling'] != null) {
      ceiling = json['agreedFareCeiling'].toString();
    } else if (json['agreedFareCeilingPaise'] != null) {
      final paise = (json['agreedFareCeilingPaise'] as num).toInt();
      ceiling = (paise / 100).toStringAsFixed(2);
    }

    return BookingResponse(
      bookingId: json['bookingId'] as String? ?? json['id'] as String? ?? '',
      status: json['status'] as String? ?? 'REQUESTED',
      agreedFareCeiling: ceiling,
      maxWaitDeadline: DateTime.parse(
        json['maxWaitDeadline'] as String? ?? DateTime.now().toIso8601String(),
      ),
      passengerId: json['passengerId'] as String?,
      pickupPointId: json['pickupPointId'] as String?,
      pickupPointName: json['pickupPointName'] as String?,
      requestedType: json['requestedType'] as String?,
      minGroupPreference: (json['minGroupPreference'] as num?)?.toInt(),
      finalAllocatedFarePaise:
          (json['finalAllocatedFarePaise'] as num?)?.toInt(),
      cancellationReason: json['cancellationReason'] as String?,
      cancelledAt: json['cancelledAt'] != null
          ? DateTime.tryParse(json['cancelledAt'] as String)
          : null,
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
      passengerPickupLocation: json['passengerPickupLocation'] != null
          ? BookingLocation.fromJson(
              json['passengerPickupLocation'] as Map<String, dynamic>,
            )
          : null,
      destinationLocation: json['destinationLocation'] != null
          ? BookingLocation.fromJson(
              json['destinationLocation'] as Map<String, dynamic>,
            )
          : null,
    );
  }

  final String bookingId;
  final String status;
  final String agreedFareCeiling;
  final DateTime maxWaitDeadline;
  final String? passengerId;
  final String? pickupPointId;
  final String? pickupPointName;
  final String? requestedType;
  final int? minGroupPreference;
  final int? finalAllocatedFarePaise;
  final String? cancellationReason;
  final DateTime? cancelledAt;
  final DateTime? createdAt;
  final BookingLocation? passengerPickupLocation;
  final BookingLocation? destinationLocation;

  bool get isActive =>
      status == 'REQUESTED' ||
      status == 'MATCHING' ||
      status == 'MATCHED' ||
      status == 'DISPATCHING' ||
      status == 'CONFIRMED' ||
      status == 'DRIVER_ASSIGNED' ||
      status == 'DRIVER_ARRIVED' ||
      status == 'BOARDED' ||
      status == 'IN_PROGRESS';

  Duration get remainingWaitDuration {
    final diff = maxWaitDeadline.difference(DateTime.now());
    return diff.isNegative ? Duration.zero : diff;
  }
}
