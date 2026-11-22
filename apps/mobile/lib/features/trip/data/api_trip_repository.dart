import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';
import '../models/cash_confirmation_model.dart';
import '../models/passenger_boarding_pass.dart';
import '../models/trip_detail_model.dart';
import 'trip_repository.dart';

/// Concrete implementation of [TripRepository] communicating with the backend APIs via [ApiClient].
class ApiTripRepository implements TripRepository {
  ApiTripRepository({required this.apiClient});

  final ApiClient apiClient;

  String _resolvePath(String relativePath) {
    final baseUrl = apiClient.dio.options.baseUrl;
    final cleanRelative =
        relativePath.startsWith('/') ? relativePath : '/$relativePath';

    if (baseUrl.endsWith('/api/v1')) {
      return cleanRelative;
    }
    return '/api/v1$cleanRelative';
  }

  @override
  Future<PassengerBoardingPass> getPassengerBoardingPass(
      String bookingId) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      _resolvePath('bookings/$bookingId/boarding-pass'),
      requiresAuth: true,
    );

    final rawData = response.data?['data'];
    if (rawData is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid boarding pass response structure from backend.',
      );
    }

    return PassengerBoardingPass.fromJson(rawData);
  }

  @override
  Future<TripDetailModel> getTripDetails(String tripId) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      _resolvePath('trips/$tripId'),
      requiresAuth: true,
    );

    final rawData = response.data?['data'];
    if (rawData is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid trip details response structure from backend.',
      );
    }

    return TripDetailModel.fromJson(rawData);
  }

  @override
  Future<ArrivePickupResponse> arriveAtPickup({
    required String tripId,
    required String idempotencyKey,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('trips/$tripId/arrive-pickup'),
      idempotencyKey: idempotencyKey,
      requiresAuth: true,
    );

    final rawData = response.data?['data'];
    if (rawData is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid arrival response structure from backend.',
      );
    }

    return ArrivePickupResponse.fromJson(rawData);
  }

  @override
  Future<VerifyBoardingResponse> verifyBoarding({
    required String tripId,
    required String passengerId,
    required String otp,
    required String idempotencyKey,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('trips/$tripId/verify-boarding'),
      data: {
        'passengerId': passengerId,
        'otp': otp,
      },
      idempotencyKey: idempotencyKey,
      requiresAuth: true,
    );

    final responseData = response.data;
    if (responseData == null) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Empty response returned from boarding verification.',
      );
    }

    return VerifyBoardingResponse.fromJson(responseData);
  }

  @override
  Future<StartTripResponse> startTrip({
    required String tripId,
    required String idempotencyKey,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('trips/$tripId/start'),
      idempotencyKey: idempotencyKey,
      requiresAuth: true,
    );

    final rawData = response.data?['data'];
    if (rawData is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid start trip response structure from backend.',
      );
    }

    return StartTripResponse.fromJson(rawData);
  }

  @override
  Future<CompletePassengerResponse> completePassengerDropOff({
    required String tripId,
    required String passengerId,
    required String idempotencyKey,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('trips/$tripId/passengers/$passengerId/complete'),
      idempotencyKey: idempotencyKey,
      requiresAuth: true,
    );

    final rawData = response.data?['data'];
    if (rawData is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid passenger completion response structure from backend.',
      );
    }

    return CompletePassengerResponse.fromJson(rawData);
  }

  @override
  Future<CompleteTripResponse> completeTrip({
    required String tripId,
    required String idempotencyKey,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('trips/$tripId/complete'),
      idempotencyKey: idempotencyKey,
      requiresAuth: true,
    );

    final rawData = response.data?['data'];
    if (rawData is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid trip completion response structure from backend.',
      );
    }

    return CompleteTripResponse.fromJson(rawData);
  }

  @override
  Future<CashConfirmationModel> confirmCash({
    required String tripId,
    required String tripPassengerId,
    required int amountCollectedPaise,
    required String idempotencyKey,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('payments/confirm-cash'),
      data: {
        'tripId': tripId,
        'tripPassengerId': tripPassengerId,
        'amountCollectedPaise': amountCollectedPaise,
      },
      idempotencyKey: idempotencyKey,
      requiresAuth: true,
    );

    final rawData = response.data?['data'];
    if (rawData is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid cash confirmation response structure from backend.',
      );
    }

    return CashConfirmationModel.fromJson(rawData);
  }
}
