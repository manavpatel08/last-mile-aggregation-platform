import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../core/config/app_config.dart';
import '../core/network/api_client.dart';
import '../core/network/auth_refresh_interceptor.dart';
import '../core/network/auth_token_store.dart';
import '../core/storage/secure_token_storage.dart';
import '../core/theme/app_theme.dart';
import '../features/auth/data/api_auth_repository.dart';
import '../features/auth/data/auth_repository.dart';
import '../features/auth/data/google_sign_in_service.dart';
import '../features/auth/state/auth_provider.dart';
import '../features/booking/data/api_booking_repository.dart';
import '../features/booking/data/booking_repository.dart';
import '../features/booking/services/passenger_location_service.dart';
import '../features/booking/state/booking_details_provider.dart';
import '../features/booking/state/booking_flow_provider.dart';
import '../features/driver/data/api_driver_repository.dart';
import '../features/driver/data/driver_repository.dart';
import '../features/driver/state/driver_home_provider.dart';
import '../features/driver/state/driver_onboarding_provider.dart';
import '../features/passenger/state/passenger_home_provider.dart';
import 'router/app_router.dart';
import 'state/app_mode_provider.dart';

/// Root widget wiring shared configuration, Provider state management,
/// authentication, reusable Dio HTTP client, Material theme, and `go_router` navigation.
class LastMileApp extends StatefulWidget {
  const LastMileApp({
    super.key,
    required this.config,
    this.apiClient,
    this.appModeProvider,
    this.authProvider,
    this.secureStorage,
    this.tokenStore,
    this.authRepository,
    this.googleSignInService,
    this.driverRepository,
    this.driverOnboardingProvider,
    this.driverHomeProvider,
    this.bookingRepository,
    this.locationService,
    this.bookingFlowProvider,
    this.bookingDetailsProvider,
    this.passengerHomeProvider,
  });

  final AppConfig config;
  final ApiClient? apiClient;
  final AppModeProvider? appModeProvider;
  final AuthProvider? authProvider;
  final SecureTokenStorage? secureStorage;
  final AuthTokenStore? tokenStore;
  final AuthRepository? authRepository;
  final GoogleSignInService? googleSignInService;
  final DriverRepository? driverRepository;
  final DriverOnboardingProvider? driverOnboardingProvider;
  final DriverHomeProvider? driverHomeProvider;
  final BookingRepository? bookingRepository;
  final PassengerLocationService? locationService;
  final BookingFlowProvider? bookingFlowProvider;
  final BookingDetailsProvider? bookingDetailsProvider;
  final PassengerHomeProvider? passengerHomeProvider;

  @override
  State<LastMileApp> createState() => _LastMileAppState();
}

class _LastMileAppState extends State<LastMileApp> {
  late final AppModeProvider _appModeProvider;
  late final bool _ownsAppModeProvider;
  late final AuthTokenStore _tokenStore;
  late final SecureTokenStorage _secureStorage;
  late final AuthRepository _authRepository;
  late final GoogleSignInService _googleSignInService;
  late final DriverRepository _driverRepository;
  late final DriverOnboardingProvider _driverOnboardingProvider;
  late final bool _ownsDriverOnboardingProvider;
  late final DriverHomeProvider _driverHomeProvider;
  late final bool _ownsDriverHomeProvider;
  late final BookingRepository _bookingRepository;
  late final PassengerLocationService _locationService;
  late final BookingFlowProvider _bookingFlowProvider;
  late final bool _ownsBookingFlowProvider;
  late final BookingDetailsProvider _bookingDetailsProvider;
  late final bool _ownsBookingDetailsProvider;
  late final PassengerHomeProvider _passengerHomeProvider;
  late final bool _ownsPassengerHomeProvider;
  late final AuthProvider _authProvider;
  late final bool _ownsAuthProvider;
  late final ApiClient _apiClient;
  late final GoRouter _router;
  String? _lastAuthUserId;

  void _handleAuthChange() {
    final currentUserId = _authProvider.user?.id;
    if (currentUserId != _lastAuthUserId || !_authProvider.isAuthenticated) {
      _lastAuthUserId = currentUserId;
      _driverHomeProvider.clear();
    }
  }

  @override
  void initState() {
    super.initState();
    _ownsAppModeProvider = widget.appModeProvider == null;
    _appModeProvider =
        widget.appModeProvider ??
        AppModeProvider(initialMode: widget.config.initialMode);

    _tokenStore = widget.tokenStore ?? AuthTokenStore();
    _secureStorage = widget.secureStorage ?? SecureTokenStorage();
    _authRepository = widget.authRepository ??
        ApiAuthRepository(config: widget.config, tokenStore: _tokenStore);
    _googleSignInService = widget.googleSignInService ??
        NativeGoogleSignInService(config: widget.config);

    _ownsAuthProvider = widget.authProvider == null;
    _authProvider = widget.authProvider ??
        AuthProvider(
          authRepository: _authRepository,
          googleSignInService: _googleSignInService,
          tokenStore: _tokenStore,
          secureStorage: _secureStorage,
        );

    if (widget.apiClient != null) {
      _apiClient = widget.apiClient!;
    } else {
      _apiClient = ApiClient(
        config: widget.config,
        tokenProvider: () async => _tokenStore.accessToken,
      );
      final refreshInterceptor = AuthRefreshInterceptor(
        dio: _apiClient.dio,
        tokenStore: _tokenStore,
        secureStorage: _secureStorage,
        authRepository: _authRepository,
        onSessionExpired: _authProvider.onSessionExpired,
      );
      _apiClient.addInterceptor(refreshInterceptor);
    }

    _driverRepository = widget.driverRepository ??
        ApiDriverRepository(apiClient: _apiClient);

    _ownsDriverOnboardingProvider = widget.driverOnboardingProvider == null;
    _driverOnboardingProvider = widget.driverOnboardingProvider ??
        DriverOnboardingProvider(driverRepository: _driverRepository);

    _ownsDriverHomeProvider = widget.driverHomeProvider == null;
    _driverHomeProvider = widget.driverHomeProvider ??
        DriverHomeProvider(driverRepository: _driverRepository);

    _bookingRepository = widget.bookingRepository ??
        ApiBookingRepository(apiClient: _apiClient);
    _locationService = widget.locationService ??
        const GeolocatorPassengerLocationService();
    _ownsBookingFlowProvider = widget.bookingFlowProvider == null;
    _bookingFlowProvider = widget.bookingFlowProvider ??
        BookingFlowProvider(
          bookingRepository: _bookingRepository,
          locationService: _locationService,
        );

    _ownsPassengerHomeProvider = widget.passengerHomeProvider == null;
    _passengerHomeProvider =
        widget.passengerHomeProvider ?? PassengerHomeProvider();

    _ownsBookingDetailsProvider = widget.bookingDetailsProvider == null;
    _bookingDetailsProvider = widget.bookingDetailsProvider ??
        BookingDetailsProvider(
          bookingRepository: _bookingRepository,
          onCancellationConfirmed: () async {
            await _passengerHomeProvider.loadActiveBooking(_bookingRepository);
          },
        );

    _router = AppRouter.createRouter(
      appModeProvider: _appModeProvider,
      authProvider: _authProvider,
    );

    _lastAuthUserId = _authProvider.user?.id;
    _authProvider.addListener(_handleAuthChange);
  }

  @override
  void dispose() {
    _authProvider.removeListener(_handleAuthChange);
    _router.dispose();
    if (_ownsAppModeProvider) {
      _appModeProvider.dispose();
    }
    if (_ownsAuthProvider) {
      _authProvider.dispose();
    }
    if (_ownsDriverOnboardingProvider) {
      _driverOnboardingProvider.dispose();
    }
    if (_ownsDriverHomeProvider) {
      _driverHomeProvider.dispose();
    }
    if (_ownsBookingFlowProvider) {
      _bookingFlowProvider.dispose();
    }
    if (_ownsBookingDetailsProvider) {
      _bookingDetailsProvider.dispose();
    }
    if (_ownsPassengerHomeProvider) {
      _passengerHomeProvider.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider<AppConfig>.value(value: widget.config),
        Provider<AuthTokenStore>.value(value: _tokenStore),
        Provider<SecureTokenStorage>.value(value: _secureStorage),
        Provider<AuthRepository>.value(value: _authRepository),
        Provider<GoogleSignInService>.value(value: _googleSignInService),
        Provider<ApiClient>.value(value: _apiClient),
        Provider<DriverRepository>.value(value: _driverRepository),
        Provider<BookingRepository>.value(value: _bookingRepository),
        Provider<PassengerLocationService>.value(value: _locationService),
        ChangeNotifierProvider<AppModeProvider>.value(value: _appModeProvider),
        ChangeNotifierProvider<AuthProvider>.value(value: _authProvider),
        ChangeNotifierProvider<PassengerHomeProvider>.value(
          value: _passengerHomeProvider,
        ),
        ChangeNotifierProvider<DriverHomeProvider>.value(
          value: _driverHomeProvider,
        ),
        ChangeNotifierProvider<DriverOnboardingProvider>.value(
          value: _driverOnboardingProvider,
        ),
        ChangeNotifierProvider<BookingFlowProvider>.value(
          value: _bookingFlowProvider,
        ),
        ChangeNotifierProvider<BookingDetailsProvider>.value(
          value: _bookingDetailsProvider,
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
