/// Individual outstanding cancellation fee item for a passenger.
class OutstandingFeeItem {
  const OutstandingFeeItem({
    required this.id,
    required this.originalBookingId,
    required this.amountPaise,
    required this.createdAt,
  });

  factory OutstandingFeeItem.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final originalBookingId = json['originalBookingId'];
    final amount = json['amountPaise'];
    final createdAtStr = json['createdAt'];

    if (id is! String || id.isEmpty) {
      throw const FormatException(
        'Missing or invalid id in OutstandingFeeItem',
      );
    }
    if (originalBookingId is! String || originalBookingId.isEmpty) {
      throw const FormatException(
        'Missing or invalid originalBookingId in OutstandingFeeItem',
      );
    }
    if (amount is! num) {
      throw const FormatException(
        'Missing or invalid amountPaise in OutstandingFeeItem',
      );
    }
    if (createdAtStr is! String || createdAtStr.isEmpty) {
      throw const FormatException(
        'Missing or invalid createdAt in OutstandingFeeItem',
      );
    }

    final parsedCreatedAt = DateTime.tryParse(createdAtStr);
    if (parsedCreatedAt == null) {
      throw const FormatException(
        'Invalid createdAt format in OutstandingFeeItem',
      );
    }

    return OutstandingFeeItem(
      id: id,
      originalBookingId: originalBookingId,
      amountPaise: amount.toInt(),
      createdAt: parsedCreatedAt,
    );
  }

  final String id;
  final String originalBookingId;
  final int amountPaise;
  final DateTime createdAt;

  double get amountInRupees => amountPaise / 100.0;
  String get amountInRupeesFormatted =>
      (amountPaise / 100).toStringAsFixed(2);

  Map<String, dynamic> toJson() => {
        'id': id,
        'originalBookingId': originalBookingId,
        'amountPaise': amountPaise,
        'createdAt': createdAt.toIso8601String(),
      };
}

/// Response payload from `GET /api/v1/passengers/cancellation-fees/outstanding`.
class OutstandingCancellationFeesResponse {
  const OutstandingCancellationFeesResponse({
    required this.totalOutstandingPaise,
    required this.fees,
  });

  factory OutstandingCancellationFeesResponse.fromJson(
    Map<String, dynamic> json,
  ) {
    final total = json['totalOutstandingPaise'];
    final rawFees = json['fees'];

    if (total is! num) {
      throw const FormatException(
        'Missing or invalid totalOutstandingPaise in OutstandingCancellationFeesResponse',
      );
    }
    if (rawFees is! List) {
      throw const FormatException(
        'Missing or invalid fees list in OutstandingCancellationFeesResponse',
      );
    }

    final feesList = rawFees
        .map((item) {
          if (item is! Map<String, dynamic>) {
            throw const FormatException(
              'Each item in fees list must be a JSON object',
            );
          }
          return OutstandingFeeItem.fromJson(item);
        })
        .toList();

    return OutstandingCancellationFeesResponse(
      totalOutstandingPaise: total.toInt(),
      fees: feesList,
    );
  }

  final int totalOutstandingPaise;
  final List<OutstandingFeeItem> fees;

  double get totalOutstandingInRupees => totalOutstandingPaise / 100.0;
  String get totalOutstandingInRupeesFormatted =>
      (totalOutstandingPaise / 100).toStringAsFixed(2);

  bool get hasOutstandingFees => totalOutstandingPaise > 0;

  Map<String, dynamic> toJson() => {
        'totalOutstandingPaise': totalOutstandingPaise,
        'fees': fees.map((f) => f.toJson()).toList(),
      };
}
