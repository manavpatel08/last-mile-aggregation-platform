import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/realtime/models/socket_ticket_model.dart';
import 'package:lastmile_mobile/core/realtime/models/sync_models.dart';
import 'package:lastmile_mobile/core/realtime/socket_client.dart';
import 'package:lastmile_mobile/core/realtime/socket_service.dart';
import 'package:lastmile_mobile/core/realtime/socket_ticket_provider.dart';
import 'package:lastmile_mobile/core/realtime/sync_repository.dart';
import 'package:lastmile_mobile/core/realtime/sync_service.dart';

class _FakeSyncRepository implements SyncRepository {
  int syncCallCount = 0;
  SyncRequestDto? lastRequest;
  SyncResponseDto responseToReturn = SyncResponseDto(
    success: true,
    serverTimestamp: DateTime.now(),
    role: 'PASSENGER',
    reconciled: false,
  );

  @override
  Future<SyncResponseDto> syncState(SyncRequestDto request) async {
    syncCallCount++;
    lastRequest = request;
    return responseToReturn;
  }
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

  group('SyncService', () {
    late FakeSocketClient fakeClient;
    late RealtimeSocketService socketService;
    late _FakeSyncRepository syncRepository;
    late SyncService syncService;

    setUp(() {
      fakeClient = FakeSocketClient();
      socketService = RealtimeSocketService(
        config: testConfig,
        ticketProvider: _FakeTicketProvider(),
        client: fakeClient,
      );
      syncRepository = _FakeSyncRepository();
      syncService = SyncService(
        syncRepository: syncRepository,
        socketService: socketService,
      );
    });

    tearDown(() {
      syncService.dispose();
      socketService.dispose();
    });

    test('triggers state reconciliation on socket connect', () async {
      expect(syncRepository.syncCallCount, 0);

      await socketService.connect();
      // Allow async listeners to fire
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(syncRepository.syncCallCount, 1);
      expect(syncService.lastResponse, isNotNull);
    });

    test('triggers state reconciliation on app lifecycle resumed', () async {
      expect(syncRepository.syncCallCount, 0);

      syncService.onAppLifecycleStateChanged(AppLifecycleState.resumed);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(syncRepository.syncCallCount, 1);
    });

    test('ignores non-resumed app lifecycle states (paused, inactive)', () async {
      syncService.onAppLifecycleStateChanged(AppLifecycleState.paused);
      syncService.onAppLifecycleStateChanged(AppLifecycleState.inactive);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(syncRepository.syncCallCount, 0);
    });

    test('persists tracked IDs and versions into subsequent sync requests', () async {
      syncService.updateTrackingContext(
        version: 5,
        bookingId: 'booking-123',
        tripId: 'trip-456',
      );

      await syncService.reconcile();

      expect(syncRepository.lastRequest?.lastKnownEntityVersion, 5);
      expect(syncRepository.lastRequest?.activeBookingId, 'booking-123');
      expect(syncRepository.lastRequest?.activeTripId, 'trip-456');
    });

    test('updates tracked context from passenger sync response', () async {
      syncRepository.responseToReturn = SyncResponseDto(
        success: true,
        serverTimestamp: DateTime.now(),
        role: 'PASSENGER',
        reconciled: true,
        passengerState: SyncPassengerState(
          activeBooking: SyncActiveBooking(
            id: 'server-booking-id',
            status: 'CONFIRMED',
            passengerId: 'p-1',
            pickupPointId: 'point-1',
            fareQuotePaise: 3000,
            createdAt: DateTime.now(),
            updatedAt: DateTime.now(),
            entityVersion: 3,
          ),
          activeTrip: const SyncPassengerActiveTrip(
            id: 'server-trip-id',
            status: 'IN_PROGRESS',
            tripVersion: 3,
            activeDriverId: 'd-1',
            farePaise: 3000,
          ),
        ),
      );

      await syncService.reconcile();

      expect(syncService.activeBookingId, 'server-booking-id');
      expect(syncService.activeTripId, 'server-trip-id');
      expect(syncService.lastKnownEntityVersion, 3);
    });
  });
}
