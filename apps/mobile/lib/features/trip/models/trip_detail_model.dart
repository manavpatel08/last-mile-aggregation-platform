import 'package:flutter/foundation.dart';

/// Individual passenger journey within a trip manifest.
@immutable
class TripPassengerModel {
  const TripPassengerModel({
    required this.id,
    required this.passengerId,
    required this.bookingId,
    required this.status,
    required this.finalRideFarePaise,
    required this.waitingChargePaise,
    this.boardedAt,
    this.droppedOffAt,
  });

  factory TripPassengerModel.fromJson(Map<String, dynamic> json) {
    return TripPassengerModel(
      id: json['id'] as String? ?? '',
      passengerId: json['passengerId'] as String? ?? '',
      bookingId: json['bookingId'] as String? ?? '',
      status: json['status'] as String? ?? 'ASSIGNED',
      finalRideFarePaise: (json['finalRideFarePaise'] as num?)?.toInt() ?? 0,
      waitingChargePaise: (json['waitingChargePaise'] as num?)?.toInt() ?? 0,
      boardedAt: json['boardedAt'] != null
          ? DateTime.tryParse(json['boardedAt'] as String)
          : null,
      droppedOffAt: json['droppedOffAt'] != null
          ? DateTime.tryParse(json['droppedOffAt'] as String)
          : null,
    );
  }

  final String id;
  final String passengerId;
  final String bookingId;
  final String status;
  final int finalRideFarePaise;
  final int waitingChargePaise;
  final DateTime? boardedAt;
  final DateTime? droppedOffAt;

  bool get isBoarded => status == 'BOARDED';
  bool get isNoShow => status == 'NO_SHOW';
  bool get isCompleted => status == 'COMPLETED';
  bool get isCancelled => status == 'CANCELLED';
  bool get isTerminal => isCompleted || isNoShow || isCancelled;

  TripPassengerModel copyWith({
    String? status,
    int? finalRideFarePaise,
    int? waitingChargePaise,
    DateTime? boardedAt,
    DateTime? droppedOffAt,
  }) {
    return TripPassengerModel(
      id: id,
      passengerId: passengerId,
      bookingId: bookingId,
      status: status ?? this.status,
      finalRideFarePaise: finalRideFarePaise ?? this.finalRideFarePaise,
      waitingChargePaise: waitingChargePaise ?? this.waitingChargePaise,
      boardedAt: boardedAt ?? this.boardedAt,
      droppedOffAt: droppedOffAt ?? this.droppedOffAt,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'passengerId': passengerId,
        'bookingId': bookingId,
        'status': status,
        'finalRideFarePaise': finalRideFarePaise,
        'waitingChargePaise': waitingChargePaise,
        if (boardedAt != null) 'boardedAt': boardedAt!.toIso8601String(),
        if (droppedOffAt != null) 'droppedOffAt': droppedOffAt!.toIso8601String(),
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TripPassengerModel &&
          runtimeType == other.runtimeType &&
          id == other.id &&
          passengerId == other.passengerId &&
          bookingId == other.bookingId &&
          status == other.status &&
          finalRideFarePaise == other.finalRideFarePaise &&
          waitingChargePaise == other.waitingChargePaise;

  @override
  int get hashCode => Object.hash(
        id,
        passengerId,
        bookingId,
        status,
        finalRideFarePaise,
        waitingChargePaise,
      );
}

/// Comprehensive trip details retrieved via `GET /api/v1/trips/:id`.
@immutable
class TripDetailModel {
  const TripDetailModel({
    required this.tripId,
    required this.rideGroupId,
    required this.activeDriverId,
    required this.status,
    this.driverArrivedAt,
    this.startedAt,
    this.completedAt,
    required this.passengers,
  });

  factory TripDetailModel.fromJson(Map<String, dynamic> json) {
    final rawPassengers = json['passengers'] as List? ?? [];
    return TripDetailModel(
      tripId: json['tripId'] as String? ?? json['id'] as String? ?? '',
      rideGroupId: json['rideGroupId'] as String? ?? '',
      activeDriverId: json['activeDriverId'] as String? ?? '',
      status: json['status'] as String? ?? 'CREATED',
      driverArrivedAt: json['driverArrivedAt'] != null
          ? DateTime.tryParse(json['driverArrivedAt'] as String)
          : null,
      startedAt: json['startedAt'] != null
          ? DateTime.tryParse(json['startedAt'] as String)
          : null,
      completedAt: json['completedAt'] != null
          ? DateTime.tryParse(json['completedAt'] as String)
          : null,
      passengers: rawPassengers
          .map((p) => TripPassengerModel.fromJson(p as Map<String, dynamic>))
          .toList(),
    );
  }

  final String tripId;
  final String rideGroupId;
  final String activeDriverId;
  final String status;
  final DateTime? driverArrivedAt;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final List<TripPassengerModel> passengers;

  bool get isAtPickup => status == 'AT_PICKUP';
  bool get isInProgress => status == 'IN_PROGRESS';
  bool get isCompleted => status == 'COMPLETED';

  TripDetailModel copyWith({
    String? status,
    DateTime? driverArrivedAt,
    DateTime? startedAt,
    DateTime? completedAt,
    List<TripPassengerModel>? passengers,
  }) {
    return TripDetailModel(
      tripId: tripId,
      rideGroupId: rideGroupId,
      activeDriverId: activeDriverId,
      status: status ?? this.status,
      driverArrivedAt: driverArrivedAt ?? this.driverArrivedAt,
      startedAt: startedAt ?? this.startedAt,
      completedAt: completedAt ?? this.completedAt,
      passengers: passengers ?? this.passengers,
    );
  }

  Map<String, dynamic> toJson() => {
        'tripId': tripId,
        'rideGroupId': rideGroupId,
        'activeDriverId': activeDriverId,
        'status': status,
        if (driverArrivedAt != null)
          'driverArrivedAt': driverArrivedAt!.toIso8601String(),
        if (startedAt != null) 'startedAt': startedAt!.toIso8601String(),
        if (completedAt != null) 'completedAt': completedAt!.toIso8601String(),
        'passengers': passengers.map((p) => p.toJson()).toList(),
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TripDetailModel &&
          runtimeType == other.runtimeType &&
          tripId == other.tripId &&
          rideGroupId == other.rideGroupId &&
          status == other.status &&
          driverArrivedAt == other.driverArrivedAt;

  @override
  int get hashCode => Object.hash(
        tripId,
        rideGroupId,
        status,
        driverArrivedAt,
      );
}

/// Response returned by `POST /api/v1/trips/:id/arrive-pickup`.
@immutable
class ArrivePickupResponse {
  const ArrivePickupResponse({
    required this.tripId,
    required this.status,
    this.driverArrivedAt,
  });

  factory ArrivePickupResponse.fromJson(Map<String, dynamic> json) {
    return ArrivePickupResponse(
      tripId: json['tripId'] as String? ?? '',
      status: json['status'] as String? ?? 'AT_PICKUP',
      driverArrivedAt: json['driverArrivedAt'] != null
          ? DateTime.tryParse(json['driverArrivedAt'] as String)
          : null,
    );
  }

  final String tripId;
  final String status;
  final DateTime? driverArrivedAt;

  Map<String, dynamic> toJson() => {
        'tripId': tripId,
        'status': status,
        if (driverArrivedAt != null)
          'driverArrivedAt': driverArrivedAt!.toIso8601String(),
      };
}

/// Response returned by `POST /api/v1/trips/:id/verify-boarding`.
@immutable
class VerifyBoardingResponse {
  const VerifyBoardingResponse({
    required this.success,
    required this.passengerStatus,
    this.waitingChargePaise = 0,
    this.message,
  });

  factory VerifyBoardingResponse.fromJson(Map<String, dynamic> json) {
    String status = 'BOARDED';
    int waitingPaise = 0;

    if (json.containsKey('data') && json['data'] is Map<String, dynamic>) {
      final inner = json['data'] as Map<String, dynamic>;
      status = inner['passengerStatus'] as String? ??
          inner['status'] as String? ??
          'BOARDED';
      waitingPaise = (inner['waitingChargePaise'] as num?)?.toInt() ?? 0;
    } else if (json.containsKey('passengerStatus')) {
      status = json['passengerStatus'] as String? ?? 'BOARDED';
      waitingPaise = (json['waitingChargePaise'] as num?)?.toInt() ?? 0;
    }

    return VerifyBoardingResponse(
      success: true,
      passengerStatus: status,
      waitingChargePaise: waitingPaise,
      message: json['message'] as String?,
    );
  }

  final bool success;
  final String passengerStatus;
  final int waitingChargePaise;
  final String? message;

  Map<String, dynamic> toJson() => {
        'success': success,
        'passengerStatus': passengerStatus,
        'waitingChargePaise': waitingChargePaise,
        if (message != null) 'message': message,
      };
}

/// Response returned by `POST /api/v1/trips/:id/start`.
@immutable
class StartTripResponse {
  const StartTripResponse({
    required this.tripId,
    required this.status,
    this.startedAt,
  });

  factory StartTripResponse.fromJson(Map<String, dynamic> json) {
    return StartTripResponse(
      tripId: json['tripId'] as String? ?? '',
      status: json['status'] as String? ?? 'IN_PROGRESS',
      startedAt: json['startedAt'] != null
          ? DateTime.tryParse(json['startedAt'] as String)
          : null,
    );
  }

  final String tripId;
  final String status;
  final DateTime? startedAt;

  Map<String, dynamic> toJson() => {
        'tripId': tripId,
        'status': status,
        if (startedAt != null) 'startedAt': startedAt!.toIso8601String(),
      };
}

/// Response returned by `POST /api/v1/trips/:id/passengers/:passengerId/complete`.
@immutable
class CompletePassengerResponse {
  const CompletePassengerResponse({
    required this.passengerId,
    required this.status,
    required this.rideFarePaise,
    required this.rideFare,
    required this.waitingChargePaise,
    required this.waitingCharge,
    required this.totalCashToCollectPaise,
    required this.totalCashToCollect,
  });

  factory CompletePassengerResponse.fromJson(Map<String, dynamic> json) {
    return CompletePassengerResponse(
      passengerId: json['passengerId'] as String? ?? '',
      status: json['status'] as String? ?? 'COMPLETED',
      rideFarePaise: (json['rideFarePaise'] as num?)?.toInt() ?? 0,
      rideFare: json['rideFare'] as String? ?? '0.00',
      waitingChargePaise: (json['waitingChargePaise'] as num?)?.toInt() ?? 0,
      waitingCharge: json['waitingCharge'] as String? ?? '0.00',
      totalCashToCollectPaise:
          (json['totalCashToCollectPaise'] as num?)?.toInt() ?? 0,
      totalCashToCollect: json['totalCashToCollect'] as String? ?? '0.00',
    );
  }

  final String passengerId;
  final String status;
  final int rideFarePaise;
  final String rideFare;
  final int waitingChargePaise;
  final String waitingCharge;
  final int totalCashToCollectPaise;
  final String totalCashToCollect;

  Map<String, dynamic> toJson() => {
        'passengerId': passengerId,
        'status': status,
        'rideFarePaise': rideFarePaise,
        'rideFare': rideFare,
        'waitingChargePaise': waitingChargePaise,
        'waitingCharge': waitingCharge,
        'totalCashToCollectPaise': totalCashToCollectPaise,
        'totalCashToCollect': totalCashToCollect,
      };
}

/// Response returned by `POST /api/v1/trips/:id/complete`.
@immutable
class CompleteTripResponse {
  const CompleteTripResponse({
    required this.tripId,
    required this.status,
    this.completedAt,
  });

  factory CompleteTripResponse.fromJson(Map<String, dynamic> json) {
    return CompleteTripResponse(
      tripId: json['tripId'] as String? ?? '',
      status: json['status'] as String? ?? 'COMPLETED',
      completedAt: json['completedAt'] != null
          ? DateTime.tryParse(json['completedAt'] as String)
          : null,
    );
  }

  final String tripId;
  final String status;
  final DateTime? completedAt;

  Map<String, dynamic> toJson() => {
        'tripId': tripId,
        'status': status,
        if (completedAt != null) 'completedAt': completedAt!.toIso8601String(),
      };
}
