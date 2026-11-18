import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';

void main() {
  group('AppMode.fromString', () {
    test('parses passenger and driver values case-insensitively', () {
      expect(AppMode.fromString('PASSENGER'), AppMode.passenger);
      expect(AppMode.fromString('passenger'), AppMode.passenger);
      expect(AppMode.fromString(' DRIVER '), AppMode.driver);
      expect(AppMode.fromString('driver'), AppMode.driver);
    });

    test('falls back to unselected for empty or unknown values', () {
      expect(AppMode.fromString(''), AppMode.unselected);
      expect(AppMode.fromString('ADMIN'), AppMode.unselected);
    });
  });

  group('AppConfig.fromEnvironment', () {
    test('uses localhost defaults on iOS when env defines are absent', () {
      final config = AppConfig.fromEnvironment(
        platformOverride: TargetPlatform.iOS,
      );

      expect(config.apiBaseUrl, 'http://localhost:3000/api/v1');
      expect(config.socketBaseUrl, 'ws://localhost:3000/realtime');
      expect(config.appEnv, 'development');
      expect(config.isDevelopment, isTrue);
      expect(config.initialMode, AppMode.unselected);
    });

    test('uses 10.0.2.2 defaults on Android when env defines are absent', () {
      final config = AppConfig.fromEnvironment(
        platformOverride: TargetPlatform.android,
      );

      expect(config.apiBaseUrl, 'http://10.0.2.2:3000/api/v1');
      expect(config.socketBaseUrl, 'ws://10.0.2.2:3000/realtime');
    });
  });
}
