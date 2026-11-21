import 'booking_request.dart';
import 'booking_response.dart';
import 'booking_status_history.dart';

/// Detailed booking model returned by `GET /api/v1/bookings/:id`.
class BookingDetails extends BookingResponse {
  const BookingDetails({
    required super.bookingId,
    required super.status,
    required super.agreedFareCeiling,
    required super.maxWaitDeadline,
    super.passengerId,
    super.pickupPointId,
    super.pickupPointName,
    super.requestedType,
    super.minGroupPreference,
    super.finalAllocatedFarePaise,
    super.cancellationReason,
    super.cancelledAt,
    super.createdAt,
    super.passengerPickupLocation,
    super.destinationLocation,
    this.statusHistory = const [],
  });

  factory BookingDetails.fromJson(Map<String, dynamic> json) {
    // 1. bookingId (required, non-empty)
    final rawBookingId = json['bookingId'] ?? json['id'];
    if (rawBookingId == null ||
        rawBookingId is! String ||
        rawBookingId.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid bookingId in BookingDetails',
      );
    }

    // 2. status (required, non-empty; unknown statuses preserved safely)
    final rawStatus = json['status'];
    if (rawStatus == null ||
        rawStatus is! String ||
        rawStatus.trim().isEmpty) {
      throw const FormatException(
        'Missing or invalid status in BookingDetails',
      );
    }

    // 3. agreedFareCeiling / agreedFareCeilingPaise (required monetary amount)
    String ceiling;
    final rawCeilingPaise = json['agreedFareCeilingPaise'];
    final rawCeiling = json['agreedFareCeiling'];
    if (rawCeilingPaise != null) {
      if (rawCeilingPaise is! num) {
        throw const FormatException(
          'Field agreedFareCeilingPaise must be numeric in BookingDetails',
        );
      }
      ceiling = (rawCeilingPaise.toInt() / 100.0).toStringAsFixed(2);
    } else if (rawCeiling != null) {
      if (rawCeiling is num) {
        ceiling = rawCeiling.toDouble().toStringAsFixed(2);
      } else if (rawCeiling is String && rawCeiling.trim().isNotEmpty) {
        ceiling = rawCeiling.trim();
      } else {
        throw const FormatException(
          'Invalid agreedFareCeiling in BookingDetails',
        );
      }
    } else {
      throw const FormatException(
        'Missing required monetary field agreedFareCeilingPaise in BookingDetails',
      );
    }

    // 4. maxWaitDeadline (required timestamp, no DateTime.now() fallback)
    final rawDeadline = json['maxWaitDeadline'];
    if (rawDeadline == null ||
        rawDeadline is! String ||
        rawDeadline.trim().isEmpty) {
      throw const FormatException(
        'Missing required maxWaitDeadline in BookingDetails',
      );
    }
    final parsedDeadline = DateTime.tryParse(rawDeadline);
    if (parsedDeadline == null) {
      throw FormatException(
        'Invalid maxWaitDeadline date format: $rawDeadline',
      );
    }

    // 5. createdAt (required timestamp, no DateTime.now() fallback)
    final rawCreatedAt = json['createdAt'];
    if (rawCreatedAt == null ||
        rawCreatedAt is! String ||
        rawCreatedAt.trim().isEmpty) {
      throw const FormatException(
        'Missing required createdAt in BookingDetails',
      );
    }
    final parsedCreatedAt = DateTime.tryParse(rawCreatedAt);
    if (parsedCreatedAt == null) {
      throw FormatException(
        'Invalid createdAt date format: $rawCreatedAt',
      );
    }

    // Optional / genuinely nullable fields
    final rawFinalFare = json['finalAllocatedFarePaise'];
    int? finalFare;
    if (rawFinalFare != null) {
      if (rawFinalFare is! num) {
        throw const FormatException(
          'Field finalAllocatedFarePaise must be numeric in BookingDetails',
        );
      }
      finalFare = rawFinalFare.toInt();
    }

    final rawCancelledAt = json['cancelledAt'];
    DateTime? parsedCancelledAt;
    if (rawCancelledAt != null) {
      if (rawCancelledAt is! String || rawCancelledAt.trim().isEmpty) {
        throw const FormatException(
          'Invalid cancelledAt in BookingDetails',
        );
      }
      parsedCancelledAt = DateTime.tryParse(rawCancelledAt);
      if (parsedCancelledAt == null) {
        throw FormatException(
          'Invalid cancelledAt date format: $rawCancelledAt',
        );
      }
    }

    final rawHistory = json['statusHistory'];
    final List<BookingStatusHistoryItem> historyList;
    if (rawHistory != null) {
      if (rawHistory is! List) {
        throw const FormatException(
          'Field statusHistory must be a list in BookingDetails',
        );
      }
      historyList = rawHistory
          .map((item) =>
              BookingStatusHistoryItem.fromJson(item as Map<String, dynamic>))
          .toList();
    } else {
      historyList = const [];
    }

    BookingLocation? pickupLoc;
    if (json['passengerPickupLocation'] != null) {
      pickupLoc = BookingLocation.fromJson(
        json['passengerPickupLocation'] as Map<String, dynamic>,
      );
    }

    BookingLocation? destLoc;
    if (json['destinationLocation'] != null) {
      destLoc = BookingLocation.fromJson(
        json['destinationLocation'] as Map<String, dynamic>,
      );
    }

    return BookingDetails(
      bookingId: rawBookingId.trim(),
      status: rawStatus.trim(),
      agreedFareCeiling: ceiling,
      maxWaitDeadline: parsedDeadline,
      passengerId: json['passengerId'] as String?,
      pickupPointId: json['pickupPointId'] as String?,
      pickupPointName: json['pickupPointName'] as String?,
      requestedType: json['requestedType'] as String?,
      minGroupPreference: (json['minGroupPreference'] as num?)?.toInt(),
      finalAllocatedFarePaise: finalFare,
      cancellationReason: json['cancellationReason'] as String?,
      cancelledAt: parsedCancelledAt,
      createdAt: parsedCreatedAt,
      passengerPickupLocation: pickupLoc,
      destinationLocation: destLoc,
      statusHistory: historyList,
    );
  }

  final List<BookingStatusHistoryItem> statusHistory;

  /// Returns status history sorted in chronological order (earliest first).
  List<BookingStatusHistoryItem> get sortedStatusHistory {
    final copy = List<BookingStatusHistoryItem>.from(statusHistory);
    copy.sort((a, b) => a.transitionTime.compareTo(b.transitionTime));
    return copy;
  }

  /// Whether this booking can be cancelled based on its current status.
  /// Cancellable statuses:
  /// - Before driver assignment: REQUESTED, MATCHING, MATCHED, DISPATCHING (₹0 fee)
  /// - After driver assignment: CONFIRMED, DRIVER_ASSIGNED, DRIVER_ARRIVED (₹30 fee)
  bool get isCancellable {
    const cancellableStatuses = {
      'REQUESTED',
      'MATCHING',
      'MATCHED',
      'DISPATCHING',
      'CONFIRMED',
      'DRIVER_ASSIGNED',
      'DRIVER_ARRIVED',
    };
    return cancellableStatuses.contains(status);
  }

  /// Whether current status is after driver assignment.
  bool get isAfterDriverAssignment {
    const postDriverStatuses = {
      'CONFIRMED',
      'DRIVER_ASSIGNED',
      'DRIVER_ARRIVED',
    };
    return postDriverStatuses.contains(status);
  }

  /// Whether cancelling this booking will incur the ₹30 late cancellation fee.
  bool get willIncurCancellationFee => isAfterDriverAssignment;

  /// Expected fee assessed if cancelled at the current lifecycle stage:
  /// ₹0 before driver assignment; ₹30 (3000 paise) after driver assignment.
  int get expectedCancellationFeePaise =>
      willIncurCancellationFee ? 3000 : 0;

  double get expectedCancellationFeeInRupees =>
      expectedCancellationFeePaise / 100.0;

  String? get finalAllocatedFareInRupees {
    if (finalAllocatedFarePaise == null) return null;
    return (finalAllocatedFarePaise! / 100).toStringAsFixed(2);
  }
}
