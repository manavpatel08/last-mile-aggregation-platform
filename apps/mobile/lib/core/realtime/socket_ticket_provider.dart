import 'package:dio/dio.dart';

import '../network/api_client.dart';
import 'models/socket_ticket_model.dart';

/// Contract for fetching short-lived, single-use Socket.IO handshake tickets.
abstract interface class SocketTicketProvider {
  /// Fetches a fresh single-use ticket from `GET /api/v1/auth/socket-ticket`.
  Future<SocketTicketModel> getTicket({CancelToken? cancelToken});
}

/// Production implementation of [SocketTicketProvider] using [ApiClient].
class ApiSocketTicketProvider implements SocketTicketProvider {
  const ApiSocketTicketProvider({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<SocketTicketModel> getTicket({CancelToken? cancelToken}) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/auth/socket-ticket',
      requiresAuth: true,
      cancelToken: cancelToken,
    );

    final rawData = response.data;
    if (rawData == null) {
      throw const FormatException('Empty response received from /auth/socket-ticket');
    }

    if (rawData.containsKey('data')) {
      final data = rawData['data'];
      if (data == null) {
        throw const FormatException('Malformed response envelope: "data" field cannot be null');
      }
      if (data is! Map) {
        throw const FormatException('Malformed response envelope: "data" field must be a JSON object');
      }
      return SocketTicketModel.fromJson(Map<String, dynamic>.from(data));
    }

    return SocketTicketModel.fromJson(rawData);
  }
}
