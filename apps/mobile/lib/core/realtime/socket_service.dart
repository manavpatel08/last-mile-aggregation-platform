import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../config/app_config.dart';
import 'backoff_policy.dart';
import 'models/realtime_event.dart';
import 'models/socket_ticket_model.dart';
import 'socket_client.dart';
import 'socket_ticket_provider.dart';

/// Contract managing the lifecycle of the realtime WebSocket connection,
/// room subscriptions, and event dispatch.
abstract interface class SocketService {
  /// Current connection state.
  SocketConnectionState get state;

  /// Broadcast stream of connection state transitions.
  Stream<SocketConnectionState> get stateStream;

  /// Broadcast stream of parsed incoming domain events.
  Stream<StandardRealtimeEvent> get eventStream;

  /// Whether the socket is currently connected.
  bool get isConnected;

  /// Whether the service has been disposed.
  bool get isDisposed;

  /// Initiates connection by fetching a fresh single-use ticket and connecting transport.
  Future<void> connect();

  /// Explicitly disconnects and halts reconnection backoff timers.
  void disconnect();

  /// Joins an authorized trip room (`trip:{tripId}`).
  Future<bool> subscribeTrip(String tripId);

  /// Leaves a trip room.
  Future<bool> unsubscribeTrip(String tripId);

  /// Joins an authorized booking room (`booking:{bookingId}`).
  Future<bool> subscribeBooking(String bookingId);

  /// Leaves a booking room.
  Future<bool> unsubscribeBooking(String bookingId);

  /// Joins an authorized group room (`group:{groupId}`).
  Future<bool> subscribeGroup(String groupId);

  /// Leaves a group room.
  Future<bool> unsubscribeGroup(String groupId);

  /// Streams driver GPS telemetry over Socket.IO via `driver.location.update`.
  /// Returns `true` if server acknowledged the fix; `false` on failure/timeout.
  Future<bool> emitLocationUpdate(DriverLocationUpdatePayload payload);

  /// Registers an event handler for a specific domain event.
  void onEvent(String eventName, void Function(StandardRealtimeEvent event) handler);

  /// Unregisters an event handler.
  void offEvent(String eventName, [void Function(StandardRealtimeEvent event)? handler]);

  /// Disposes resources.
  void dispose();
}

/// Production implementation of [SocketService] managing fresh single-use tickets,
/// connection lifecycle, exponential backoff with jitter, room resubscription on reconnect,
/// and domain event dispatch.
class RealtimeSocketService implements SocketService {
  RealtimeSocketService({
    required this.config,
    required this.ticketProvider,
    required this.client,
    BackoffPolicy? backoffPolicy,
  }) : _backoffPolicy = backoffPolicy ?? ExponentialBackoffPolicy() {
    _clientSubscription =
        client.connectionStateStream.listen(_onClientStateChanged);
    _registerEventBridge();
  }

  static const List<String> canonicalEvents = [
    'booking.created',
    'booking.status.updated',
    'group.updated',
    'driver.offer.created',
    'driver.offer.withdrawn',
    'trip.created',
    'driver.arrived',
    'passenger.boarded',
    'trip.status.updated',
    'passenger.dropped_off',
    'passenger.no_show',
    'trip.completed',
    'trip.cancelled',
    'trip.interrupted',
    'trip.resumed',
    'trip.aborted',
    'payment.confirmed',
    'fee.waived',
    'driver.location.updated',
  ];

  final AppConfig config;
  final SocketTicketProvider ticketProvider;
  final SocketClient client;
  final BackoffPolicy _backoffPolicy;

  final _stateController = StreamController<SocketConnectionState>.broadcast();
  final _eventController = StreamController<StandardRealtimeEvent>.broadcast();
  final Map<String, List<void Function(StandardRealtimeEvent)>> _eventHandlers = {};
  final Set<String> _activeSubscribedRooms = <String>{};

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
  Stream<StandardRealtimeEvent> get eventStream => _eventController.stream;

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

  @visibleForTesting
  Set<String> get activeSubscribedRooms => Set.unmodifiable(_activeSubscribedRooms);

  bool get _isConnecting =>
      _state == SocketConnectionState.connecting ||
      _state == SocketConnectionState.reconnecting ||
      _isFetchingTicket;

  void _registerEventBridge() {
    for (final eventName in canonicalEvents) {
      client.on(eventName, (data) {
        _handleRawEvent(eventName, data);
      });
    }
  }

  void _handleRawEvent(String eventName, dynamic rawData) {
    if (_isDisposed) return;
    try {
      final Map<String, dynamic> jsonMap;
      if (rawData is Map<String, dynamic>) {
        jsonMap = rawData;
      } else if (rawData is Map) {
        jsonMap = Map<String, dynamic>.from(rawData);
      } else {
        jsonMap = {'event': eventName, 'data': rawData};
      }

      final envelope = StandardRealtimeEvent<dynamic>.fromJson(jsonMap);
      if (!_eventController.isClosed) {
        _eventController.add(envelope);
      }

      final handlers = List<void Function(StandardRealtimeEvent)>.from(
        _eventHandlers[eventName] ?? const [],
      );
      for (final handler in handlers) {
        try {
          handler(envelope);
        } catch (e) {
          if (kDebugMode) {
            debugPrint('[RealtimeSocketService] Error in event handler for $eventName: $e');
          }
        }
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[RealtimeSocketService] Failed to parse event "$eventName": $e');
      }
    }
  }

  @override
  Future<void> connect() async {
    if (_isDisposed) return;

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
      _resubscribeActiveRooms();
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
      _resubscribeActiveRooms();
    }
  }

  void _onClientStateChanged(SocketConnectionState clientState) {
    if (_isDisposed || !_shouldBeConnected) return;

    switch (clientState) {
      case SocketConnectionState.connected:
        _reconnectAttempts = 0;
        _backoffPolicy.reset();
        _updateState(SocketConnectionState.connected);
        _resubscribeActiveRooms();
        break;

      case SocketConnectionState.disconnected:
      case SocketConnectionState.error:
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

  Future<void> _resubscribeActiveRooms() async {
    if (!isConnected || _activeSubscribedRooms.isEmpty) return;

    final rooms = Set<String>.from(_activeSubscribedRooms);
    for (final room in rooms) {
      if (room.startsWith('trip:')) {
        final id = room.substring(5);
        await _emitSubscribeAck('subscribe:trip', {'tripId': id});
      } else if (room.startsWith('booking:')) {
        final id = room.substring(8);
        await _emitSubscribeAck('subscribe:booking', {'bookingId': id});
      } else if (room.startsWith('group:')) {
        final id = room.substring(6);
        await _emitSubscribeAck('subscribe:group', {'groupId': id});
      }
    }
  }

  Future<bool> _emitSubscribeAck(String event, Map<String, dynamic> payload) async {
    try {
      final ack = await client.emitWithAck(event, payload);
      if (ack is Map && ack['success'] == true) {
        return true;
      }
      return false;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[RealtimeSocketService] Room subscribe "$event" failed: $e');
      }
      return false;
    }
  }

  @override
  Future<bool> subscribeTrip(String tripId) async {
    final room = 'trip:$tripId';
    _activeSubscribedRooms.add(room);
    if (!isConnected) return false;
    return _emitSubscribeAck('subscribe:trip', {'tripId': tripId});
  }

  @override
  Future<bool> unsubscribeTrip(String tripId) async {
    final room = 'trip:$tripId';
    _activeSubscribedRooms.remove(room);
    if (!isConnected) return true;
    try {
      await client.emitWithAck('unsubscribe:trip', {'tripId': tripId});
      return true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> subscribeBooking(String bookingId) async {
    final room = 'booking:$bookingId';
    _activeSubscribedRooms.add(room);
    if (!isConnected) return false;
    return _emitSubscribeAck('subscribe:booking', {'bookingId': bookingId});
  }

  @override
  Future<bool> unsubscribeBooking(String bookingId) async {
    final room = 'booking:$bookingId';
    _activeSubscribedRooms.remove(room);
    if (!isConnected) return true;
    try {
      await client.emitWithAck('unsubscribe:booking', {'bookingId': bookingId});
      return true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> subscribeGroup(String groupId) async {
    final room = 'group:$groupId';
    _activeSubscribedRooms.add(room);
    if (!isConnected) return false;
    return _emitSubscribeAck('subscribe:group', {'groupId': groupId});
  }

  @override
  Future<bool> unsubscribeGroup(String groupId) async {
    final room = 'group:$groupId';
    _activeSubscribedRooms.remove(room);
    if (!isConnected) return true;
    try {
      await client.emitWithAck('unsubscribe:group', {'groupId': groupId});
      return true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> emitLocationUpdate(DriverLocationUpdatePayload payload) async {
    if (!isConnected) return false;
    try {
      final ack = await client.emitWithAck('driver.location.update', payload.toJson());
      if (ack is Map && ack['success'] == true) {
        return true;
      }
      return false;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[RealtimeSocketService] emitLocationUpdate failed: $e');
      }
      return false;
    }
  }

  @override
  void onEvent(String eventName, void Function(StandardRealtimeEvent event) handler) {
    _eventHandlers.putIfAbsent(eventName, () => []).add(handler);
  }

  @override
  void offEvent(String eventName, [void Function(StandardRealtimeEvent event)? handler]) {
    if (handler != null) {
      _eventHandlers[eventName]?.remove(handler);
    } else {
      _eventHandlers.remove(eventName);
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
    _eventController.close();
    _eventHandlers.clear();
    _activeSubscribedRooms.clear();
    client.dispose();
  }
}
