/// Model representing the single-use ticket returned by `GET /api/v1/auth/socket-ticket`.
class SocketTicketModel {
  const SocketTicketModel({
    required this.ticket,
    required this.expiresIn,
  });

  final String ticket;
  final int expiresIn;

  factory SocketTicketModel.fromJson(Map<String, dynamic> json) {
    return SocketTicketModel(
      ticket: json['ticket'] as String? ?? '',
      expiresIn: (json['expiresIn'] as num?)?.toInt() ?? 60,
    );
  }

  Map<String, dynamic> toJson() => {
    'ticket': ticket,
    'expiresIn': expiresIn,
  };
}
