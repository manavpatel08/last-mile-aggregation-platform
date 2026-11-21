import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/driver/models/driver_status_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_vehicle.dart';
import 'package:lastmile_mobile/features/driver/state/driver_home_provider.dart';

import '../../../helpers/test_fakes.dart';

void main() {
  group('DriverHomeProvider Unit Tests', () {
    late FakeDriverRepository fakeRepo;
    late DriverHomeProvider provider;

    const testStatus = DriverStatusResponse(
      id: 'dp-100',
      verificationStatus: 'APPROVED',
      operationalStatus: 'AVAILABLE',
      isOnline: true,
      vehiclesCount: 1,
    );

    const testVehicle = DriverVehicle(
      id: 'veh-100',
      driverProfileId: 'dp-100',
      registrationNumber: 'GJ-01-AB-1234',
      vehicleType: 'E_RICKSHAW',
      passengerCapacity: 4,
      makeModel: 'Mahindra Treo',
      isActive: true,
    );

    setUp(() {
      fakeRepo = FakeDriverRepository(
        statusResponse: testStatus,
        vehiclesResponse: [testVehicle],
      );
      provider = DriverHomeProvider(driverRepository: fakeRepo);
    });

    test('initial state is uninitialized', () {
      expect(provider.isLoading, isFalse);
      expect(provider.isRefreshing, isFalse);
      expect(provider.hasError, isFalse);
      expect(provider.error, isNull);
      expect(provider.status, isNull);
      expect(provider.vehicles, isEmpty);
      expect(provider.hasLoaded, isFalse);
      expect(provider.vehicleCount, 0);
      expect(provider.isOnline, isFalse);
      expect(provider.operationalStatus, 'OFFLINE');
    });

    test('loadDashboard for APPROVED driver calls both status and vehicles', () async {
      await provider.loadDashboard(verificationStatus: 'APPROVED');

      expect(provider.isLoading, isFalse);
      expect(provider.hasError, isFalse);
      expect(provider.hasLoaded, isTrue);
      expect(fakeRepo.getStatusCallCount, 1);
      expect(fakeRepo.getVehiclesCallCount, 1);

      expect(provider.status, equals(testStatus));
      expect(provider.vehicles, equals([testVehicle]));
      expect(provider.vehicleCount, 1);
      expect(provider.isOnline, isTrue);
      expect(provider.operationalStatus, 'AVAILABLE');
      expect(provider.statusSummary, contains('AVAILABLE'));
      expect(provider.statusSummary, contains('Online'));
    });

    test('loadDashboard for PENDING driver does NOT call getDriverStatus', () async {
      await provider.loadDashboard(verificationStatus: 'PENDING');

      expect(provider.isLoading, isFalse);
      expect(provider.hasError, isFalse);
      expect(provider.hasLoaded, isTrue);
      // Operational status endpoint is guarded by @RequireDriverApproval()
      // Must NOT be called for PENDING drivers!
      expect(fakeRepo.getStatusCallCount, 0);
      expect(fakeRepo.getVehiclesCallCount, 1);

      expect(provider.status, isNull);
      expect(provider.vehicles, equals([testVehicle]));
      expect(provider.vehicleCount, 1);
      expect(provider.isOnline, isFalse);
      expect(provider.operationalStatus, 'OFFLINE');
    });

    test('loadDashboard for REJECTED driver does NOT call getDriverStatus', () async {
      await provider.loadDashboard(verificationStatus: 'REJECTED');

      expect(fakeRepo.getStatusCallCount, 0);
      expect(fakeRepo.getVehiclesCallCount, 1);
      expect(provider.status, isNull);
    });

    test('loadDashboard for SUSPENDED driver does NOT call getDriverStatus', () async {
      await provider.loadDashboard(verificationStatus: 'SUSPENDED');

      expect(fakeRepo.getStatusCallCount, 0);
      expect(fakeRepo.getVehiclesCallCount, 1);
      expect(provider.status, isNull);
    });

    test('loadDashboard handles vehicle fetch failure for non-approved user safely', () async {
      fakeRepo.shouldThrowOnVehicles = true;
      fakeRepo.vehiclesException = const ApiException(
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Driver profile not found',
      );

      await provider.loadDashboard(verificationStatus: 'PENDING');

      expect(provider.isLoading, isFalse);
      expect(provider.hasError, isFalse);
      expect(provider.vehicles, isEmpty);
      expect(provider.hasLoaded, isTrue);
    });

    test('loadDashboard captures error when getDriverStatus fails for APPROVED driver', () async {
      fakeRepo.shouldThrowOnStatus = true;
      fakeRepo.statusException = const ApiException(
        statusCode: 500,
        errorCode: 'SERVER_ERROR',
        message: 'Database connection failed',
      );

      await provider.loadDashboard(verificationStatus: 'APPROVED');

      expect(provider.isLoading, isFalse);
      expect(provider.hasError, isTrue);
      expect(provider.error, contains('Database connection failed'));
      expect(provider.status, isNull);
    });

    test('loadDashboard captures error when getVehicles fails for APPROVED driver', () async {
      fakeRepo.shouldThrowOnVehicles = true;
      fakeRepo.vehiclesException = const ApiException(
        statusCode: 503,
        errorCode: 'SERVICE_UNAVAILABLE',
        message: 'Vehicle service down',
      );

      await provider.loadDashboard(verificationStatus: 'APPROVED');

      expect(provider.isLoading, isFalse);
      expect(provider.hasError, isTrue);
      expect(provider.error, contains('Vehicle service down'));
    });

    test('refreshDashboard updates dashboard without clearing previous data', () async {
      await provider.loadDashboard(verificationStatus: 'APPROVED');
      expect(provider.hasLoaded, isTrue);

      const updatedVehicle = DriverVehicle(
        id: 'veh-200',
        driverProfileId: 'dp-100',
        registrationNumber: 'GJ-01-XX-9999',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Mahindra Treo Plus',
        isActive: true,
      );
      fakeRepo.vehiclesResponse = [testVehicle, updatedVehicle];

      await provider.refreshDashboard(verificationStatus: 'APPROVED');

      expect(provider.isRefreshing, isFalse);
      expect(provider.vehicles.length, 2);
      expect(fakeRepo.getVehiclesCallCount, 2);
      expect(fakeRepo.getStatusCallCount, 2);
    });

    test('retry via loadDashboard clears previous error', () async {
      fakeRepo.shouldThrowOnStatus = true;
      fakeRepo.statusException = const ApiException(
        statusCode: 500,
        errorCode: 'SERVER_ERROR',
        message: 'Temporary network failure',
      );

      await provider.loadDashboard(verificationStatus: 'APPROVED');
      expect(provider.hasError, isTrue);

      // Now recover
      fakeRepo.shouldThrowOnStatus = false;
      fakeRepo.statusException = null;

      await provider.loadDashboard(verificationStatus: 'APPROVED');
      expect(provider.hasError, isFalse);
      expect(provider.error, isNull);
      expect(provider.status, equals(testStatus));
    });

    test('clearError resets error message', () async {
      fakeRepo.shouldThrowOnStatus = true;
      fakeRepo.statusException = Exception('Test failure');

      await provider.loadDashboard(verificationStatus: 'APPROVED');
      expect(provider.hasError, isTrue);

      provider.clearError();
      expect(provider.hasError, isFalse);
      expect(provider.error, isNull);
    });
  });
}
