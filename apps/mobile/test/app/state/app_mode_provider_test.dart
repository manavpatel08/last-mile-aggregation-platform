import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/app/state/app_mode_provider.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';

void main() {
  group('AppModeProvider', () {
    test('starts unselected by default and updates mode with notifications', () {
      final provider = AppModeProvider();
      var notifyCount = 0;
      provider.addListener(() => notifyCount++);

      expect(provider.mode, AppMode.unselected);
      expect(provider.isPassenger, isFalse);
      expect(provider.isDriver, isFalse);

      provider.selectMode(AppMode.passenger);
      expect(provider.mode, AppMode.passenger);
      expect(provider.isPassenger, isTrue);
      expect(notifyCount, 1);

      // Selecting the same mode should not notify again.
      provider.selectMode(AppMode.passenger);
      expect(notifyCount, 1);

      provider.selectMode(AppMode.driver);
      expect(provider.mode, AppMode.driver);
      expect(provider.isDriver, isTrue);
      expect(notifyCount, 2);

      provider.clearMode();
      expect(provider.mode, AppMode.unselected);
      expect(notifyCount, 3);
    });
  });
}
