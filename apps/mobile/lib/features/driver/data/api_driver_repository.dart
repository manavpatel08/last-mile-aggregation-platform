import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';
import '../models/driver_onboarding_request.dart';
import '../models/driver_status_response.dart';
import '../models/driver_vehicle.dart';
import 'driver_repository.dart';

/// Production implementation of [DriverRepository] integrating with NestJS REST API.
class ApiDriverRepository implements DriverRepository {
  ApiDriverRepository({required this.apiClient});

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
  Future<DriverOnboardingResponse> onboardDriver(
    DriverOnboardingRequest request,
  ) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      _resolvePath('drivers/onboard'),
      data: request.toJson(),
      requiresAuth: true,
    );

    final data = response.data;
    if (data == null) {
      throw const ApiException(
        errorCode: 'INVALID_ONBOARDING_RESPONSE',
        message: 'Empty response received from driver onboarding.',
      );
    }

    return DriverOnboardingResponse.fromJson(data);
  }

  @override
  Future<DriverStatusResponse> getDriverStatus() async {
    final response = await apiClient.get<dynamic>(
      _resolvePath('drivers/status'),
      requiresAuth: true,
    );

    final rawData = response.data;
    if (rawData == null) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Empty response received from driver status.',
      );
    }

    final Map<String, dynamic>? dataMap;
    if (rawData is Map<String, dynamic>) {
      if (rawData['data'] is Map<String, dynamic>) {
        dataMap = rawData['data'] as Map<String, dynamic>;
      } else {
        dataMap = rawData;
      }
    } else {
      dataMap = null;
    }

    if (dataMap == null) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid driver status response structure.',
      );
    }

    try {
      return DriverStatusResponse.fromJson(dataMap);
    } on FormatException catch (e) {
      throw ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Malformed driver status response: ${e.message}',
      );
    }
  }

  @override
  Future<List<DriverVehicle>> getVehicles() async {
    final response = await apiClient.get<dynamic>(
      _resolvePath('drivers/vehicles'),
      requiresAuth: true,
    );

    final rawData = response.data;
    if (rawData == null) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Empty response received from driver vehicles.',
      );
    }

    final List<dynamic>? list;
    if (rawData is Map<String, dynamic> && rawData['data'] is List) {
      list = rawData['data'] as List<dynamic>;
    } else if (rawData is List) {
      list = rawData;
    } else {
      list = null;
    }

    if (list == null) {
      throw const ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Invalid vehicles list structure in response.',
      );
    }

    try {
      return list
          .map((item) {
            if (item is! Map<String, dynamic>) {
              throw const FormatException('Vehicle item is not a JSON object');
            }
            return DriverVehicle.fromJson(item);
          })
          .toList();
    } on FormatException catch (e) {
      throw ApiException(
        errorCode: 'INVALID_RESPONSE',
        message: 'Malformed vehicle item in response: ${e.message}',
      );
    }
  }
}
