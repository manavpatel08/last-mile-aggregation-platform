import 'package:flutter/foundation.dart';

/// Typed representation of a registered vehicle linked to a driver profile
/// returned by `GET /api/v1/drivers/vehicles`.
@immutable
class DriverVehicle {
  const DriverVehicle({
    required this.id,
    required this.driverProfileId,
    required this.registrationNumber,
    required this.vehicleType,
    required this.passengerCapacity,
    required this.makeModel,
    required this.isActive,
    this.createdAt,
  });

  factory DriverVehicle.fromJson(Map<String, dynamic> json) {
    final rawId = json['id'];
    if (rawId == null || rawId is! String || rawId.trim().isEmpty) {
      throw const FormatException('Missing or invalid id in DriverVehicle');
    }

    final rawDriverProfileId = json['driverProfileId'];
    if (rawDriverProfileId == null ||
        rawDriverProfileId is! String ||
        rawDriverProfileId.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid driverProfileId in DriverVehicle',
      );
    }

    final rawReg = json['registrationNumber'];
    if (rawReg == null || rawReg is! String || rawReg.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid registrationNumber in DriverVehicle',
      );
    }

    final rawType = json['vehicleType'];
    if (rawType == null || rawType is! String || rawType.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid vehicleType in DriverVehicle',
      );
    }

    final rawCapacity = json['passengerCapacity'];
    if (rawCapacity == null || rawCapacity is! num || rawCapacity <= 0) {
      throw const FormatException(
        'Missing or invalid passengerCapacity in DriverVehicle',
      );
    }

    final rawMakeModel = json['makeModel'];
    if (rawMakeModel == null ||
        rawMakeModel is! String ||
        rawMakeModel.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid makeModel in DriverVehicle',
      );
    }

    final rawIsActive = json['isActive'];
    if (rawIsActive == null || rawIsActive is! bool) {
      throw const FormatException(
        'Missing or invalid isActive in DriverVehicle',
      );
    }

    DateTime? createdAt;
    final rawCreatedAt = json['createdAt'];
    if (rawCreatedAt is String && rawCreatedAt.trim().isNotEmpty) {
      createdAt = DateTime.tryParse(rawCreatedAt);
    }

    return DriverVehicle(
      id: rawId.trim(),
      driverProfileId: rawDriverProfileId.trim(),
      registrationNumber: rawReg.trim(),
      vehicleType: rawType.trim(),
      passengerCapacity: rawCapacity.toInt(),
      makeModel: rawMakeModel.trim(),
      isActive: rawIsActive,
      createdAt: createdAt,
    );
  }

  final String id;
  final String driverProfileId;
  final String registrationNumber;
  final String vehicleType;
  final int passengerCapacity;
  final String makeModel;
  final bool isActive;
  final DateTime? createdAt;

  Map<String, dynamic> toJson() => {
        'id': id,
        'driverProfileId': driverProfileId,
        'registrationNumber': registrationNumber,
        'vehicleType': vehicleType,
        'passengerCapacity': passengerCapacity,
        'makeModel': makeModel,
        'isActive': isActive,
        if (createdAt != null) 'createdAt': createdAt!.toIso8601String(),
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DriverVehicle &&
          runtimeType == other.runtimeType &&
          id == other.id &&
          driverProfileId == other.driverProfileId &&
          registrationNumber == other.registrationNumber &&
          vehicleType == other.vehicleType &&
          passengerCapacity == other.passengerCapacity &&
          makeModel == other.makeModel &&
          isActive == other.isActive;

  @override
  int get hashCode => Object.hash(
        id,
        driverProfileId,
        registrationNumber,
        vehicleType,
        passengerCapacity,
        makeModel,
        isActive,
      );
}
