import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'socket_client.dart';

/// Production implementation of [SocketClient] powered by `socket_io_client`.
class IOSocketClient implements SocketClient {
  IOSocketClient({this.ackTimeout = const Duration(seconds: 10)});

  final Duration ackTimeout;
  final _controller = StreamController<SocketConnectionState>.broadcast();

  io.Socket? _socket;
  SocketConnectionState _state = SocketConnectionState.disconnected;
  bool _isDisposed = false;

  @visibleForTesting
  io.Socket? get rawSocket => _socket;

  @visibleForTesting
  static String normalizeSocketUri(String uri, String namespace) {
    var normalized = uri.trim();
    if (normalized.startsWith('ws://')) {
      normalized = 'http://${normalized.substring(5)}';
    } else if (normalized.startsWith('wss://')) {
      normalized = 'https://${normalized.substring(6)}';
    }

    final ns = namespace.startsWith('/') ? namespace : '/$namespace';
    if (!normalized.endsWith(ns)) {
      if (normalized.endsWith('/')) {
        normalized = '${normalized.substring(0, normalized.length - 1)}$ns';
      } else {
        normalized = '$normalized$ns';
      }
    }
    return normalized;
  }

  @override
  bool get isEnabled => true;

  @override
  bool get isConnected => _state == SocketConnectionState.connected;

  @override
  SocketConnectionState get state => _state;

  @override
  Stream<SocketConnectionState> get connectionStateStream => _controller.stream;

  @override
  void connect({
    required String uri,
    required String namespace,
    required String path,
    required String ticket,
  }) {
    if (_isDisposed) return;

    disconnect();

    final resolvedUri = normalizeSocketUri(uri, namespace);
    final resolvedPath = path.isNotEmpty ? path : '/socket.io';

    final options = io.OptionBuilder()
        .setPath(resolvedPath)
        .setTransports(['websocket'])
        .setAuth({'ticket': ticket})
        .disableAutoConnect()
        .build();

    final socket = io.io(resolvedUri, options);
    _socket = socket;

    _updateState(SocketConnectionState.connecting);

    socket.onConnect((_) {
      if (_socket == socket && !_isDisposed) {
        _updateState(SocketConnectionState.connected);
      }
    });

    socket.onDisconnect((_) {
      if (_socket == socket && !_isDisposed) {
        _updateState(SocketConnectionState.disconnected);
      }
    });

    socket.onConnectError((err) {
      if (_socket == socket && !_isDisposed) {
        if (kDebugMode) {
          debugPrint('[IOSocketClient] Connection error: $err');
        }
        _updateState(SocketConnectionState.error);
      }
    });

    socket.onError((err) {
      if (_socket == socket && !_isDisposed) {
        if (kDebugMode) {
          debugPrint('[IOSocketClient] Socket error: $err');
        }
        _updateState(SocketConnectionState.error);
      }
    });

    socket.connect();
  }

  @override
  void disconnect() {
    final socket = _socket;
    if (socket != null) {
      try {
        socket.disconnect();
        socket.destroy();
      } catch (e) {
        if (kDebugMode) {
          debugPrint('[IOSocketClient] Error during disconnect: $e');
        }
      }
      _socket = null;
    }
    _updateState(SocketConnectionState.disconnected);
  }

  @override
  void emit(String event, [dynamic data]) {
    final socket = _socket;
    if (socket == null || !isConnected) {
      if (kDebugMode) {
        debugPrint('[IOSocketClient] Warning: Emitting "$event" while disconnected');
      }
      return;
    }
    socket.emit(event, data);
  }

  @override
  Future<dynamic> emitWithAck(String event, dynamic data) {
    final socket = _socket;
    if (socket == null || !isConnected) {
      return Future.error(
        StateError('Cannot emitWithAck("$event"): Socket is disconnected'),
      );
    }

    final completer = Completer<dynamic>();
    socket.emitWithAck(
      event,
      data,
      ack: (response) {
        if (!completer.isCompleted) {
          completer.complete(response);
        }
      },
    );

    return completer.future.timeout(
      ackTimeout,
      onTimeout: () =>
          throw TimeoutException('Socket ACK timed out for event "$event"'),
    );
  }

  @override
  void on(String event, void Function(dynamic data) handler) {
    _socket?.on(event, handler);
  }

  @override
  void off(String event, [void Function(dynamic data)? handler]) {
    if (handler != null) {
      _socket?.off(event, handler);
    } else {
      _socket?.off(event);
    }
  }

  void _updateState(SocketConnectionState newState) {
    if (_state != newState) {
      _state = newState;
      if (!_controller.isClosed) {
        _controller.add(newState);
      }
    }
  }

  @override
  void dispose() {
    _isDisposed = true;
    disconnect();
    _controller.close();
  }
}
