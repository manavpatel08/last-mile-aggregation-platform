import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/realtime/io_socket_client.dart';
import 'package:lastmile_mobile/core/realtime/socket_client.dart';

void main() {
  group('IOSocketClient Configuration & Normalization', () {
    test('normalizes ws:// and wss:// schemes to http:// and https://', () {
      expect(
        IOSocketClient.normalizeSocketUri('ws://localhost:3000/realtime', '/realtime'),
        'http://localhost:3000/realtime',
      );
      expect(
        IOSocketClient.normalizeSocketUri('wss://api.example.com/realtime', '/realtime'),
        'https://api.example.com/realtime',
      );
    });

    test('preserves existing http:// and https:// schemes', () {
      expect(
        IOSocketClient.normalizeSocketUri('http://10.0.2.2:3000/realtime', '/realtime'),
        'http://10.0.2.2:3000/realtime',
      );
      expect(
        IOSocketClient.normalizeSocketUri('https://api.example.com/realtime', '/realtime'),
        'https://api.example.com/realtime',
      );
    });

    test('appends namespace if omitted from base URI', () {
      expect(
        IOSocketClient.normalizeSocketUri('http://localhost:3000', '/realtime'),
        'http://localhost:3000/realtime',
      );
      expect(
        IOSocketClient.normalizeSocketUri('http://localhost:3000/', 'realtime'),
        'http://localhost:3000/realtime',
      );
    });

    test('initial state is disconnected and isEnabled is true', () {
      final client = IOSocketClient();
      expect(client.isEnabled, isTrue);
      expect(client.isConnected, isFalse);
      expect(client.state, SocketConnectionState.disconnected);
      client.dispose();
    });

    test('emitWithAck throws StateError when disconnected', () async {
      final client = IOSocketClient();
      expect(
        () => client.emitWithAck('test.event', {'hello': 'world'}),
        throwsA(isA<StateError>()),
      );
      client.dispose();
    });
  });
}
