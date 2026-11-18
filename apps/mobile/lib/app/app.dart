import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../core/config/app_config.dart';
import '../core/network/api_client.dart';
import '../core/theme/app_theme.dart';
import '../features/driver/state/driver_home_provider.dart';
import '../features/passenger/state/passenger_home_provider.dart';
import 'router/app_router.dart';
import 'state/app_mode_provider.dart';

/// Root widget wiring shared configuration, Provider state management,
/// reusable Dio HTTP client, Material theme, and `go_router` navigation.
class LastMileApp extends StatefulWidget {
  const LastMileApp({
    super.key,
    required this.config,
    this.apiClient,
    this.appModeProvider,
  });

  final AppConfig config;
  final ApiClient? apiClient;
  final AppModeProvider? appModeProvider;

  @override
  State<LastMileApp> createState() => _LastMileAppState();
}

class _LastMileAppState extends State<LastMileApp> {
  late final AppModeProvider _appModeProvider;
  late final bool _ownsAppModeProvider;
  late final ApiClient _apiClient;
  late final GoRouter _router;

  @override
  void initState() {
    super.initState();
    _ownsAppModeProvider = widget.appModeProvider == null;
    _appModeProvider =
        widget.appModeProvider ??
        AppModeProvider(initialMode: widget.config.initialMode);
    _apiClient = widget.apiClient ?? ApiClient(config: widget.config);
    _router = AppRouter.createRouter(appModeProvider: _appModeProvider);
  }

  @override
  void dispose() {
    _router.dispose();
    if (_ownsAppModeProvider) {
      _appModeProvider.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider<AppConfig>.value(value: widget.config),
        Provider<ApiClient>.value(value: _apiClient),
        ChangeNotifierProvider<AppModeProvider>.value(value: _appModeProvider),
        ChangeNotifierProvider<PassengerHomeProvider>(
          create: (_) => PassengerHomeProvider(),
        ),
        ChangeNotifierProvider<DriverHomeProvider>(
          create: (_) => DriverHomeProvider(),
        ),
      ],
      child: MaterialApp.router(
        title: 'LastMile',
        theme: AppTheme.lightTheme,
        routerConfig: _router,
        debugShowCheckedModeBanner: false,
      ),
    );
  }
}
