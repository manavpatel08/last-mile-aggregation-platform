import 'package:flutter/foundation.dart';

import '../../core/config/app_config.dart';

/// Application-wide state for the active client UI mode.
///
/// Strictly tracks presentation state (Role Selection vs Passenger UI vs Driver UI).
/// Backend RBAC and driver approval remain the sole authorization boundary
/// (`AGENTS.md` Section 1.3).
class AppModeProvider extends ChangeNotifier {
  AppModeProvider({AppMode initialMode = AppMode.unselected})
    : _mode = initialMode;

  AppMode _mode;

  AppMode get mode => _mode;

  bool get isPassenger => _mode == AppMode.passenger;

  bool get isDriver => _mode == AppMode.driver;

  void selectMode(AppMode nextMode) {
    if (_mode == nextMode) {
      return;
    }
    _mode = nextMode;
    notifyListeners();
  }

  void clearMode() {
    selectMode(AppMode.unselected);
  }
}
