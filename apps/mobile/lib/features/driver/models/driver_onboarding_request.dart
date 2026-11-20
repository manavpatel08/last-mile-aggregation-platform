import '../../auth/models/auth_user.dart';

/// Supported vehicle types aligned with backend enum values.
enum VehicleType {
  eRickshaw('E_RICKSHAW', 'E-Rickshaw'),
  bikeTaxi('BIKE_TAXI', 'Bike Taxi'),
  shuttleVan('SHUTTLE_VAN', 'Shuttle Van');

  const VehicleType(this.value, this.label);

  final String value;
  final String label;

  static VehicleType fromString(String value) {
    switch (value.trim().toUpperCase()) {
      case 'BIKE_TAXI':
        return VehicleType.bikeTaxi;
      case 'SHUTTLE_VAN':
        return VehicleType.shuttleVan;
      case 'E_RICKSHAW':
      default:
        return VehicleType.eRickshaw;
    }
  }
}

/// Vehicle specifications payload for driver onboarding.
class VehicleDetails {
  const VehicleDetails({
    required this.registrationNumber,
    this.vehicleType = 'E_RICKSHAW',
    this.passengerCapacity = 4,
    required this.makeModel,
  });

  final String registrationNumber;
  final String vehicleType;
  final int passengerCapacity;
  final String makeModel;

  Map<String, dynamic> toJson() => {
        'registrationNumber': registrationNumber,
        'vehicleType': vehicleType,
        'passengerCapacity': passengerCapacity,
        'makeModel': makeModel,
      };

  factory VehicleDetails.fromJson(Map<String, dynamic> json) {
    return VehicleDetails(
      registrationNumber: json['registrationNumber'] as String? ?? '',
      vehicleType: json['vehicleType'] as String? ?? 'E_RICKSHAW',
      passengerCapacity: json['passengerCapacity'] as int? ?? 4,
      makeModel: json['makeModel'] as String? ?? '',
    );
  }
}

/// Request body for `POST /api/v1/drivers/onboard`.
class DriverOnboardingRequest {
  const DriverOnboardingRequest({
    required this.licenseNumber,
    required this.vehicle,
  });

  final String licenseNumber;
  final VehicleDetails vehicle;

  Map<String, dynamic> toJson() => {
        'licenseNumber': licenseNumber,
        'vehicle': vehicle.toJson(),
      };

  factory DriverOnboardingRequest.fromJson(Map<String, dynamic> json) {
    return DriverOnboardingRequest(
      licenseNumber: json['licenseNumber'] as String? ?? '',
      vehicle: VehicleDetails.fromJson(
        json['vehicle'] as Map<String, dynamic>? ?? const {},
      ),
    );
  }
}

/// Response payload from `POST /api/v1/drivers/onboard`.
class DriverOnboardingResponse {
  const DriverOnboardingResponse({
    required this.driverProfile,
    required this.vehicle,
    this.message,
  });

  factory DriverOnboardingResponse.fromJson(Map<String, dynamic> json) {
    final data = json['data'] as Map<String, dynamic>? ?? json;
    final rawProfile = data['driverProfile'] as Map<String, dynamic>? ?? const {};
    final rawVehicle = data['vehicle'] as Map<String, dynamic>? ?? const {};

    return DriverOnboardingResponse(
      driverProfile: DriverProfile.fromJson(rawProfile),
      vehicle: rawVehicle,
      message: json['message'] as String?,
    );
  }

  final DriverProfile driverProfile;
  final Map<String, dynamic> vehicle;
  final String? message;
}
