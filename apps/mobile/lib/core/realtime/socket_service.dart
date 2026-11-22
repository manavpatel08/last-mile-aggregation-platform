import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../config/app_config.dart';
import 'backoff_policy.dart';
import 'models/socket_ticket_model.dart';
import 'socket_client.dart';
import 'socket_ticket_provider.dart';

/// Contract managing the lifecycle of the realtime WebSocket connection.
abstract interface class SocketService {
  /// Current connection state.
  SocketConnectionState get state;

  /// Broadcast stream of connection state transitions.
  Stream<SocketConnectionState> get stateStream;

  /// Whether the socket is currently connected.
  bool get isConnected;

  /// Whether the service has been disposed.
  bool get isDisposed;

  /// Initiates connection by fetching a fresh single-use ticket and connecting transport.
  Future<void> connect();

  /// Explicitly disconnects and halts reconnection backoff timers.
  void disconnect();

  /// Disposes resources.
  void dispose();
}

/// Production implementation of [SocketService] managing fresh single-use tickets,
/// connection lifecycle, exponential backoff with jitter, and disconnect cleanup.
class RealtimeSocketService implements SocketService {
  RealtimeSocketService({
    required this.config,
    required this.ticketProvider,
    required this.client,
    BackoffPolicy? backoffPolicy,
  }) : _backoffPolicy = backoffPolicy ?? ExponentialBackoffPolicy() {
    _clientSubscription =
        client.connectionStateStream.listen(_onClientStateChanged);
  }

  final AppConfig config;
  final SocketTicketProvider ticketProvider;
  final SocketClient client;
  final BackoffPolicy _backoffPolicy;

  final _stateController = StreamController<SocketConnectionState>.broadcast();
  StreamSubscription<SocketConnectionState>? _clientSubscription;

  SocketConnectionState _state = SocketConnectionState.disconnected;
  bool _shouldBeConnected = false;
  int _sessionGeneration = 0;
  int _reconnectAttempts = 0;
  Timer? _reconnectTimer;
  bool _isFetchingTicket = false;
  CancelToken? _ticketCancelToken;
  bool _isDisposed = false;

  @override
  SocketConnectionState get state => _state;

  @override
  Stream<SocketConnectionState> get stateStream => _stateController.stream;

  @override
  bool get isConnected => _state == SocketConnectionState.connected;

  @override
  bool get isDisposed => _isDisposed;

  @visibleForTesting
  int get reconnectAttempts => _reconnectAttempts;

  @visibleForTesting
  bool get isScheduledToReconnect =>
      _reconnectTimer != null && _reconnectTimer!.isActive;

  @visibleForTesting
  bool get isFetchingTicket => _isFetchingTicket;

  bool get _isConnecting =>
      _state == SocketConnectionState.connecting ||
      _state == SocketConnectionState.reconnecting ||
      _isFetchingTicket;

  @override
  Future<void> connect() async {
    if (_isDisposed) return;

    // Concurrency guard: repeated auth events cannot trigger duplicate connections or concurrent ticket fetches
    if (isConnected || (_shouldBeConnected && _isConnecting)) {
      return;
    }

    _shouldBeConnected = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;

    final currentGen = ++_sessionGeneration;
    await _connectInternal(currentGen);
  }

  Future<void> _connectInternal(int sessionGen) async {
    if (_isDisposed || !_shouldBeConnected || sessionGen != _sessionGeneration) {
      return;
    }

    // Transport check: If client is disabled (e.g. NoOp), do NOT acquire ticket or connect
    if (!client.isEnabled) {
      if (kDebugMode) {
        debugPrint(
          '[RealtimeSocketService] Transport client is disabled (NoOp). Bypassing ticket acquisition.',
        );
      }
      _updateState(SocketConnectionState.disconnected);
      return;
    }

    if (client.isConnected) {
      _reconnectAttempts = 0;
      _backoffPolicy.reset();
      _updateState(SocketConnectionState.connected);
      return;
    }

    _updateState(
      _reconnectAttempts > 0
          ? SocketConnectionState.reconnecting
          : SocketConnectionState.connecting,
    );

    _ticketCancelToken?.cancel('Superseded by new connection attempt');
    final cancelToken = CancelToken();
    _ticketCancelToken = cancelToken;
    _isFetchingTicket = true;

    final SocketTicketModel ticketModel;
    try {
      ticketModel = await ticketProvider.getTicket(cancelToken: cancelToken);
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[RealtimeSocketService] Failed to acquire ticket: $e');
      }
      _isFetchingTicket = false;
      if (_isDisposed ||
          !_shouldBeConnected ||
          sessionGen != _sessionGeneration) {
        return;
      }

      _scheduleReconnect(sessionGen);
      return;
    } finally {
      if (_ticketCancelToken == cancelToken) {
        _ticketCancelToken = null;
      }
    }
    _isFetchingTicket = false;

    if (_isDisposed ||
        !_shouldBeConnected ||
        sessionGen != _sessionGeneration) {
      return;
    }

    // Connect transport using fresh single-use ticket
    client.connect(
      uri: config.socketBaseUrl,
      namespace: config.socketNamespace,
      path: config.socketPath,
      ticket: ticketModel.ticket,
    );

    if (client.isConnected) {
      _reconnectAttempts = 0;
      _backoffPolicy.reset();
      _updateState(SocketConnectionState.connected);
    }
  }

  void _onClientStateChanged(SocketConnectionState clientState) {
    if (_isDisposed || !_shouldBeConnected) return;

    switch (clientState) {
      case SocketConnectionState.connected:
        _reconnectAttempts = 0;
        _backoffPolicy.reset();
        _updateState(SocketConnectionState.connected);
        break;

      case SocketConnectionState.disconnected:
      case SocketConnectionState.error:
        // Unexpected disconnect while we want to be connected -> back off and fetch fresh ticket
        if (_shouldBeConnected && _state != SocketConnectionState.reconnecting) {
          _scheduleReconnect(_sessionGeneration);
        }
        break;

      case SocketConnectionState.connecting:
      case SocketConnectionState.reconnecting:
        _updateState(clientState);
        break;
    }
  }

  void _scheduleReconnect(int sessionGen) {
    if (_isDisposed ||
        !_shouldBeConnected ||
        sessionGen != _sessionGeneration) {
      return;
    }

    _reconnectTimer?.cancel();
    _reconnectAttempts++;
    final delay = _backoffPolicy.getDelay(_reconnectAttempts);

    _updateState(SocketConnectionState.reconnecting);

    if (kDebugMode) {
      debugPrint(
        '[RealtimeSocketService] Scheduling reconnect attempt #$_reconnectAttempts in ${delay.inMilliseconds}ms',
      );
    }

    _reconnectTimer = Timer(delay, () {
      if (_isDisposed ||
          !_shouldBeConnected ||
          sessionGen != _sessionGeneration) {
        return;
      }
      _connectInternal(sessionGen);
    });
  }

  @override
  void disconnect() {
    if (!_shouldBeConnected && _state == SocketConnectionState.disconnected) {
      return;
    }
    _shouldBeConnected = false;
    _sessionGeneration++;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _ticketCancelToken?.cancel('Socket disconnected');
    _ticketCancelToken = null;
    _isFetchingTicket = false;
    _reconnectAttempts = 0;
    _backoffPolicy.reset();

    client.disconnect();
    _updateState(SocketConnectionState.disconnected);
  }

  void _updateState(SocketConnectionState newState) {
    if (_state != newState) {
      _state = newState;
      if (!_stateController.isClosed) {
        _stateController.add(newState);
      }
    }
  }

  @override
  void dispose() {
    if (_isDisposed) return;
    _isDisposed = true;
    disconnect();
    _clientSubscription?.cancel();
    _stateController.close();
    client.dispose();
  }
}
