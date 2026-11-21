import 'package:google_sign_in/google_sign_in.dart';
import 'package:lastmile_mobile/core/network/api_exception.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';
import 'package:lastmile_mobile/features/auth/data/auth_repository.dart';
import 'package:lastmile_mobile/features/auth/data/google_sign_in_service.dart';
import 'package:lastmile_mobile/features/auth/models/auth_session.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';
import 'package:lastmile_mobile/features/auth/state/auth_provider.dart';
import 'package:lastmile_mobile/features/booking/data/booking_repository.dart';
import 'package:lastmile_mobile/features/booking/models/booking_cancellation_response.dart';
import 'package:lastmile_mobile/features/booking/models/booking_details.dart';
import 'package:lastmile_mobile/features/booking/models/booking_request.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/booking/models/cancellation_fee.dart';
import 'package:lastmile_mobile/features/booking/models/fare_quote.dart';
import 'package:lastmile_mobile/features/booking/models/location_validation.dart';
import 'package:lastmile_mobile/features/booking/models/pickup_point.dart';
import 'package:lastmile_mobile/features/booking/models/service_region.dart';
import 'package:lastmile_mobile/features/driver/data/driver_repository.dart';
import 'package:lastmile_mobile/features/driver/models/driver_onboarding_request.dart';
import 'package:lastmile_mobile/features/driver/models/driver_status_response.dart';
import 'package:lastmile_mobile/features/driver/models/driver_vehicle.dart';

/// Test double for [GoogleSignInAccount].
class FakeGoogleSignInAccount implements GoogleSignInAccount {
  FakeGoogleSignInAccount({this.idToken = 'fake-google-id-token'});

  final String idToken;

  @override
  String get email => 'test@pdeu.ac.in';

  @override
  String get id => 'google-user-123';

  @override
  String? get displayName => 'Test User';

  @override
  String? get photoUrl => null;

  @override
  GoogleSignInAuthentication get authentication =>
      GoogleSignInAuthentication(idToken: idToken);

  @override
  GoogleSignInAuthorizationClient get authorizationClient =>
      throw UnimplementedError();
}

/// Test double for [GoogleSignInAdapter].
class FakeGoogleSignInAdapter implements GoogleSignInAdapter {
  FakeGoogleSignInAdapter({
    this.shouldFailInit = false,
    this.shouldCancel = false,
    this.shouldThrowOnAuth = false,
    this.idToken = 'fake-google-id-token',
  });

  bool shouldFailInit;
  bool shouldCancel;
  bool shouldThrowOnAuth;
  String idToken;

  int initializeCount = 0;
  int authenticateCount = 0;
  int signOutCount = 0;
  int disconnectCount = 0;

  @override
  Future<void> initialize({
    String? clientId,
    String? serverClientId,
  }) async {
    initializeCount++;
    if (shouldFailInit) {
      throw Exception('Google Sign-In SDK initialization failed (-1001)');
    }
  }

  @override
  Future<GoogleSignInAccount> authenticate() async {
    authenticateCount++;
    if (shouldCancel) {
      throw GoogleSignInException(
        code: GoogleSignInExceptionCode.canceled,
        description: 'Sign in canceled by user',
      );
    }
    if (shouldThrowOnAuth) {
      throw Exception('Authentication failed');
    }
    return FakeGoogleSignInAccount(idToken: idToken);
  }

  @override
  Future<void> signOut() async {
    signOutCount++;
  }

  @override
  Future<void> disconnect() async {
    disconnectCount++;
  }
}

/// Test double for [GoogleSignInService].
class FakeGoogleSignInService implements GoogleSignInService {
  FakeGoogleSignInService({
    this.fakeIdToken = 'fake-valid-google-id-token',
    this.shouldCancel = false,
    this.shouldThrow = false,
    this.shouldFailInit = false,
  });

  String? fakeIdToken;
  bool shouldCancel;
  bool shouldThrow;
  bool shouldFailInit;
  bool signedOut = false;
  bool disconnected = false;
  int authenticateCallCount = 0;

  @override
  Future<String?> signIn() async {
    if (shouldFailInit) {
      throw const ApiException(
        errorCode: 'GOOGLE_INIT_FAILED',
        message:
            'Google Sign-In initialization failed. Please restart the app.',
      );
    }
    authenticateCallCount++;
    if (shouldThrow) {
      throw Exception('Google sign-in service failure');
    }
    if (shouldCancel) {
      return null;
    }
    return fakeIdToken;
  }

  @override
  Future<void> signOut() async {
    signedOut = true;
  }

  @override
  Future<void> disconnect() async {
    disconnected = true;
  }
}

/// Test double for [AuthRepository].
class FakeAuthRepository implements AuthRepository {
  FakeAuthRepository({
    this.currentUser,
    this.authSession,
    this.refreshResult,
    this.shouldThrowOnGoogle = false,
    this.shouldThrowOnRefresh = false,
    this.shouldThrowOnUser = false,
    this.authException,
    this.refreshException,
    this.userException,
    this.onRefreshSession,
  });

  AuthUser? currentUser;
  AuthSession? authSession;
  RefreshSessionResult? refreshResult;
  bool shouldThrowOnGoogle;
  bool shouldThrowOnRefresh;
  bool shouldThrowOnUser;
  Exception? authException;
  Exception? refreshException;
  Exception? userException;
  Future<void> Function()? onRefreshSession;
  bool logoutCalled = false;
  int refreshCallCount = 0;
  int currentUserCallCount = 0;

  @override
  Future<AuthSession> authenticateWithGoogle({
    required String idToken,
    String? deviceFingerprint,
  }) async {
    if (authException != null) {
      throw authException!;
    }
    if (shouldThrowOnGoogle) {
      throw Exception('Google backend auth rejected');
    }
    return authSession ??
        AuthSession(
          user: currentUser ??
              const AuthUser(
                id: 'test-user-id',
                email: 'test@pdeu.ac.in',
                fullName: 'Test User',
                role: 'PASSENGER',
                roles: ['PASSENGER'],
              ),
          accessToken: 'mock-access-token',
          refreshToken: 'mock-refresh-token',
          expiresIn: 900,
        );
  }

  @override
  Future<RefreshSessionResult> refreshSession({
    required String refreshToken,
    String? deviceFingerprint,
  }) async {
    refreshCallCount++;
    if (onRefreshSession != null) {
      await onRefreshSession!();
    }
    if (refreshException != null) {
      throw refreshException!;
    }
    if (shouldThrowOnRefresh) {
      throw Exception('Refresh token expired or invalid');
    }
    return refreshResult ??
        const RefreshSessionResult(
          accessToken: 'rotated-access-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 900,
        );
  }

  @override
  Future<void> logout() async {
    logoutCalled = true;
  }

  @override
  Future<AuthUser> getCurrentUser() async {
    currentUserCallCount++;
    if (userException != null) {
      throw userException!;
    }
    if (shouldThrowOnUser) {
      throw Exception('User profile not found');
    }
    return currentUser ??
        const AuthUser(
          id: 'test-user-id',
          email: 'test@pdeu.ac.in',
          fullName: 'Test User',
          role: 'PASSENGER',
          roles: ['PASSENGER'],
        );
  }
}

/// Test double for [DriverRepository].
class FakeDriverRepository implements DriverRepository {
  FakeDriverRepository({
    this.response,
    this.shouldThrow = false,
    this.exceptionToThrow,
    this.statusResponse,
    this.vehiclesResponse,
    this.shouldThrowOnStatus = false,
    this.shouldThrowOnVehicles = false,
    this.statusException,
    this.vehiclesException,
  });

  DriverOnboardingResponse? response;
  bool shouldThrow;
  Exception? exceptionToThrow;
  DriverOnboardingRequest? lastRequest;
  int onboardCallCount = 0;

  DriverStatusResponse? statusResponse;
  List<DriverVehicle>? vehiclesResponse;
  bool shouldThrowOnStatus;
  bool shouldThrowOnVehicles;
  Exception? statusException;
  Exception? vehiclesException;
  int getStatusCallCount = 0;
  int getVehiclesCallCount = 0;

  @override
  Future<DriverOnboardingResponse> onboardDriver(
    DriverOnboardingRequest request,
  ) async {
    onboardCallCount++;
    lastRequest = request;
    if (exceptionToThrow != null) {
      throw exceptionToThrow!;
    }
    if (shouldThrow) {
      throw const ApiException(
        statusCode: 409,
        errorCode: 'CONFLICT',
        message: 'Driver profile already registered for this user',
      );
    }
    return response ??
        DriverOnboardingResponse(
          driverProfile: DriverProfile(
            id: 'dp-fake-123',
            licenseNumber: request.licenseNumber,
            verificationStatus: 'PENDING',
            operationalStatus: 'OFFLINE',
            isOnline: false,
          ),
          vehicle: {
            'registrationNumber': request.vehicle.registrationNumber,
            'vehicleType': request.vehicle.vehicleType,
            'passengerCapacity': request.vehicle.passengerCapacity,
            'makeModel': request.vehicle.makeModel,
          },
          message: 'Driver onboarding application submitted successfully',
        );
  }

  @override
  Future<DriverStatusResponse> getDriverStatus() async {
    getStatusCallCount++;
    if (statusException != null) throw statusException!;
    if (shouldThrowOnStatus) {
      throw const ApiException(
        statusCode: 500,
        errorCode: 'SERVER_ERROR',
        message: 'Failed to load driver status',
      );
    }
    return statusResponse ??
        const DriverStatusResponse(
          id: 'dp-fake-123',
          verificationStatus: 'APPROVED',
          operationalStatus: 'OFFLINE',
          isOnline: false,
          vehiclesCount: 1,
        );
  }

  @override
  Future<List<DriverVehicle>> getVehicles() async {
    getVehiclesCallCount++;
    if (vehiclesException != null) throw vehiclesException!;
    if (shouldThrowOnVehicles) {
      throw const ApiException(
        statusCode: 500,
        errorCode: 'SERVER_ERROR',
        message: 'Failed to load vehicles',
      );
    }
    return vehiclesResponse ??
        const [
          DriverVehicle(
            id: 'veh-fake-123',
            driverProfileId: 'dp-fake-123',
            registrationNumber: 'GJ-01-AB-1234',
            vehicleType: 'E_RICKSHAW',
            passengerCapacity: 4,
            makeModel: 'Mahindra Treo',
            isActive: true,
          ),
        ];
  }
}

/// Test double for [SecureTokenStorage] that can simulate read, write or delete failures.
class FailingSecureTokenStorage extends SecureTokenStorage {
  FailingSecureTokenStorage({
    this.failOnSave = true,
    this.failOnDelete = false,
    this.failOnRead = false,
    Map<String, String>? initialData,
  }) : super.inMemory(initialData);

  final bool failOnSave;
  final bool failOnDelete;
  bool failOnRead;

  @override
  Future<String?> getRefreshToken() async {
    if (failOnRead) {
      throw Exception('Secure storage read operation failed (-25300 Keychain lock)');
    }
    return super.getRefreshToken();
  }

  @override
  Future<void> saveRefreshToken(String token) async {
    if (failOnSave) {
      throw Exception('Secure storage write operation failed');
    }
    return super.saveRefreshToken(token);
  }

  @override
  Future<void> deleteRefreshToken() async {
    if (failOnDelete) {
      throw Exception('Secure storage delete operation failed');
    }
    return super.deleteRefreshToken();
  }
}

/// Helper that constructs an authenticated [AuthProvider] with a given [AuthUser].
AuthProvider createTestAuthProvider({
  AuthUser? user,
  AuthStatus status = AuthStatus.authenticated,
  AuthRepository? authRepository,
  GoogleSignInService? googleSignInService,
  AuthTokenStore? tokenStore,
  SecureTokenStorage? secureStorage,
}) {
  final effectiveTokenStore = tokenStore ?? AuthTokenStore();
  final effectiveSecureStorage =
      secureStorage ?? SecureTokenStorage.inMemory();
  final effectiveRepo = authRepository ??
      FakeAuthRepository(
        currentUser: user ??
            const AuthUser(
              id: 'test-user-id',
              email: 'passenger@pdeu.ac.in',
              fullName: 'PDEU Passenger',
              role: 'PASSENGER',
              roles: ['PASSENGER', 'DRIVER'],
            ),
      );
  final effectiveGoogleService =
      googleSignInService ?? FakeGoogleSignInService();

  final provider = AuthProvider(
    authRepository: effectiveRepo,
    googleSignInService: effectiveGoogleService,
    tokenStore: effectiveTokenStore,
    secureStorage: effectiveSecureStorage,
  );

  return provider;
}

/// Test double for [BookingRepository].
class FakeBookingRepository implements BookingRepository {
  FakeBookingRepository({
    this.activeBooking,
    this.bookingDetails,
    this.cancellationResponse,
    this.pickupZones = const [],
    this.serviceRegions = const [],
    this.destinationValidation =
        const DestinationValidationResult(isInsideServiceRegion: true),
    this.pickupValidation = const PickupValidationResult(
      isValid: true,
      distanceMeters: 25.0,
      allowedRadiusMeters: 150.0,
    ),
    this.fareQuote,
    this.bookingResponse,
    this.outstandingFeesResponse,
    this.shouldThrow = false,
    this.exceptionToThrow,
  });

  BookingResponse? activeBooking;
  BookingDetails? bookingDetails;
  BookingCancellationResponse? cancellationResponse;
  List<PickupPoint> pickupZones;
  List<ServiceRegion> serviceRegions;
  DestinationValidationResult destinationValidation;
  PickupValidationResult pickupValidation;
  FareQuote? fareQuote;
  BookingResponse? bookingResponse;
  OutstandingCancellationFeesResponse? outstandingFeesResponse;
  bool shouldThrow;
  Exception? exceptionToThrow;

  int getActiveBookingCallCount = 0;
  int createBookingCallCount = 0;
  int cancelBookingCallCount = 0;

  @override
  Future<BookingResponse?> getActiveBooking() async {
    getActiveBookingCallCount++;
    if (exceptionToThrow != null) throw exceptionToThrow!;
    if (shouldThrow) throw Exception('Booking repository error');
    return activeBooking;
  }

  @override
  Future<BookingResponse> createBooking({
    required BookingRequest request,
    required String idempotencyKey,
  }) async {
    createBookingCallCount++;
    if (exceptionToThrow != null) throw exceptionToThrow!;
    if (shouldThrow) throw Exception('Failed to create booking');
    return bookingResponse ??
        BookingResponse(
          bookingId: 'book-fake-123',
          status: 'REQUESTED',
          agreedFareCeiling: '45.00',
          maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
        );
  }

  @override
  Future<BookingDetails> getBookingDetails(String bookingId) async {
    if (exceptionToThrow != null) throw exceptionToThrow!;
    if (shouldThrow) throw Exception('Failed to get booking details');
    return bookingDetails ??
        BookingDetails(
          bookingId: bookingId,
          status: 'CONFIRMED',
          agreedFareCeiling: '45.00',
          maxWaitDeadline: DateTime.now().add(const Duration(minutes: 5)),
        );
  }

  @override
  Future<BookingCancellationResponse> cancelBooking({
    required String bookingId,
    String? reason,
    required String idempotencyKey,
  }) async {
    cancelBookingCallCount++;
    if (exceptionToThrow != null) throw exceptionToThrow!;
    if (shouldThrow) throw Exception('Failed to cancel booking');
    return cancellationResponse ??
        BookingCancellationResponse(
          bookingId: bookingId,
          status: 'CANCELLED',
          cancellationFeeAssessedPaise: 0,
          cancellationFeeStatus: 'NONE',
        );
  }

  @override
  Future<List<PickupPoint>> getPickupZones() async {
    if (exceptionToThrow != null) throw exceptionToThrow!;
    return pickupZones;
  }

  @override
  Future<List<ServiceRegion>> getServiceRegions() async {
    if (exceptionToThrow != null) throw exceptionToThrow!;
    return serviceRegions;
  }

  @override
  Future<DestinationValidationResult> validateDestination({
    required double latitude,
    required double longitude,
  }) async {
    if (exceptionToThrow != null) throw exceptionToThrow!;
    return destinationValidation;
  }

  @override
  Future<PickupValidationResult> validatePickup({
    required String pickupPointId,
    required double latitude,
    required double longitude,
  }) async {
    if (exceptionToThrow != null) throw exceptionToThrow!;
    return pickupValidation;
  }

  @override
  Future<FareQuote> generateFareQuote({
    required String pickupPointId,
    required double destinationLatitude,
    required double destinationLongitude,
  }) async {
    if (exceptionToThrow != null) throw exceptionToThrow!;
    return fareQuote ??
        FareQuote(
          quoteId: 'quote-fake-123',
          pickupPointId: pickupPointId,
          pickupPointName: 'PDEU Hub',
          directDistanceMeters: 2500,
          directDurationSec: 360,
          privateEstimatedFare: '45.00',
          sharedEstimatedRange: const SharedFareRange(
            minFare: '30.00',
            maxFare: '45.00',
          ),
          agreedFareCeiling: '45.00',
          tariffVersion: 1,
          expiresAt: DateTime.now().add(const Duration(minutes: 2)),
        );
  }

  @override
  Future<OutstandingCancellationFeesResponse>
      getOutstandingCancellationFees() async {
    if (exceptionToThrow != null) throw exceptionToThrow!;
    return outstandingFeesResponse ??
        const OutstandingCancellationFeesResponse(
          totalOutstandingPaise: 0,
          fees: [],
        );
  }
}
