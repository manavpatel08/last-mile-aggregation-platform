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
  ///
  /// For placeholder/no-op clients (e.g. before the native socket library is
  /// linked), this returns false to prevent unneeded ticket acquisition.
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
  void dispose() {
    _controller.close();
  }
}

/// Testable fake client simulating socket transport behavior, disconnects, and errors.
class FakeSocketClient implements SocketClient {
  FakeSocketClient({
    SocketConnectionState initialState = SocketConnectionState.disconnected,
    this.isEnabled = true,
  }) : _state = initialState;

  @override
  final bool isEnabled;

  final _controller = StreamController<SocketConnectionState>.broadcast();
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
    _controller.close();
  }
}
