import 'dart:async';

/// Connection states for the realtime gateway socket.
enum SocketConnectionState {
  disconnected,
  connecting,
  connected,
  reconnecting,
  error,
}

/// Abstract transport client interface isolating the underlying Socket.IO library.
abstract interface class SocketClient {
  /// Whether this client represents an active socket transport.
  bool get isEnabled;

  /// Whether the socket is currently connected to the server.
  bool get isConnected;

  /// The current connection state.
  SocketConnectionState get state;

  /// Broadcast stream of connection state changes.
  Stream<SocketConnectionState> get connectionStateStream;

  /// Connects to the given gateway endpoint with the single-use ticket in `auth`.
  void connect({
    required String uri,
    required String namespace,
    required String path,
    required String ticket,
  });

  /// Disconnects the socket transport.
  void disconnect();

  /// Emits an event with optional data without expecting an acknowledgment.
  void emit(String event, [dynamic data]);

  /// Emits an event with data and awaits an acknowledgment from the server.
  Future<dynamic> emitWithAck(String event, dynamic data);

  /// Registers a listener for an incoming server event.
  void on(String event, void Function(dynamic data) handler);

  /// Removes an event listener.
  void off(String event, [void Function(dynamic data)? handler]);

  /// Releases resources.
  void dispose();
}

/// Safe no-op client used before the native Socket.IO package is wired or in testing.
class NoOpSocketClient implements SocketClient {
  NoOpSocketClient();

  final _controller = StreamController<SocketConnectionState>.broadcast();

  @override
  bool get isEnabled => false;

  @override
  bool get isConnected => false;

  @override
  SocketConnectionState get state => SocketConnectionState.disconnected;

  @override
  Stream<SocketConnectionState> get connectionStateStream => _controller.stream;

  @override
  void connect({
    required String uri,
    required String namespace,
    required String path,
    required String ticket,
  }) {}

  @override
  void disconnect() {}

  @override
  void emit(String event, [dynamic data]) {}

  @override
  Future<dynamic> emitWithAck(String event, dynamic data) async {
    return {'success': false, 'error': 'NO_OP_CLIENT'};
  }

  @override
  void on(String event, void Function(dynamic data) handler) {}

  @override
  void off(String event, [void Function(dynamic data)? handler]) {}

  @override
  void dispose() {
    _controller.close();
  }
}

/// Testable fake client simulating socket transport behavior, disconnects, emits, and ACKs.
class FakeSocketClient implements SocketClient {
  FakeSocketClient({
    SocketConnectionState initialState = SocketConnectionState.disconnected,
    this.isEnabled = true,
  }) : _state = initialState;

  @override
  final bool isEnabled;

  final _controller = StreamController<SocketConnectionState>.broadcast();
  final Map<String, List<void Function(dynamic)>> _listeners = {};
  final List<MapEntry<String, dynamic>> emittedEvents = [];
  final Map<String, dynamic Function(dynamic data)> _ackHandlers = {};

  SocketConnectionState _state;

  String? lastUri;
  String? lastNamespace;
  String? lastPath;
  String? lastTicket;
  int connectCallCount = 0;
  int disconnectCallCount = 0;
  bool isDisposed = false;

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
    connectCallCount++;
    lastUri = uri;
    lastNamespace = namespace;
    lastPath = path;
    lastTicket = ticket;
    setState(SocketConnectionState.connected);
  }

  @override
  void disconnect() {
    disconnectCallCount++;
    setState(SocketConnectionState.disconnected);
  }

  @override
  void emit(String event, [dynamic data]) {
    emittedEvents.add(MapEntry(event, data));
  }

  @override
  Future<dynamic> emitWithAck(String event, dynamic data) async {
    emittedEvents.add(MapEntry(event, data));
    final handler = _ackHandlers[event];
    if (handler != null) {
      return handler(data);
    }
    return {'success': true};
  }

  void setAckHandler(String event, dynamic Function(dynamic data) handler) {
    _ackHandlers[event] = handler;
  }

  @override
  void on(String event, void Function(dynamic data) handler) {
    _listeners.putIfAbsent(event, () => []).add(handler);
  }

  @override
  void off(String event, [void Function(dynamic data)? handler]) {
    if (handler == null) {
      _listeners.remove(event);
    } else {
      _listeners[event]?.remove(handler);
    }
  }

  /// Simulates an incoming server event broadcast.
  void simulateEvent(String event, dynamic data) {
    final handlers = List<void Function(dynamic)>.from(_listeners[event] ?? const []);
    for (final handler in handlers) {
      handler(data);
    }
  }

  void setState(SocketConnectionState newState) {
    _state = newState;
    if (!_controller.isClosed) {
      _controller.add(newState);
    }
  }

  void simulateDisconnect() {
    setState(SocketConnectionState.disconnected);
  }

  void simulateError() {
    setState(SocketConnectionState.error);
  }

  @override
  void dispose() {
    isDisposed = true;
    _listeners.clear();
    _controller.close();
  }
}
