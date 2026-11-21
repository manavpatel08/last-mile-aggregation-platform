/// Response payload from `POST /api/v1/bookings/:id/cancel`.
class BookingCancellationResponse {
  const BookingCancellationResponse({
    required this.bookingId,
    required this.status,
    required this.cancellationFeeAssessedPaise,
    required this.cancellationFeeStatus,
  });

  factory BookingCancellationResponse.fromJson(Map<String, dynamic> json) {
    final bookingId = json['bookingId'];
    final status = json['status'];
    final fee = json['cancellationFeeAssessedPaise'];
    final feeStatus = json['cancellationFeeStatus'];

    if (bookingId is! String || bookingId.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid bookingId in BookingCancellationResponse',
      );
    }
    if (status is! String || status.trim() != 'CANCELLED') {
      throw const FormatException(
        'Missing or invalid status in BookingCancellationResponse; expected "CANCELLED"',
      );
    }
    if (fee is! num || fee < 0 || fee != fee.toInt()) {
      throw const FormatException(
        'Missing or invalid cancellationFeeAssessedPaise in BookingCancellationResponse; expected non-negative integer',
      );
    }
    if (feeStatus is! String ||
        (feeStatus != 'NONE' && feeStatus != 'OUTSTANDING')) {
      throw const FormatException(
        'Missing or invalid cancellationFeeStatus in BookingCancellationResponse; expected "NONE" or "OUTSTANDING"',
      );
    }

    return BookingCancellationResponse(
      bookingId: bookingId.trim(),
      status: status.trim(),
      cancellationFeeAssessedPaise: fee.toInt(),
      cancellationFeeStatus: feeStatus,
    );
  }

  final String bookingId;
  final String status;
  final int cancellationFeeAssessedPaise;
  final String cancellationFeeStatus;

  double get feeInRupees => cancellationFeeAssessedPaise / 100.0;
  String get feeInRupeesFormatted =>
      (cancellationFeeAssessedPaise / 100).toStringAsFixed(2);

  bool get hasFee => cancellationFeeAssessedPaise > 0;

  Map<String, dynamic> toJson() => {
        'bookingId': bookingId,
        'status': status,
        'cancellationFeeAssessedPaise': cancellationFeeAssessedPaise,
        'cancellationFeeStatus': cancellationFeeStatus,
      };
}
