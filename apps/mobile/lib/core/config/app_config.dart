import 'package:flutter/foundation.dart';

/// Client-side UI interface mode.
///
/// Per AGENTS.md Section 1.3, this is strictly a presentation-layer selection
/// and NEVER a security boundary. All role and driver verification checks are
/// enforced exclusively by the backend.
enum AppMode {
  unselected,
  passenger,
  driver;

  static AppMode fromString(String value) {
    switch (value.trim().toUpperCase()) {
      case 'PASSENGER':
        return AppMode.passenger;
      case 'DRIVER':
        return AppMode.driver;
      default:
        return AppMode.unselected;
    }
  }
}

/// Runtime application configuration sourced from `--dart-define` or
/// `--dart-define-from-file=.env` without hardcoding machine-specific URLs.
class AppConfig {
  const AppConfig({
    required this.apiBaseUrl,
    required this.socketBaseUrl,
    required this.appEnv,
    this.initialMode = AppMode.unselected,
    this.connectTimeout = const Duration(seconds: 15),
    this.receiveTimeout = const Duration(seconds: 15),
    this.sendTimeout = const Duration(seconds: 15),
  });

  /// Creates configuration from compile-time Dart environment defines,
  /// applying documented simulator defaults from DEPLOYMENT_AND_ENVIRONMENT.md
  /// when values are not explicitly provided.
  factory AppConfig.fromEnvironment({TargetPlatform? platformOverride}) {
    const rawApiBaseUrl = String.fromEnvironment('API_BASE_URL');
    const rawSocketBaseUrl = String.fromEnvironment('SOCKET_BASE_URL');
    const rawAppEnv = String.fromEnvironment(
      'APP_ENV',
      defaultValue: 'development',
    );
    const rawAppMode = String.fromEnvironment('APP_MODE');

    final platform = platformOverride ?? defaultTargetPlatform;
    final defaultHost = platform == TargetPlatform.android
        ? '10.0.2.2'
        : 'localhost';

    final resolvedApiUrl = rawApiBaseUrl.trim().isNotEmpty
        ? rawApiBaseUrl.trim()
        : 'http://$defaultHost:3000/api/v1';

    final resolvedSocketUrl = rawSocketBaseUrl.trim().isNotEmpty
        ? rawSocketBaseUrl.trim()
        : 'ws://$defaultHost:3000/realtime';

    return AppConfig(
      apiBaseUrl: resolvedApiUrl,
      socketBaseUrl: resolvedSocketUrl,
      appEnv: rawAppEnv.trim().isNotEmpty ? rawAppEnv.trim() : 'development',
      initialMode: AppMode.fromString(rawAppMode),
    );
  }

  final String apiBaseUrl;
  final String socketBaseUrl;
  final String appEnv;
  final AppMode initialMode;
  final Duration connectTimeout;
  final Duration receiveTimeout;
  final Duration sendTimeout;

  bool get isDevelopment => appEnv.toLowerCase() == 'development';
}
