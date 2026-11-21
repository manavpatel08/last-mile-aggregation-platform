import 'package:flutter/widgets.dart';

import 'app/app.dart';
import 'core/config/app_config.dart';
import 'features/driver/services/driver_location_tracker.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromEnvironment();
  runApp(
    LastMileApp(
      config: config,
      driverLocationTracker: GeolocatorDriverLocationTracker(),
    ),
  );
}
