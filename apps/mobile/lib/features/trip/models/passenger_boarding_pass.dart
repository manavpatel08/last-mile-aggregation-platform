import 'package:flutter/foundation.dart';

/// Vehicle details associated with the assigned driver.
@immutable
class BoardingPassDriverVehicle {
  const BoardingPassDriverVehicle({
    required this.registrationNumber,
    required this.makeModel,
    required this.vehicleType,
  });

  factory BoardingPassDriverVehicle.fromJson(Map<String, dynamic> json) {
    return BoardingPassDriverVehicle(
      registrationNumber: json['registrationNumber'] as String? ?? '',
      makeModel: json['makeModel'] as String? ?? '',
      vehicleType: json['vehicleType'] as String? ?? 'E_RICKSHAW',
    );
  }

  final String registrationNumber;
  final String makeModel;
  final String vehicleType;

  Map<String, dynamic> toJson() => {
        'registrationNumber': registrationNumber,
        'makeModel': makeModel,
        'vehicleType': vehicleType,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is BoardingPassDriverVehicle &&
          runtimeType == other.runtimeType &&
          registrationNumber == other.registrationNumber &&
          makeModel == other.makeModel &&
          vehicleType == other.vehicleType;

  @override
  int get hashCode => Object.hash(registrationNumber, makeModel, vehicleType);
}

/// Assigned driver details inside the passenger boarding pass.
@immutable
class BoardingPassDriver {
  const BoardingPassDriver({
    required this.name,
    this.phoneNumber,
    this.vehicle,
  });

  factory BoardingPassDriver.fromJson(Map<String, dynamic> json) {
    return BoardingPassDriver(
      name: json['name'] as String? ?? 'Assigned Driver',
      phoneNumber: json['phoneNumber'] as String?,
      vehicle: json['vehicle'] != null
          ? BoardingPassDriverVehicle.fromJson(
              json['vehicle'] as Map<String, dynamic>,
            )
          : null,
    );
  }

  final String name;
  final String? phoneNumber;
  final BoardingPassDriverVehicle? vehicle;

  Map<String, dynamic> toJson() => {
        'name': name,
        if (phoneNumber != null) 'phoneNumber': phoneNumber,
        if (vehicle != null) 'vehicle': vehicle!.toJson(),
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is BoardingPassDriver &&
          runtimeType == other.runtimeType &&
          name == other.name &&
          phoneNumber == other.phoneNumber &&
          vehicle == other.vehicle;

  @override
  int get hashCode => Object.hash(name, phoneNumber, vehicle);
}

/// Authoritative passenger boarding pass model retrieved via
/// `GET /api/v1/bookings/:id/boarding-pass`.
@immutable
class PassengerBoardingPass {
  const PassengerBoardingPass({
    required this.bookingId,
    required this.passengerId,
    required this.tripId,
    required this.boardingOtp,
    required this.expiresAt,
    required this.bookingStatus,
    required this.driver,
  });

  factory PassengerBoardingPass.fromJson(Map<String, dynamic> json) {
    final rawBookingId = json['bookingId'] as String? ?? '';
    final rawPassengerId = json['passengerId'] as String? ?? '';
    final rawTripId = json['tripId'] as String? ?? '';
    final rawOtp = json['boardingOtp'] as String? ?? '';
    final rawStatus = json['bookingStatus'] as String? ?? 'DRIVER_ASSIGNED';

    DateTime parsedExpiresAt;
    if (json['expiresAt'] is String) {
      parsedExpiresAt =
          DateTime.tryParse(json['expiresAt'] as String) ??
          DateTime.now().add(const Duration(minutes: 30));
    } else {
      parsedExpiresAt = DateTime.now().add(const Duration(minutes: 30));
    }

    final driverJson = json['driver'] as Map<String, dynamic>? ?? {};

    return PassengerBoardingPass(
      bookingId: rawBookingId,
      passengerId: rawPassengerId,
      tripId: rawTripId,
      boardingOtp: rawOtp,
      expiresAt: parsedExpiresAt,
      bookingStatus: rawStatus,
      driver: BoardingPassDriver.fromJson(driverJson),
    );
  }

  final String bookingId;
  final String passengerId;
  final String tripId;
  final String boardingOtp;
  final DateTime expiresAt;
  final String bookingStatus;
  final BoardingPassDriver driver;

  bool get isDriverArrived => bookingStatus == 'DRIVER_ARRIVED';
  bool get isBoarded =>
      bookingStatus == 'BOARDED' ||
      bookingStatus == 'IN_PROGRESS' ||
      bookingStatus == 'COMPLETED';
  bool get isExpired => DateTime.now().isAfter(expiresAt);

  PassengerBoardingPass copyWith({
    String? bookingId,
    String? passengerId,
    String? tripId,
    String? boardingOtp,
    DateTime? expiresAt,
    String? bookingStatus,
    BoardingPassDriver? driver,
  }) {
    return PassengerBoardingPass(
      bookingId: bookingId ?? this.bookingId,
      passengerId: passengerId ?? this.passengerId,
      tripId: tripId ?? this.tripId,
      boardingOtp: boardingOtp ?? this.boardingOtp,
      expiresAt: expiresAt ?? this.expiresAt,
      bookingStatus: bookingStatus ?? this.bookingStatus,
      driver: driver ?? this.driver,
    );
  }

  Map<String, dynamic> toJson() => {
        'bookingId': bookingId,
        'passengerId': passengerId,
        'tripId': tripId,
        'boardingOtp': boardingOtp,
        'expiresAt': expiresAt.toIso8601String(),
        'bookingStatus': bookingStatus,
        'driver': driver.toJson(),
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PassengerBoardingPass &&
          runtimeType == other.runtimeType &&
          bookingId == other.bookingId &&
          passengerId == other.passengerId &&
          tripId == other.tripId &&
          boardingOtp == other.boardingOtp &&
          bookingStatus == other.bookingStatus;

  @override
  int get hashCode => Object.hash(
        bookingId,
        passengerId,
        tripId,
        boardingOtp,
        bookingStatus,
      );
}
