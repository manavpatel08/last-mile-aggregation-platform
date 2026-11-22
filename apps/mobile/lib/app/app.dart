import 'dart:async';
import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../core/config/app_config.dart';
import '../core/network/api_client.dart';
import '../core/network/auth_refresh_interceptor.dart';
import '../core/network/auth_token_store.dart';
import '../core/realtime/io_socket_client.dart';
import '../core/realtime/models/realtime_event.dart';
import '../core/realtime/socket_client.dart';
import '../core/realtime/socket_service.dart';
import '../core/realtime/socket_ticket_provider.dart';
import '../core/realtime/sync_repository.dart';
import '../core/realtime/sync_service.dart';
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
import '../features/driver/services/driver_location_tracker.dart';
import '../features/driver/state/driver_home_provider.dart';
import '../features/driver/state/driver_onboarding_provider.dart';
import '../features/passenger/state/passenger_home_provider.dart';
import '../features/trip/data/api_trip_repository.dart';
import '../features/trip/data/trip_repository.dart';
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
    this.driverLocationTracker,
    this.driverOnboardingProvider,
    this.driverHomeProvider,
    this.bookingRepository,
    this.locationService,
    this.bookingFlowProvider,
    this.bookingDetailsProvider,
    this.passengerHomeProvider,
    this.tripRepository,
    this.socketService,
    this.socketTicketProvider,
    this.socketClient,
    this.syncRepository,
    this.syncService,
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
  final DriverLocationTracker? driverLocationTracker;
  final DriverOnboardingProvider? driverOnboardingProvider;
  final DriverHomeProvider? driverHomeProvider;
  final BookingRepository? bookingRepository;
  final PassengerLocationService? locationService;
  final BookingFlowProvider? bookingFlowProvider;
  final BookingDetailsProvider? bookingDetailsProvider;
  final PassengerHomeProvider? passengerHomeProvider;
  final TripRepository? tripRepository;
  final SocketService? socketService;
  final SocketTicketProvider? socketTicketProvider;
  final SocketClient? socketClient;
  final SyncRepository? syncRepository;
  final SyncService? syncService;

  @override
  State<LastMileApp> createState() => _LastMileAppState();
}

class _LastMileAppState extends State<LastMileApp> with WidgetsBindingObserver {
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
  late final TripRepository _tripRepository;
  late final SocketClient _socketClient;
  late final SocketService _socketService;
  late final bool _ownsSocketService;
  late final DriverLocationTracker _driverLocationTracker;
  late final bool _ownsDriverLocationTracker;
  late final SyncRepository _syncRepository;
  late final SyncService _syncService;
  late final bool _ownsSyncService;
  StreamSubscription<StandardRealtimeEvent>? _eventSubscription;
  StreamSubscription? _syncSubscription;
  late final AuthProvider _authProvider;
  late final bool _ownsAuthProvider;
  late final ApiClient _apiClient;
  late final GoRouter _router;
  String? _lastAuthUserId;

  void _handleAuthChange() {
    final currentUserId = _authProvider.user?.id;
    if (currentUserId != _lastAuthUserId) {
      _lastAuthUserId = currentUserId;
      _driverHomeProvider.clear();
    }
    if (_authProvider.isAuthenticated) {
      _socketService.connect();
    } else {
      _socketService.disconnect();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _driverLocationTracker.updateAppLifecycle(state);
    _syncService.onAppLifecycleStateChanged(state);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
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

    _ownsSocketService = widget.socketService == null;
    _socketClient = widget.socketClient ?? IOSocketClient();
    _socketService = widget.socketService ??
        RealtimeSocketService(
          config: widget.config,
          ticketProvider: widget.socketTicketProvider ??
              ApiSocketTicketProvider(apiClient: _apiClient),
          client: _socketClient,
        );

    _ownsDriverLocationTracker = widget.driverLocationTracker == null;
    _driverLocationTracker = widget.driverLocationTracker ??
        GeolocatorDriverLocationTracker(
          socketService: _socketService,
        );

    _ownsDriverHomeProvider = widget.driverHomeProvider == null;
    _driverHomeProvider = widget.driverHomeProvider ??
        DriverHomeProvider(
          driverRepository: _driverRepository,
          locationTracker: _driverLocationTracker,
        );

    _syncRepository = widget.syncRepository ??
        ApiSyncRepository(apiClient: _apiClient);
    _ownsSyncService = widget.syncService == null;
    _syncService = widget.syncService ??
        SyncService(
          syncRepository: _syncRepository,
          socketService: _socketService,
        );

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

    _tripRepository =
        widget.tripRepository ?? ApiTripRepository(apiClient: _apiClient);

    _syncSubscription = _syncService.syncStream.listen((response) {
      _passengerHomeProvider.handleSyncResponse(response.passengerState);
      _driverHomeProvider.handleSyncResponse(response.driverState);
    });

    _eventSubscription = _socketService.eventStream.listen((event) {
      if (event.event == 'booking.status.updated') {
        if (event.data is Map) {
          _passengerHomeProvider.onBookingStatusUpdated(
            Map<String, dynamic>.from(event.data as Map),
          );
        }
      } else if (event.event == 'driver.offer.withdrawn') {
        if (event.data is Map) {
          final offerId = (event.data as Map)['offerId']?.toString();
          if (offerId != null) {
            _driverHomeProvider.onOfferWithdrawn(offerId);
          }
        }
      } else if (event.event == 'driver.offer.created') {
        if (_driverHomeProvider.status?.verificationStatus == 'APPROVED') {
          _driverHomeProvider.loadOffers(repository: _driverRepository);
        }
      }
    });

    _router = AppRouter.createRouter(
      appModeProvider: _appModeProvider,
      authProvider: _authProvider,
    );

    _lastAuthUserId = _authProvider.user?.id;
    _authProvider.addListener(_handleAuthChange);
    if (_authProvider.isAuthenticated) {
      _socketService.connect();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _eventSubscription?.cancel();
    _syncSubscription?.cancel();
    _authProvider.removeListener(_handleAuthChange);
    _router.dispose();
    if (_ownsSyncService) {
      _syncService.dispose();
    }
    if (_ownsSocketService) {
      _socketService.dispose();
    }
    if (_ownsDriverLocationTracker) {
      _driverLocationTracker.dispose();
    }
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
        Provider<TripRepository>.value(value: _tripRepository),
        Provider<DriverLocationTracker>.value(value: _driverLocationTracker),
        Provider<SocketService>.value(value: _socketService),
        Provider<SyncRepository>.value(value: _syncRepository),
        ChangeNotifierProvider<SyncService>.value(value: _syncService),
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
