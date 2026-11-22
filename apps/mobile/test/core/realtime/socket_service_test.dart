import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/realtime/backoff_policy.dart';
import 'package:lastmile_mobile/core/realtime/models/socket_ticket_model.dart';
import 'package:lastmile_mobile/core/realtime/socket_client.dart';
import 'package:lastmile_mobile/core/realtime/socket_service.dart';
import 'package:lastmile_mobile/core/realtime/socket_ticket_provider.dart';

class _FakeTicketProvider implements SocketTicketProvider {
  int ticketCallCount = 0;
  final List<String> issuedTickets = [];
  Object? errorToThrow;
  Completer<SocketTicketModel>? pendingCompleter;
  CancelToken? lastCancelToken;

  @override
  Future<SocketTicketModel> getTicket({CancelToken? cancelToken}) async {
    ticketCallCount++;
    lastCancelToken = cancelToken;
    if (errorToThrow != null) {
      throw errorToThrow!;
    }
    if (pendingCompleter != null) {
      return pendingCompleter!.future;
    }
    final ticket = 'single-use-ticket-$ticketCallCount';
    issuedTickets.add(ticket);
    return SocketTicketModel(ticket: ticket, expiresIn: 60);
  }
}

class _FastBackoffPolicy implements BackoffPolicy {
  int getDelayCalls = 0;
  int resetCalls = 0;

  @override
  Duration getDelay(int attempt) {
    getDelayCalls++;
    // Very fast 10ms delay for deterministic tests
    return const Duration(milliseconds: 10);
  }

  @override
  void reset() {
    resetCalls++;
  }
}

void main() {
  const testConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    socketNamespace: '/realtime',
    socketPath: '/socket.io',
    appEnv: 'development',
  );

  group('RealtimeSocketService Foundation', () {
    late _FakeTicketProvider ticketProvider;
    late FakeSocketClient client;
    late _FastBackoffPolicy backoffPolicy;
    late RealtimeSocketService service;

    setUp(() {
      ticketProvider = _FakeTicketProvider();
      client = FakeSocketClient();
      backoffPolicy = _FastBackoffPolicy();
      service = RealtimeSocketService(
        config: testConfig,
        ticketProvider: ticketProvider,
        client: client,
        backoffPolicy: backoffPolicy,
      );
    });

    tearDown(() {
      service.dispose();
    });

    test('1. connect() acquires single-use ticket and connects client with exact parameters', () async {
      final states = <SocketConnectionState>[];
      final sub = service.stateStream.listen(states.add);

      expect(service.state, SocketConnectionState.disconnected);

      await service.connect();
      await Future<void>.delayed(Duration.zero);

      expect(ticketProvider.ticketCallCount, 1);
      expect(client.connectCallCount, 1);
      expect(client.lastUri, 'ws://localhost:3000/realtime');
      expect(client.lastNamespace, '/realtime');
      expect(client.lastPath, '/socket.io');
      expect(client.lastTicket, 'single-use-ticket-1');
      expect(service.isConnected, isTrue);
      expect(service.state, SocketConnectionState.connected);
      expect(states, [SocketConnectionState.connecting, SocketConnectionState.connected]);

      await sub.cancel();
    });

    test('2. connect() is no-op if already connected', () async {
      await service.connect();
      expect(ticketProvider.ticketCallCount, 1);

      await service.connect();
      expect(ticketProvider.ticketCallCount, 1);
      expect(client.connectCallCount, 1);
    });

    test('3. disconnect() cleanly closes client and resets connection state', () async {
      await service.connect();
      expect(service.isConnected, isTrue);

      service.disconnect();

      expect(client.disconnectCallCount, 1);
      expect(service.state, SocketConnectionState.disconnected);
      expect(service.isConnected, isFalse);
      expect(backoffPolicy.resetCalls, greaterThanOrEqualTo(1));
    });

    test('4. unexpected disconnect triggers backoff and acquires a fresh ticket on reconnect', () async {
      await service.connect();
      expect(ticketProvider.ticketCallCount, 1);
      expect(client.lastTicket, 'single-use-ticket-1');

      // Simulate network connection severed
      client.simulateDisconnect();
      await Future<void>.delayed(Duration.zero);

      expect(service.state, SocketConnectionState.reconnecting);
      expect(service.isScheduledToReconnect, isTrue);
      expect(service.reconnectAttempts, 1);

      // Wait for backoff timer (10ms) to fire
      await Future<void>.delayed(const Duration(milliseconds: 25));

      // Reconnected with a FRESH ticket
      expect(ticketProvider.ticketCallCount, 2);
      expect(client.lastTicket, 'single-use-ticket-2');
      expect(client.connectCallCount, 2);
      expect(service.state, SocketConnectionState.connected);
      expect(service.reconnectAttempts, 0);
    });

    test('5. consecutive disconnects request subsequent fresh tickets', () async {
      await service.connect();
      expect(client.lastTicket, 'single-use-ticket-1');

      // First unexpected drop
      client.simulateDisconnect();
      await Future<void>.delayed(const Duration(milliseconds: 25));
      expect(client.lastTicket, 'single-use-ticket-2');

      // Second unexpected drop
      client.simulateDisconnect();
      await Future<void>.delayed(const Duration(milliseconds: 25));
      expect(client.lastTicket, 'single-use-ticket-3');
      expect(ticketProvider.issuedTickets, [
        'single-use-ticket-1',
        'single-use-ticket-2',
        'single-use-ticket-3',
      ]);
    });

    test('6. ticket acquisition failure during reconnect schedules subsequent attempt', () async {
      await service.connect();

      // Make next ticket fetch fail (simulated backend/network error)
      ticketProvider.errorToThrow = Exception('Network error during ticket fetch');

      client.simulateDisconnect();
      await Future<void>.delayed(Duration.zero);

      expect(service.reconnectAttempts, 1);
      expect(service.isScheduledToReconnect, isTrue);

      // Wait for attempt 1 (10ms) to run and fail
      await Future<void>.delayed(const Duration(milliseconds: 15));
      expect(ticketProvider.ticketCallCount, 2);
      expect(service.reconnectAttempts, 2);
      expect(service.isScheduledToReconnect, isTrue);

      // Recover ticket service
      ticketProvider.errorToThrow = null;
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // Attempt 2 succeeds with fresh ticket
      expect(ticketProvider.ticketCallCount, 3);
      expect(client.lastTicket, 'single-use-ticket-3');
      expect(service.state, SocketConnectionState.connected);
      expect(service.reconnectAttempts, 0);
    });

    test('7. calling disconnect() during backoff wait halts reconnect attempt immediately', () async {
      await service.connect();

      // Client drops
      client.simulateDisconnect();
      await Future<void>.delayed(Duration.zero);
      expect(service.isScheduledToReconnect, isTrue);

      // User / app disconnects before timer tick
      service.disconnect();

      expect(service.isScheduledToReconnect, isFalse);
      expect(service.state, SocketConnectionState.disconnected);

      // Wait beyond the timer
      await Future<void>.delayed(const Duration(milliseconds: 30));

      // No reconnection was attempted
      expect(ticketProvider.ticketCallCount, 1);
      expect(client.connectCallCount, 1);
    });

    test('8. dispose() releases client and closes state stream', () async {
      await service.connect();
      service.dispose();

      expect(service.isDisposed, isTrue);
      expect(client.isDisposed, isTrue);
      expect(service.state, SocketConnectionState.disconnected);
    });

    test('9. NoOpSocketClient: connect() bypasses ticket acquisition and stays disconnected', () async {
      final noOpClient = NoOpSocketClient();
      expect(noOpClient.isEnabled, isFalse);

      final noOpService = RealtimeSocketService(
        config: testConfig,
        ticketProvider: ticketProvider,
        client: noOpClient,
      );
      addTearDown(noOpService.dispose);

      await noOpService.connect();

      // Ticket acquisition was NOT invoked
      expect(ticketProvider.ticketCallCount, 0);
      expect(noOpService.isConnected, isFalse);
      expect(noOpService.state, SocketConnectionState.disconnected);
    });

    test('10. disconnect() cancels in-flight ticket acquisition via CancelToken', () async {
      final completer = Completer<SocketTicketModel>();
      ticketProvider.pendingCompleter = completer;

      final connectFuture = service.connect();
      await Future<void>.delayed(Duration.zero);

      expect(service.isFetchingTicket, isTrue);
      expect(ticketProvider.lastCancelToken, isNotNull);
      expect(ticketProvider.lastCancelToken?.isCancelled, isFalse);

      // User disconnects while ticket HTTP call is pending
      service.disconnect();

      expect(ticketProvider.lastCancelToken?.isCancelled, isTrue);
      expect(service.isFetchingTicket, isFalse);

      // Complete late response
      completer.complete(const SocketTicketModel(ticket: 'late-ticket', expiresIn: 60));
      await connectFuture;

      expect(client.connectCallCount, 0);
      expect(service.state, SocketConnectionState.disconnected);
    });

    test('11. repeated concurrent connect() calls do not create duplicate ticket requests', () async {
      final completer = Completer<SocketTicketModel>();
      ticketProvider.pendingCompleter = completer;

      // Rapid repeated auth events firing connect() concurrently
      final f1 = service.connect();
      final f2 = service.connect();
      final f3 = service.connect();

      // Only one ticket request is in-flight
      expect(ticketProvider.ticketCallCount, 1);

      completer.complete(const SocketTicketModel(ticket: 'single-ticket', expiresIn: 60));
      await Future.wait([f1, f2, f3]);

      expect(ticketProvider.ticketCallCount, 1);
      expect(client.connectCallCount, 1);
    });
  });
}
