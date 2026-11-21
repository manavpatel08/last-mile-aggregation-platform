/// Status transition audit record within booking lifecycle history.
class BookingStatusHistoryItem {
  const BookingStatusHistoryItem({
    this.previousStatus,
    required this.newStatus,
    this.reason,
    required this.transitionTime,
  });

  factory BookingStatusHistoryItem.fromJson(Map<String, dynamic> json) {
    final prev = json['previousStatus'] as String?;
    final next = json['newStatus'];
    final timeStr = json['transitionTime'];

    if (next is! String || next.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid newStatus in BookingStatusHistoryItem',
      );
    }
    if (timeStr is! String || timeStr.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid transitionTime in BookingStatusHistoryItem',
      );
    }

    final parsedTime = DateTime.tryParse(timeStr);
    if (parsedTime == null) {
      throw const FormatException(
        'Invalid transitionTime ISO-8601 format in BookingStatusHistoryItem',
      );
    }

    return BookingStatusHistoryItem(
      previousStatus: prev,
      newStatus: next.trim(),
      reason: json['reason'] as String?,
      transitionTime: parsedTime,
    );
  }

  final String? previousStatus;
  final String newStatus;
  final String? reason;
  final DateTime transitionTime;

  Map<String, dynamic> toJson() => {
        if (previousStatus != null) 'previousStatus': previousStatus,
        'newStatus': newStatus,
        if (reason != null) 'reason': reason,
        'transitionTime': transitionTime.toIso8601String(),
      };
}
