import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/features/auth/data/google_sign_in_service.dart';

import '../../../helpers/test_fakes.dart';

void main() {
  group('GoogleSignInService', () {
    test(
      'Google initialization failure prevents interactive authentication',
      () async {
        final service = FakeGoogleSignInService(shouldFailInit: true);

        // When initialization fails, signIn throws GOOGLE_INIT_FAILED and does NOT authenticate
        expect(
          () => service.signIn(),
          throwsA(
            isA<ApiException>().having(
              (e) => e.errorCode,
              'errorCode',
              'GOOGLE_INIT_FAILED',
            ),
          ),
        );
        expect(service.authenticateCallCount, 0);
      },
    );

    test('Cancellation returns null without throwing', () async {
      final service = FakeGoogleSignInService(shouldCancel: true);

      final result = await service.signIn();
      expect(result, isNull);
      expect(service.authenticateCallCount, 1);
    });

    test('Throws explicit GOOGLE_CONFIG_MISSING when client id is placeholder', () async {
      final config = AppConfig(
        apiBaseUrl: 'http://localhost:3000',
        socketBaseUrl: 'ws://localhost:3000',
        appEnv: 'development',
        googleClientIdIos: 'YOUR_IOS_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
      );
      final service = NativeGoogleSignInService(config: config);

      expect(
        () => service.signIn(),
        throwsA(
          isA<ApiException>().having(
            (e) => e.errorCode,
            'errorCode',
            'GOOGLE_CONFIG_MISSING',
          ),
        ),
      );
    });
  });
}
