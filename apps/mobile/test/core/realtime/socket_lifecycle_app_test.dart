import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/realtime/socket_client.dart';
import 'package:lastmile_mobile/core/realtime/socket_service.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/models/auth_session.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';

import '../../helpers/test_fakes.dart';

class _SpySocketService implements SocketService {
  int connectCallCount = 0;
  int disconnectCallCount = 0;
  int disposeCallCount = 0;
  bool _isDisposed = false;
  SocketConnectionState _state = SocketConnectionState.disconnected;

  @override
  bool get isConnected => _state == SocketConnectionState.connected;

  @override
  bool get isDisposed => _isDisposed;

  @override
  SocketConnectionState get state => _state;

  @override
  Stream<SocketConnectionState> get stateStream => const Stream.empty();

  @override
  Future<void> connect() async {
    connectCallCount++;
    _state = SocketConnectionState.connected;
  }

  @override
  void disconnect() {
    if (_state == SocketConnectionState.disconnected) return;
    disconnectCallCount++;
    _state = SocketConnectionState.disconnected;
  }

  @override
  void dispose() {
    _isDisposed = true;
    disposeCallCount++;
    disconnect();
  }
}

void main() {
  const baseConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  const testUser = AuthUser(
    id: 'user-pass-1',
    email: 'passenger@pdeu.ac.in',
    fullName: 'PDEU Passenger',
    role: 'PASSENGER',
    roles: ['PASSENGER'],
    passengerProfile: PassengerProfile(
      id: 'passenger-1',
      defaultMinGroupPreference: 2,
      totalRidesCompleted: 3,
    ),
  );

  group('LastMileApp SocketService Lifecycle Integration', () {
    testWidgets(
      'exposes SocketService in MultiProvider and coordinates connect/disconnect on auth change',
      (tester) async {
        final tokenStore = AuthTokenStore();
        final secureStorage = SecureTokenStorage.inMemory();
        final authRepo = FakeAuthRepository(
          authSession: const AuthSession(
            accessToken: 'fake-access-token',
            refreshToken: 'fake-refresh-token',
            expiresIn: 3600,
            user: testUser,
          ),
        );
        final googleSignIn = FakeGoogleSignInService();
        final spySocket = _SpySocketService();

        final authProvider = AuthProvider(
          authRepository: authRepo,
          googleSignInService: googleSignIn,
          tokenStore: tokenStore,
          secureStorage: secureStorage,
        );

        await tester.pumpWidget(
          LastMileApp(
            config: baseConfig,
            tokenStore: tokenStore,
            secureStorage: secureStorage,
            authRepository: authRepo,
            googleSignInService: googleSignIn,
            authProvider: authProvider,
            socketService: spySocket,
          ),
        );
        await tester.pumpAndSettle();

        // 1. Initial unauthenticated state: socket should NOT be connected
        expect(spySocket.connectCallCount, 0);

        // Verify SocketService is available in context
        final BuildContext context = tester.element(find.byType(MaterialApp));
        final providedSocket = Provider.of<SocketService>(context, listen: false);
        expect(providedSocket, same(spySocket));

        // 2. User logs in -> auth state changes to authenticated
        await authProvider.signInWithGoogle();
        await tester.pumpAndSettle();

        expect(authProvider.isAuthenticated, isTrue);
        expect(spySocket.connectCallCount, 1);
        expect(spySocket.isConnected, isTrue);

        // 3. User logs out -> auth state changes to unauthenticated
        await authProvider.logout();
        await tester.pumpAndSettle();

        expect(authProvider.isAuthenticated, isFalse);
        expect(spySocket.disconnectCallCount, 1);
        expect(spySocket.isConnected, isFalse);
      },
    );
  });
}
