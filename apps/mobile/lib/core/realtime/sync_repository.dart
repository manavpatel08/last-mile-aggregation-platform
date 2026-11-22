import '../network/api_client.dart';
import 'models/sync_models.dart';

/// Contract for state synchronization with backend `POST /api/v1/sync`.
abstract interface class SyncRepository {
  Future<SyncResponseDto> syncState(SyncRequestDto request);
}

/// Production implementation of [SyncRepository] using [ApiClient].
class ApiSyncRepository implements SyncRepository {
  const ApiSyncRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<SyncResponseDto> syncState(SyncRequestDto request) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/sync',
      data: request.toJson(),
      requiresAuth: true,
    );

    final rawData = response.data;
    if (rawData == null) {
      throw const FormatException('Empty response received from /sync');
    }

    return SyncResponseDto.fromJson(rawData);
  }
}
