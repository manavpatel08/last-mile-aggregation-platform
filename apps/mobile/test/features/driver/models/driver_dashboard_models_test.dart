import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/features/driver/models/driver_status_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_vehicle.dart';

void main() {
  group('DriverStatusResponse Model Tests', () {
    final validStatusJson = {
      'id': 'dp-123e4567-e89b-12d3-a456-426614174000',
      'verificationStatus': 'APPROVED',
      'operationalStatus': 'AVAILABLE',
      'isOnline': true,
      'vehiclesCount': 2,
    };

    test('fromJson parses valid approved status payload correctly', () {
      final status = DriverStatusResponse.fromJson(validStatusJson);

      expect(status.id, 'dp-123e4567-e89b-12d3-a456-426614174000');
      expect(status.verificationStatus, 'APPROVED');
      expect(status.operationalStatus, 'AVAILABLE');
      expect(status.isOnline, isTrue);
      expect(status.vehiclesCount, 2);
      expect(status.isApproved, isTrue);
      expect(status.isAvailable, isTrue);
    });

    test('fromJson parses offline status payload correctly', () {
      final status = DriverStatusResponse.fromJson({
        'id': 'dp-1',
        'verificationStatus': 'APPROVED',
        'operationalStatus': 'OFFLINE',
        'isOnline': false,
        'vehiclesCount': 0,
      });

      expect(status.isApproved, isTrue);
      expect(status.isAvailable, isFalse);
      expect(status.isOnline, isFalse);
      expect(status.vehiclesCount, 0);
    });

    test('toJson serializes status correctly', () {
      final status = DriverStatusResponse.fromJson(validStatusJson);
      final json = status.toJson();

      expect(json['id'], validStatusJson['id']);
      expect(json['verificationStatus'], 'APPROVED');
      expect(json['operationalStatus'], 'AVAILABLE');
      expect(json['isOnline'], true);
      expect(json['vehiclesCount'], 2);
    });

    test('value equality works as expected', () {
      final a = DriverStatusResponse.fromJson(validStatusJson);
      final b = DriverStatusResponse.fromJson(validStatusJson);

      expect(a, equals(b));
      expect(a.hashCode, equals(b.hashCode));
    });

    test('throws FormatException for missing or empty id', () {
      expect(
        () => DriverStatusResponse.fromJson({
          ...validStatusJson,
          'id': null,
        }),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => DriverStatusResponse.fromJson({
          ...validStatusJson,
          'id': '   ',
        }),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing or empty verificationStatus', () {
      expect(
        () => DriverStatusResponse.fromJson({
          ...validStatusJson,
          'verificationStatus': '',
        }),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing or empty operationalStatus', () {
      expect(
        () => DriverStatusResponse.fromJson({
          ...validStatusJson,
          'operationalStatus': null,
        }),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing or invalid isOnline', () {
      expect(
        () => DriverStatusResponse.fromJson({
          ...validStatusJson,
          'isOnline': 'true',
        }),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => DriverStatusResponse.fromJson({
          ...validStatusJson,
          'isOnline': null,
        }),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing or non-numeric vehiclesCount', () {
      expect(
        () => DriverStatusResponse.fromJson({
          ...validStatusJson,
          'vehiclesCount': 'two',
        }),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => DriverStatusResponse.fromJson({
          ...validStatusJson,
          'vehiclesCount': null,
        }),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('DriverVehicle Model Tests', () {
    final validVehicleJson = {
      'id': 'veh-123e4567-e89b-12d3-a456-426614174000',
      'driverProfileId': 'dp-123e4567-e89b-12d3-a456-426614174000',
      'registrationNumber': 'GJ-01-AB-1234',
      'vehicleType': 'E_RICKSHAW',
      'passengerCapacity': 4,
      'makeModel': 'Mahindra Treo',
      'isActive': true,
      'createdAt': '2026-11-20T10:00:00.000Z',
    };

    test('fromJson parses valid vehicle payload correctly', () {
      final vehicle = DriverVehicle.fromJson(validVehicleJson);

      expect(vehicle.id, 'veh-123e4567-e89b-12d3-a456-426614174000');
      expect(vehicle.driverProfileId, 'dp-123e4567-e89b-12d3-a456-426614174000');
      expect(vehicle.registrationNumber, 'GJ-01-AB-1234');
      expect(vehicle.vehicleType, 'E_RICKSHAW');
      expect(vehicle.passengerCapacity, 4);
      expect(vehicle.makeModel, 'Mahindra Treo');
      expect(vehicle.isActive, isTrue);
      expect(vehicle.createdAt, DateTime.parse('2026-11-20T10:00:00.000Z'));
    });

    test('fromJson parses vehicle without createdAt', () {
      final vehicle = DriverVehicle.fromJson({
        ...validVehicleJson,
        'createdAt': null,
      });

      expect(vehicle.createdAt, isNull);
    });

    test('toJson serializes vehicle correctly', () {
      final vehicle = DriverVehicle.fromJson(validVehicleJson);
      final json = vehicle.toJson();

      expect(json['id'], validVehicleJson['id']);
      expect(json['registrationNumber'], 'GJ-01-AB-1234');
      expect(json['vehicleType'], 'E_RICKSHAW');
      expect(json['passengerCapacity'], 4);
      expect(json['makeModel'], 'Mahindra Treo');
      expect(json['isActive'], true);
    });

    test('value equality works as expected', () {
      final a = DriverVehicle.fromJson(validVehicleJson);
      final b = DriverVehicle.fromJson(validVehicleJson);

      expect(a, equals(b));
      expect(a.hashCode, equals(b.hashCode));
    });

    test('throws FormatException for missing or invalid id', () {
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'id': ''}),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing driverProfileId', () {
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'driverProfileId': null}),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing registrationNumber', () {
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'registrationNumber': '  '}),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing vehicleType', () {
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'vehicleType': null}),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing or non-positive capacity', () {
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'passengerCapacity': 0}),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'passengerCapacity': -1}),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'passengerCapacity': '4'}),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing makeModel', () {
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'makeModel': ''}),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws FormatException for missing isActive', () {
      expect(
        () => DriverVehicle.fromJson({...validVehicleJson, 'isActive': 'true'}),
        throwsA(isA<FormatException>()),
      );
    });
  });
}
