import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/auth/data/google_sign_in_service.dart';

import '../../../helpers/test_fakes.dart';

void main() {
  group('GoogleSignInService', () {
    const testConfig = AppConfig(
      apiBaseUrl: 'http://localhost:3000',
      socketBaseUrl: 'ws://localhost:3000',
      appEnv: 'development',
      googleClientIdIos: 'valid-client-id-ios.apps.googleusercontent.com',
      googleServerClientId: 'valid-server-client-id.apps.googleusercontent.com',
    );

    test(
      'NativeGoogleSignInService initialization failure prevents interactive authentication',
      () async {
        final adapter = FakeGoogleSignInAdapter(shouldFailInit: true);
        final service = NativeGoogleSignInService(
          config: testConfig,
          adapter: adapter,
        );

        // When initialization fails, signIn throws GOOGLE_INIT_FAILED
        await expectLater(
          service.signIn(),
          throwsA(
            isA<ApiException>().having(
              (e) => e.errorCode,
              'errorCode',
              'GOOGLE_INIT_FAILED',
            ),
          ),
        );

        // authenticate() MUST NOT be called after initialization failure!
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 0);
      },
    );

    test(
      'NativeGoogleSignInService allows successful retry after initialization failure',
      () async {
        final adapter = FakeGoogleSignInAdapter(shouldFailInit: true);
        final service = NativeGoogleSignInService(
          config: testConfig,
          adapterFactory: () => adapter,
        );

        // First attempt fails during initialization
        await expectLater(
          service.signIn(),
          throwsA(
            isA<ApiException>().having(
              (e) => e.errorCode,
              'errorCode',
              'GOOGLE_INIT_FAILED',
            ),
          ),
        );
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 0);

        // Storage or platform issue resolves; retry initialization
        adapter.shouldFailInit = false;
        adapter.idToken = 'retried-valid-google-id-token';

        final result = await service.signIn();

        // Successful initialization and authentication on retry
        expect(result, 'retried-valid-google-id-token');
        expect(adapter.initializeCount, 2);
        expect(adapter.authenticateCount, 1);
      },
    );

    test(
      'NativeGoogleSignInService successful initialization and authentication returns ID token',
      () async {
        final adapter = FakeGoogleSignInAdapter(
          idToken: 'successful-google-id-token',
        );
        final service = NativeGoogleSignInService(
          config: testConfig,
          adapter: adapter,
        );

        final result = await service.signIn();

        expect(result, 'successful-google-id-token');
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 1);
      },
    );

    test(
      'NativeGoogleSignInService concurrent signIn calls share single initialization',
      () async {
        final adapter = FakeGoogleSignInAdapter(
          idToken: 'shared-init-id-token',
        );
        final service = NativeGoogleSignInService(
          config: testConfig,
          adapter: adapter,
        );

        final results = await Future.wait([
          service.signIn(),
          service.signIn(),
        ]);

        expect(results, ['shared-init-id-token', 'shared-init-id-token']);
        // Initialization runs only once
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 2);
      },
    );

    test(
      'NativeGoogleSignInService cancellation returns null without throwing',
      () async {
        final adapter = FakeGoogleSignInAdapter(shouldCancel: true);
        final service = NativeGoogleSignInService(
          config: testConfig,
          adapter: adapter,
        );

        final result = await service.signIn();
        expect(result, isNull);
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 1);
      },
    );

    test(
      'Throws explicit GOOGLE_CONFIG_MISSING when client id is placeholder or empty',
      () async {
        const placeholderConfig = AppConfig(
          apiBaseUrl: 'http://localhost:3000',
          socketBaseUrl: 'ws://localhost:3000',
          appEnv: 'development',
          googleClientIdIos:
              'YOUR_IOS_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
        );
        final service = NativeGoogleSignInService(config: placeholderConfig);

        await expectLater(
          service.signIn(),
          throwsA(
            isA<ApiException>().having(
              (e) => e.errorCode,
              'errorCode',
              'GOOGLE_CONFIG_MISSING',
            ),
          ),
        );
      },
    );
  });
}
