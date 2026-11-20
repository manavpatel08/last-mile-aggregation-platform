import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/features/driver/models/driver_onboarding_request.dart';

void main() {
  group('DriverOnboarding Models', () {
    test('VehicleType parses string values case-insensitively with fallback', () {
      expect(VehicleType.fromString('E_RICKSHAW'), VehicleType.eRickshaw);
      expect(VehicleType.fromString('bike_taxi'), VehicleType.bikeTaxi);
      expect(VehicleType.fromString('SHUTTLE_VAN'), VehicleType.shuttleVan);
      expect(VehicleType.fromString('UNKNOWN'), VehicleType.eRickshaw);
    });

    test('DriverOnboardingRequest serializes to exact backend specification', () {
      const request = DriverOnboardingRequest(
        licenseNumber: 'GJ-01-2023-0012345',
        vehicle: VehicleDetails(
          registrationNumber: 'GJ-01-AA-1234',
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo',
        ),
      );

      final json = request.toJson();

      expect(json, {
        'licenseNumber': 'GJ-01-2023-0012345',
        'vehicle': {
          'registrationNumber': 'GJ-01-AA-1234',
          'vehicleType': 'E_RICKSHAW',
          'passengerCapacity': 4,
          'makeModel': 'Mahindra Treo',
        },
      });
    });

    test('DriverOnboardingRequest deserializes round-trip from JSON', () {
      final json = {
        'licenseNumber': 'GJ-01-2023-99999',
        'vehicle': {
          'registrationNumber': 'GJ-01-BB-5678',
          'vehicleType': 'BIKE_TAXI',
          'passengerCapacity': 1,
          'makeModel': 'Hero Electric Splendor',
        },
      };

      final parsed = DriverOnboardingRequest.fromJson(json);

      expect(parsed.licenseNumber, 'GJ-01-2023-99999');
      expect(parsed.vehicle.registrationNumber, 'GJ-01-BB-5678');
      expect(parsed.vehicle.vehicleType, 'BIKE_TAXI');
      expect(parsed.vehicle.passengerCapacity, 1);
      expect(parsed.vehicle.makeModel, 'Hero Electric Splendor');
    });

    test('DriverOnboardingResponse parses 201 backend response envelope', () {
      final responseJson = {
        'success': true,
        'message': 'Driver onboarding application submitted successfully',
        'data': {
          'driverProfile': {
            'id': 'dp-uuid-123',
            'userId': 'usr-uuid-456',
            'licenseNumber': 'GJ-01-2023-0012345',
            'verificationStatus': 'PENDING',
            'operationalStatus': 'OFFLINE',
            'isOnline': false,
          },
          'vehicle': {
            'id': 'veh-uuid-789',
            'registrationNumber': 'GJ-01-AA-1234',
            'vehicleType': 'E_RICKSHAW',
            'passengerCapacity': 4,
            'makeModel': 'Mahindra Treo',
            'isActive': true,
          },
        },
      };

      final response = DriverOnboardingResponse.fromJson(responseJson);

      expect(response.message, 'Driver onboarding application submitted successfully');
      expect(response.driverProfile.id, 'dp-uuid-123');
      expect(response.driverProfile.verificationStatus, 'PENDING');
      expect(response.driverProfile.operationalStatus, 'OFFLINE');
      expect(response.driverProfile.isApproved, isFalse);
      expect(response.vehicle['registrationNumber'], 'GJ-01-AA-1234');
      expect(response.vehicle['passengerCapacity'], 4);
    });
  });
}
