import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/driver/data/driver_repository.dart';
import 'package:lastmile_mobile/features/driver/models/driver_onboarding_request.dart';
import 'package:lastmile_mobile/features/driver/models/driver_status_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_vehicle.dart';
import 'package:lastmile_mobile/features/driver/state/driver_home_provider.dart';

import '../../../helpers/test_fakes.dart';

/// Test repository enabling deterministic control over async request completion order.
class ControllableDriverRepository implements DriverRepository {
  Completer<DriverStatusResponse>? statusCompleter;
  Completer<List<DriverVehicle>>? vehiclesCompleter;
  int getStatusCallCount = 0;
  int getVehiclesCallCount = 0;

  @override
  Future<DriverOnboardingResponse> onboardDriver(DriverOnboardingRequest request) async {
    throw UnimplementedError();
  }

  @override
  Future<DriverStatusResponse> getDriverStatus() async {
    getStatusCallCount++;
    if (statusCompleter != null) {
      return statusCompleter!.future;
    }
    return const DriverStatusResponse(
      id: 'default-status',
      verificationStatus: 'APPROVED',
      operationalStatus: 'AVAILABLE',
      isOnline: true,
      vehiclesCount: 1,
    );
  }

  @override
  Future<List<DriverVehicle>> getVehicles() async {
    getVehiclesCallCount++;
    if (vehiclesCompleter != null) {
      return vehiclesCompleter!.future;
    }
    return const [];
  }
}

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

    test('loadDashboard captures error when getVehicles fails for PENDING driver without calling getDriverStatus', () async {
      fakeRepo.shouldThrowOnVehicles = true;
      fakeRepo.vehiclesException = const ApiException(
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Driver profile not found',
      );

      await provider.loadDashboard(verificationStatus: 'PENDING');

      expect(provider.isLoading, isFalse);
      expect(provider.hasError, isTrue);
      expect(provider.error, contains('Driver profile not found'));
      expect(provider.vehicles, isEmpty);
      expect(provider.hasLoaded, isFalse);
      expect(fakeRepo.getStatusCallCount, 0);
    });

    test('refreshDashboard captures error and preserves existing vehicles when getVehicles fails for PENDING driver', () async {
      await provider.loadDashboard(verificationStatus: 'PENDING');
      expect(provider.hasLoaded, isTrue);
      expect(provider.vehicles, equals([testVehicle]));

      fakeRepo.shouldThrowOnVehicles = true;
      fakeRepo.vehiclesException = const ApiException(
        statusCode: 503,
        errorCode: 'SERVICE_UNAVAILABLE',
        message: 'Vehicle service unavailable',
      );

      await provider.refreshDashboard(verificationStatus: 'PENDING');

      expect(provider.isRefreshing, isFalse);
      expect(provider.hasError, isTrue);
      expect(provider.error, contains('Vehicle service unavailable'));
      // Existing vehicle data must be preserved across a failed refresh
      expect(provider.vehicles, equals([testVehicle]));
      expect(fakeRepo.getStatusCallCount, 0);
    });

    test('clear resets all dashboard state and currentUserId across account logout', () async {
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-100');
      expect(provider.hasLoaded, isTrue);
      expect(provider.status, isNotNull);
      expect(provider.vehicles, isNotEmpty);
      expect(provider.currentUserId, 'user-100');

      provider.clear();

      expect(provider.isLoading, isFalse);
      expect(provider.isRefreshing, isFalse);
      expect(provider.hasError, isFalse);
      expect(provider.error, isNull);
      expect(provider.status, isNull);
      expect(provider.vehicles, isEmpty);
      expect(provider.hasLoaded, isFalse);
      expect(provider.currentUserId, isNull);
      expect(provider.vehicleCount, 0);
      expect(provider.operationalStatus, 'OFFLINE');
    });

    test('loadDashboard with a different userId purges previous user data immediately', () async {
      await provider.loadDashboard(verificationStatus: 'APPROVED', userId: 'user-A');
      expect(provider.status, equals(testStatus));
      expect(provider.vehicles, equals([testVehicle]));
      expect(provider.currentUserId, 'user-A');

      // Next user starts loading with error or delay
      fakeRepo.shouldThrowOnVehicles = true;
      fakeRepo.vehiclesException = const ApiException(
        statusCode: 500,
        errorCode: 'INTERNAL_ERROR',
        message: 'Server error',
      );

      await provider.loadDashboard(verificationStatus: 'PENDING', userId: 'user-B');

      expect(provider.currentUserId, 'user-B');
      expect(provider.hasError, isTrue);
      // User A's data must be gone
      expect(provider.status, isNull);
      expect(provider.vehicles, isEmpty);
      expect(provider.hasLoaded, isFalse);
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

  group('DriverHomeProvider Request Invalidation & Asynchronous Race Prevention', () {
    test('Scenario A - stale success: Driver A load response completing after Driver B login does not overwrite Driver B state', () async {
      final repo = ControllableDriverRepository();
      final provider = DriverHomeProvider(driverRepository: repo);

      // 1. Driver A starts loadDashboard()
      final driverAStatusCompleter = Completer<DriverStatusResponse>();
      final driverAVehiclesCompleter = Completer<List<DriverVehicle>>();
      repo.statusCompleter = driverAStatusCompleter;
      repo.vehiclesCompleter = driverAVehiclesCompleter;

      final driverAFuture = provider.loadDashboard(
        verificationStatus: 'APPROVED',
        userId: 'driver-A',
      );

      expect(provider.isLoading, isTrue);
      expect(provider.currentUserId, 'driver-A');

      // 2 & 3. Clear A's state and switch to Driver B
      repo.statusCompleter = null; // Driver B completes immediately
      repo.vehiclesCompleter = null;

      const driverBStatus = DriverStatusResponse(
        id: 'dp-driver-B',
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
        vehiclesCount: 2,
      );
      const driverBVehicle = DriverVehicle(
        id: 'veh-driver-B',
        driverProfileId: 'dp-driver-B',
        registrationNumber: 'GJ-02-BB-2222',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Driver B Vehicle',
        isActive: true,
      );

      // 4. Driver B starts and completes loading
      final driverBRepo = FakeDriverRepository(
        statusResponse: driverBStatus,
        vehiclesResponse: [driverBVehicle],
      );

      await provider.loadDashboard(
        verificationStatus: 'APPROVED',
        userId: 'driver-B',
        repository: driverBRepo,
      );

      expect(provider.currentUserId, 'driver-B');
      expect(provider.status, equals(driverBStatus));
      expect(provider.vehicles, equals([driverBVehicle]));
      expect(provider.isLoading, isFalse);
      expect(provider.hasLoaded, isTrue);

      // 5. Complete Driver A's old response
      const driverAOldStatus = DriverStatusResponse(
        id: 'dp-driver-A',
        verificationStatus: 'APPROVED',
        operationalStatus: 'OFFLINE',
        isOnline: false,
        vehiclesCount: 1,
      );
      const driverAOldVehicle = DriverVehicle(
        id: 'veh-driver-A',
        driverProfileId: 'dp-driver-A',
        registrationNumber: 'GJ-01-AA-1111',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Driver A Vehicle',
        isActive: true,
      );

      driverAStatusCompleter.complete(driverAOldStatus);
      driverAVehiclesCompleter.complete([driverAOldVehicle]);
      await driverAFuture;

      // 6. Verify Driver B's status and vehicles remain completely unchanged
      expect(provider.currentUserId, 'driver-B');
      expect(provider.status, equals(driverBStatus));
      expect(provider.vehicles, equals([driverBVehicle]));
      expect(provider.hasLoaded, isTrue);
      expect(provider.isLoading, isFalse);
    });

    test('Scenario B - stale failure: Driver A load exception completing after Driver B login does not appear in Driver B dashboard', () async {
      final repo = ControllableDriverRepository();
      final provider = DriverHomeProvider(driverRepository: repo);

      // 1. Driver A starts loading
      final driverAStatusCompleter = Completer<DriverStatusResponse>();
      final driverAVehiclesCompleter = Completer<List<DriverVehicle>>();
      repo.statusCompleter = driverAStatusCompleter;
      repo.vehiclesCompleter = driverAVehiclesCompleter;

      final driverAFuture = provider.loadDashboard(
        verificationStatus: 'APPROVED',
        userId: 'driver-A',
      );

      // 2. Log A out and start Driver B's dashboard
      provider.clear();
      expect(provider.currentUserId, isNull);

      const driverBVehicle = DriverVehicle(
        id: 'veh-driver-B',
        driverProfileId: 'dp-driver-B',
        registrationNumber: 'GJ-02-BB-2222',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Driver B Vehicle',
        isActive: true,
      );
      final driverBRepo = FakeDriverRepository(
        vehiclesResponse: [driverBVehicle],
      );

      await provider.loadDashboard(
        verificationStatus: 'PENDING',
        userId: 'driver-B',
        repository: driverBRepo,
      );

      expect(provider.currentUserId, 'driver-B');
      expect(provider.hasError, isFalse);
      expect(provider.error, isNull);
      expect(provider.vehicles, equals([driverBVehicle]));

      // 3. Complete A's request with an exception
      driverAStatusCompleter.completeError(
        const ApiException(statusCode: 500, errorCode: 'ERROR', message: 'Driver A network crash'),
      );
      driverAVehiclesCompleter.completeError(
        const ApiException(statusCode: 500, errorCode: 'ERROR', message: 'Driver A vehicle crash'),
      );
      await driverAFuture;

      // 4. Verify A's exception does not appear in B's dashboard
      expect(provider.currentUserId, 'driver-B');
      expect(provider.hasError, isFalse);
      expect(provider.error, isNull);
      expect(provider.vehicles, equals([driverBVehicle]));
      expect(provider.hasLoaded, isTrue);
      expect(provider.isLoading, isFalse);
    });

    test('Scenario C - stale refresh: Driver A refresh response completing after account switch does not modify Driver B state or indicators', () async {
      final repo = ControllableDriverRepository();
      final provider = DriverHomeProvider(driverRepository: repo);

      const initialVehicle = DriverVehicle(
        id: 'veh-driver-A',
        driverProfileId: 'dp-driver-A',
        registrationNumber: 'GJ-01-AA-1111',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Driver A Vehicle',
        isActive: true,
      );

      // Initialize Driver A
      final immediateRepo = FakeDriverRepository(vehiclesResponse: [initialVehicle]);
      await provider.loadDashboard(
        verificationStatus: 'PENDING',
        userId: 'driver-A',
        repository: immediateRepo,
      );
      expect(provider.vehicles, equals([initialVehicle]));

      // 1. Driver A starts refreshDashboard() with pending completer
      repo.vehiclesCompleter = Completer<List<DriverVehicle>>();
      final refreshFuture = provider.refreshDashboard(
        verificationStatus: 'PENDING',
        userId: 'driver-A',
        repository: repo,
      );
      expect(provider.isRefreshing, isTrue);

      // 2. Switch accounts while the refresh is pending
      const driverBVehicle = DriverVehicle(
        id: 'veh-driver-B',
        driverProfileId: 'dp-driver-B',
        registrationNumber: 'GJ-02-BB-2222',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Driver B Vehicle',
        isActive: true,
      );
      final driverBRepo = FakeDriverRepository(vehiclesResponse: [driverBVehicle]);
      await provider.loadDashboard(
        verificationStatus: 'PENDING',
        userId: 'driver-B',
        repository: driverBRepo,
      );

      expect(provider.currentUserId, 'driver-B');
      expect(provider.vehicles, equals([driverBVehicle]));
      expect(provider.isRefreshing, isFalse);

      // 3. Complete A's old refresh
      repo.vehiclesCompleter!.complete([
        const DriverVehicle(
          id: 'veh-stale-A',
          driverProfileId: 'dp-driver-A',
          registrationNumber: 'GJ-01-STALE',
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Stale Vehicle',
          isActive: true,
        ),
      ]);
      await refreshFuture;

      // 4. Verify it cannot modify B's state or loading indicators
      expect(provider.currentUserId, 'driver-B');
      expect(provider.vehicles, equals([driverBVehicle]));
      expect(provider.isRefreshing, isFalse);
      expect(provider.hasError, isFalse);
    });

    test('Scenario D - current requests complete normally after old requests are invalidated', () async {
      final repo = ControllableDriverRepository();
      final provider = DriverHomeProvider(driverRepository: repo);

      // Invalidate old request 1
      repo.statusCompleter = Completer<DriverStatusResponse>();
      repo.vehiclesCompleter = Completer<List<DriverVehicle>>();
      final oldFuture1 = provider.loadDashboard(
        verificationStatus: 'APPROVED',
        userId: 'user-old-1',
      );

      // Invalidate old request 2 via clear()
      provider.clear();

      // Active current request for user-active
      const activeStatus = DriverStatusResponse(
        id: 'dp-active',
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
        vehiclesCount: 1,
      );
      const activeVehicle = DriverVehicle(
        id: 'veh-active',
        driverProfileId: 'dp-active',
        registrationNumber: 'GJ-05-AA-5555',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Active Vehicle',
        isActive: true,
      );
      final activeRepo = FakeDriverRepository(
        statusResponse: activeStatus,
        vehiclesResponse: [activeVehicle],
      );

      await provider.loadDashboard(
        verificationStatus: 'APPROVED',
        userId: 'user-active',
        repository: activeRepo,
      );

      expect(provider.currentUserId, 'user-active');
      expect(provider.status, equals(activeStatus));
      expect(provider.vehicles, equals([activeVehicle]));
      expect(provider.hasLoaded, isTrue);
      expect(provider.isLoading, isFalse);

      // Old request finally resolves
      repo.statusCompleter!.complete(const DriverStatusResponse(
        id: 'dp-old-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'OFFLINE',
        isOnline: false,
        vehiclesCount: 0,
      ));
      repo.vehiclesCompleter!.complete([]);
      await oldFuture1;

      // Active state remains completely valid and untouched
      expect(provider.currentUserId, 'user-active');
      expect(provider.status, equals(activeStatus));
      expect(provider.vehicles, equals([activeVehicle]));
      expect(provider.hasLoaded, isTrue);
      expect(provider.isLoading, isFalse);
    });

    test('superseded refresh: new loadDashboard for same user properly resets obsolete refresh state and allows future refreshes', () async {
      final repo = ControllableDriverRepository();
      final provider = DriverHomeProvider(driverRepository: repo);

      const initialVehicle = DriverVehicle(
        id: 'veh-initial',
        driverProfileId: 'dp-user-1',
        registrationNumber: 'GJ-01-INIT',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Initial Model',
        isActive: true,
      );

      // Initialize dashboard for user-1
      final initialRepo = FakeDriverRepository(vehiclesResponse: [initialVehicle]);
      await provider.loadDashboard(
        verificationStatus: 'PENDING',
        userId: 'user-1',
        repository: initialRepo,
      );
      expect(provider.vehicles, equals([initialVehicle]));
      expect(provider.hasLoaded, isTrue);

      // 1. Start a refresh for user-1 with a pending Completer
      final refreshCompleter = Completer<List<DriverVehicle>>();
      repo.vehiclesCompleter = refreshCompleter;

      final refreshFuture = provider.refreshDashboard(
        verificationStatus: 'PENDING',
        userId: 'user-1',
        repository: repo,
      );
      expect(provider.isRefreshing, isTrue);

      // 2. Start a new dashboard load for the SAME user before refresh completes
      const loadedVehicle = DriverVehicle(
        id: 'veh-loaded',
        driverProfileId: 'dp-user-1',
        registrationNumber: 'GJ-01-LOADED',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Loaded Model',
        isActive: true,
      );
      final loadRepo = FakeDriverRepository(vehiclesResponse: [loadedVehicle]);

      // 3. Complete the new load
      await provider.loadDashboard(
        verificationStatus: 'PENDING',
        userId: 'user-1',
        repository: loadRepo,
      );

      expect(provider.isLoading, isFalse);
      expect(provider.isRefreshing, isFalse);
      expect(provider.vehicles, equals([loadedVehicle]));

      // 4. Complete the old refresh with stale data
      refreshCompleter.complete([
        const DriverVehicle(
          id: 'veh-stale',
          driverProfileId: 'dp-user-1',
          registrationNumber: 'GJ-01-STALE',
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Stale Model',
          isActive: true,
        ),
      ]);
      await refreshFuture;

      // 5. Verify isRefreshing remains false and state is preserved
      expect(provider.isRefreshing, isFalse);
      expect(provider.vehicles, equals([loadedVehicle]));

      // 6. Verify a subsequent refreshDashboard() call succeeds normally
      const subsequentVehicle = DriverVehicle(
        id: 'veh-subsequent',
        driverProfileId: 'dp-user-1',
        registrationNumber: 'GJ-01-SUBS',
        vehicleType: 'E_RICKSHAW',
        passengerCapacity: 4,
        makeModel: 'Subsequent Model',
        isActive: true,
      );
      final subsequentRepo = FakeDriverRepository(vehiclesResponse: [subsequentVehicle]);

      await provider.refreshDashboard(
        verificationStatus: 'PENDING',
        userId: 'user-1',
        repository: subsequentRepo,
      );

      expect(provider.isRefreshing, isFalse);
      expect(provider.vehicles, equals([subsequentVehicle]));
    });
  });
}
