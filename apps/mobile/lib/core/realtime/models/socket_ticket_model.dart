/// Model representing the single-use ticket returned by `GET /api/v1/auth/socket-ticket`.
class SocketTicketModel {
  const SocketTicketModel({
    required this.ticket,
    required this.expiresIn,
  });

  final String ticket;
  final int expiresIn;

  factory SocketTicketModel.fromJson(Map<String, dynamic> json) {
    // 1. Strict ticket validation
    if (!json.containsKey('ticket')) {
      throw const FormatException('Missing required field "ticket" in socket ticket payload');
    }
    final rawTicket = json['ticket'];
    if (rawTicket == null) {
      throw const FormatException('Field "ticket" cannot be null in socket ticket payload');
    }
    if (rawTicket is! String) {
      throw const FormatException('Field "ticket" must be a string in socket ticket payload');
    }
    final trimmedTicket = rawTicket.trim();
    if (trimmedTicket.isEmpty) {
      throw const FormatException('Field "ticket" cannot be empty or whitespace-only');
    }

    // 2. Strict expiresIn validation
    if (!json.containsKey('expiresIn')) {
      throw const FormatException('Missing required field "expiresIn" in socket ticket payload');
    }
    final rawExpiresIn = json['expiresIn'];
    if (rawExpiresIn == null) {
      throw const FormatException('Field "expiresIn" cannot be null in socket ticket payload');
    }
    if (rawExpiresIn is! int) {
      throw const FormatException('Field "expiresIn" must be an integer in socket ticket payload');
    }
    if (rawExpiresIn <= 0) {
      throw FormatException('Field "expiresIn" must be a positive integer, got $rawExpiresIn');
    }

    return SocketTicketModel(
      ticket: trimmedTicket,
      expiresIn: rawExpiresIn,
    );
  }

  Map<String, dynamic> toJson() => {
    'ticket': ticket,
    'expiresIn': expiresIn,
  };
}
