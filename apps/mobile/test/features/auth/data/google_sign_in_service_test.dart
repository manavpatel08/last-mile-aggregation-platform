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

        // When initialization fails, signIn throws GOOGLE_INIT_FAILED with restart instruction
        await expectLater(
          service.signIn(),
          throwsA(
            isA<ApiException>()
                .having((e) => e.errorCode, 'errorCode', 'GOOGLE_INIT_FAILED')
                .having(
                  (e) => e.message,
                  'message',
                  contains('restart the app'),
                ),
          ),
        );

        // authenticate() MUST NOT be called after initialization failure!
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 0);
      },
    );

    test(
      'NativeGoogleSignInService a second sign-in attempt does not call initialize again and returns cached failure',
      () async {
        final adapter = FakeGoogleSignInAdapter(shouldFailInit: true);
        final service = NativeGoogleSignInService(
          config: testConfig,
          adapter: adapter,
        );

        // First attempt fails during initialization
        await expectLater(
          service.signIn(),
          throwsA(
            isA<ApiException>()
                .having((e) => e.errorCode, 'errorCode', 'GOOGLE_INIT_FAILED')
                .having(
                  (e) => e.message,
                  'message',
                  contains('restart the app'),
                ),
          ),
        );
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 0);

        // Even if adapter would theoretically not fail, service must not re-call initialize()
        adapter.shouldFailInit = false;

        await expectLater(
          service.signIn(),
          throwsA(
            isA<ApiException>()
                .having((e) => e.errorCode, 'errorCode', 'GOOGLE_INIT_FAILED')
                .having(
                  (e) => e.message,
                  'message',
                  contains('restart the app'),
                ),
          ),
        );
        // initialize() was attempted exactly once across both calls
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 0);
      },
    );

    test(
      'NativeGoogleSignInService successful initialization supports subsequent sign-in calls without reinitialization',
      () async {
        final adapter = FakeGoogleSignInAdapter(
          idToken: 'first-google-id-token',
        );
        final service = NativeGoogleSignInService(
          config: testConfig,
          adapter: adapter,
        );

        final firstResult = await service.signIn();
        expect(firstResult, 'first-google-id-token');
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 1);

        // Subsequent sign-in call in the same runtime
        adapter.idToken = 'second-google-id-token';
        final secondResult = await service.signIn();
        expect(secondResult, 'second-google-id-token');
        // Initialize must NOT be called again; authenticate is called
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 2);
      },
    );

    test(
      'NativeGoogleSignInService concurrent signIn calls share one initialization attempt',
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
      'NativeGoogleSignInService concurrent signIn calls share failed initialization attempt',
      () async {
        final adapter = FakeGoogleSignInAdapter(shouldFailInit: true);
        final service = NativeGoogleSignInService(
          config: testConfig,
          adapter: adapter,
        );

        final futures = [
          service.signIn(),
          service.signIn(),
        ];

        for (final future in futures) {
          await expectLater(
            future,
            throwsA(
              isA<ApiException>()
                  .having((e) => e.errorCode, 'errorCode', 'GOOGLE_INIT_FAILED')
                  .having(
                    (e) => e.message,
                    'message',
                    contains('restart the app'),
                  ),
            ),
          );
        }

        // Initialize was called exactly once despite concurrent callers
        expect(adapter.initializeCount, 1);
        expect(adapter.authenticateCount, 0);
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
