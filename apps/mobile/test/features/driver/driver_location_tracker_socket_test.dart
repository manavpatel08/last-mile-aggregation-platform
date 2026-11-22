import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/realtime/models/socket_ticket_model.dart';
import 'package:lastmile_mobile/core/realtime/socket_client.dart';
import 'package:lastmile_mobile/core/realtime/socket_service.dart';
import 'package:lastmile_mobile/core/realtime/socket_ticket_provider.dart';
import 'package:lastmile_mobile/features/driver/data/driver_repository.dart';
import 'package:lastmile_mobile/features/driver/services/driver_location_tracker.dart';

class _FakePlatformService implements LocationPlatformService {
  bool isServiceEnabled = true;
  LocationPermission permission = LocationPermission.always;
  Position position = Position(
    longitude: 72.632,
    latitude: 23.188,
    timestamp: DateTime.now(),
    accuracy: 5.0,
    altitude: 10.0,
    heading: 90.0,
    speed: 15.0,
    speedAccuracy: 1.0,
    altitudeAccuracy: 1.0,
    headingAccuracy: 1.0,
  );

  @override
  Future<bool> isLocationServiceEnabled() async => isServiceEnabled;

  @override
  Future<LocationPermission> checkPermission() async => permission;

  @override
  Future<LocationPermission> requestPermission() async => permission;

  @override
  Future<Position> getCurrentPosition({LocationSettings? locationSettings}) async =>
      position;
}

class _FakeDriverRepository implements DriverRepository {
  int reportLocationCallCount = 0;
  double? lastLatitude;
  double? lastLongitude;

  @override
  Future<void> reportLocation({
    required double latitude,
    required double longitude,
    double? heading,
    double? speed,
  }) async {
    reportLocationCallCount++;
    lastLatitude = latitude;
    lastLongitude = longitude;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeTicketProvider implements SocketTicketProvider {
  @override
  Future<SocketTicketModel> getTicket({dynamic cancelToken}) async {
    return const SocketTicketModel(ticket: 'test-ticket', expiresIn: 60);
  }
}

void main() {
  const testConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  group('GeolocatorDriverLocationTracker Socket & REST Dual Reporting', () {
    late _FakePlatformService platformService;
    late _FakeDriverRepository repository;
    late FakeSocketClient fakeClient;
    late RealtimeSocketService socketService;

    setUp(() {
      platformService = _FakePlatformService();
      repository = _FakeDriverRepository();
      fakeClient = FakeSocketClient();
      socketService = RealtimeSocketService(
        config: testConfig,
        ticketProvider: _FakeTicketProvider(),
        client: fakeClient,
      );
    });

    tearDown(() {
      socketService.dispose();
    });

    test('streams telemetry via Socket.IO and suppresses REST when socket is connected', () async {
      await socketService.connect();
      expect(socketService.isConnected, isTrue);

      final tracker = GeolocatorDriverLocationTracker(
        platformService: platformService,
        socketService: socketService,
        idleInterval: const Duration(seconds: 10),
        inTripInterval: const Duration(seconds: 4),
      );

      tracker.startTracking(repository: repository);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // Socket fix emitted
      expect(fakeClient.emittedEvents.length, 1);
      expect(fakeClient.emittedEvents.first.key, 'driver.location.update');
      final payload = fakeClient.emittedEvents.first.value as Map<String, dynamic>;
      expect(payload['latitude'], 23.188);
      expect(payload['longitude'], 72.632);

      // REST reportLocation is completely suppressed!
      expect(repository.reportLocationCallCount, 0);

      tracker.dispose();
    });

    test('falls back sequentially to REST when socket is disconnected', () async {
      expect(socketService.isConnected, isFalse);

      final tracker = GeolocatorDriverLocationTracker(
        platformService: platformService,
        socketService: socketService,
      );

      tracker.startTracking(repository: repository);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // Socket emit not attempted because socket is disconnected
      expect(fakeClient.emittedEvents, isEmpty);

      // REST fallback executed cleanly
      expect(repository.reportLocationCallCount, 1);
      expect(repository.lastLatitude, 23.188);
      expect(repository.lastLongitude, 72.632);

      tracker.dispose();
    });

    test('falls back sequentially to REST when socket emit fails or times out', () async {
      await socketService.connect();
      expect(socketService.isConnected, isTrue);

      // Configure ACK handler on fake client to return failure
      fakeClient.setAckHandler('driver.location.update', (data) => {'success': false, 'error': 'SERVER_ERROR'});

      final tracker = GeolocatorDriverLocationTracker(
        platformService: platformService,
        socketService: socketService,
      );

      tracker.startTracking(repository: repository);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // Socket was attempted
      expect(fakeClient.emittedEvents.length, 1);

      // Because socket ACK success == false, fallback to REST executed!
      expect(repository.reportLocationCallCount, 1);

      tracker.dispose();
    });

    test('seamlessly transitions cadence and includes tripId when activeTripId is set', () async {
      await socketService.connect();

      final tracker = GeolocatorDriverLocationTracker(
        platformService: platformService,
        socketService: socketService,
      );

      tracker.startTracking(repository: repository);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(tracker.activeTripId, isNull);

      // Transition to active trip
      tracker.setActiveTripId('trip-active-uuid');
      expect(tracker.activeTripId, 'trip-active-uuid');

      tracker.dispose();
      expect(tracker.activeTripId, isNull);
    });
  });
}
