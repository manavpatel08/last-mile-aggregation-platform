import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';
import '../models/driver_onboarding_request.dart';
import 'driver_repository.dart';

/// Production implementation of [DriverRepository] integrating with NestJS REST API.
class ApiDriverRepository implements DriverRepository {
  ApiDriverRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<DriverOnboardingResponse> onboardDriver(
    DriverOnboardingRequest request,
  ) async {
    final baseUrl = apiClient.dio.options.baseUrl;
    final path = baseUrl.endsWith('/api/v1')
        ? '/drivers/onboard'
        : '/api/v1/drivers/onboard';

    final response = await apiClient.post<Map<String, dynamic>>(
      path,
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
}
