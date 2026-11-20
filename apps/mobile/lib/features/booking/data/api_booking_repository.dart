import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';
import '../models/booking_request.dart';
import '../models/booking_response.dart';
import '../models/fare_quote.dart';
import '../models/location_validation.dart';
import '../models/pickup_point.dart';
import '../models/service_region.dart';
import 'booking_repository.dart';

/// Production implementation of [BookingRepository] using [ApiClient].
class ApiBookingRepository implements BookingRepository {
  ApiBookingRepository({required this.apiClient});

  final ApiClient apiClient;

  String _resolvePath(String relativePath) {
    final baseUrl = apiClient.dio.options.baseUrl;
    final cleanRelative = relativePath.startsWith('/')
        ? relativePath
        : '/$relativePath';

    if (baseUrl.endsWith('/api/v1')) {
      return cleanRelative;
    }
    return '/api/v1$cleanRelative';
  }

  @override
  Future<List<PickupPoint>> getPickupZones() async {
    final response = await apiClient.get<Map<String, dynamic>>(
      _resolvePath('locations/pickup-zones'),
      requiresAuth: false,
    );

    final data = response.data?['data'];
    if (data is! List) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid pickup zones response from backend.',
      );
    }

    return data
        .map((item) => PickupPoint.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  @override
  Future<List<ServiceRegion>> getServiceRegions() async {
    final response = await apiClient.get<Map<String, dynamic>>(
      _resolvePath('locations/service-regions'),
      requiresAuth: false,
    );

    final data = response.data?['data'];
    if (data is! List) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid service regions response from backend.',
      );
    }

    return data
        .map((item) => ServiceRegion.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  @override
  Future<DestinationValidationResult> validateDestination({
    required double latitude,
    required double longitude,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('locations/validate-destination'),
      data: {
        'latitude': latitude,
        'longitude': longitude,
      },
      requiresAuth: true,
    );

    final data = response.data?['data'];
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid destination validation response from backend.',
      );
    }

    return DestinationValidationResult.fromJson(data);
  }

  @override
  Future<PickupValidationResult> validatePickup({
    required String pickupPointId,
    required double latitude,
    required double longitude,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('locations/validate-pickup'),
      data: {
        'pickupPointId': pickupPointId,
        'latitude': latitude,
        'longitude': longitude,
      },
      requiresAuth: true,
    );

    final data = response.data?['data'];
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid pickup validation response from backend.',
      );
    }

    return PickupValidationResult.fromJson(data);
  }

  @override
  Future<FareQuote> generateFareQuote({
    required String pickupPointId,
    required double destinationLatitude,
    required double destinationLongitude,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('fares/quotes'),
      data: {
        'pickupPointId': pickupPointId,
        'destination': {
          'latitude': destinationLatitude,
          'longitude': destinationLongitude,
        },
      },
      requiresAuth: true,
    );

    final data = response.data?['data'];
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid fare quote response from backend.',
      );
    }

    return FareQuote.fromJson(data);
  }

  @override
  Future<BookingResponse> createBooking({
    required BookingRequest request,
    required String idempotencyKey,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('bookings'),
      data: request.toJson(),
      idempotencyKey: idempotencyKey,
      requiresAuth: true,
    );

    final data = response.data?['data'];
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid booking creation response from backend.',
      );
    }

    return BookingResponse.fromJson(data);
  }

  @override
  Future<BookingResponse?> getActiveBooking() async {
    final response = await apiClient.get<Map<String, dynamic>>(
      _resolvePath('bookings/active'),
      requiresAuth: true,
    );

    final data = response.data?['data'];
    if (data == null) {
      return null;
    }
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid active booking response from backend.',
      );
    }

    return BookingResponse.fromJson(data);
  }
}
