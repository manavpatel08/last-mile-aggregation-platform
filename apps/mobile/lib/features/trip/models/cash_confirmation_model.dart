import 'package:flutter/foundation.dart';

/// Itemized allocation of cash collected towards outstanding obligations.
@immutable
class PaymentAllocationModel {
  const PaymentAllocationModel({
    required this.id,
    required this.obligationType,
    required this.obligationEntityId,
    required this.allocatedAmountPaise,
    required this.allocatedAmount,
  });

  factory PaymentAllocationModel.fromJson(Map<String, dynamic> json) {
    return PaymentAllocationModel(
      id: json['id'] as String? ?? '',
      obligationType: json['obligationType'] as String? ?? '',
      obligationEntityId: json['obligationEntityId'] as String? ?? '',
      allocatedAmountPaise:
          (json['allocatedAmountPaise'] as num?)?.toInt() ?? 0,
      allocatedAmount: json['allocatedAmount'] as String? ?? '0.00',
    );
  }

  final String id;
  final String obligationType;
  final String obligationEntityId;
  final int allocatedAmountPaise;
  final String allocatedAmount;

  Map<String, dynamic> toJson() => {
        'id': id,
        'obligationType': obligationType,
        'obligationEntityId': obligationEntityId,
        'allocatedAmountPaise': allocatedAmountPaise,
        'allocatedAmount': allocatedAmount,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PaymentAllocationModel &&
          runtimeType == other.runtimeType &&
          id == other.id &&
          obligationType == other.obligationType &&
          allocatedAmountPaise == other.allocatedAmountPaise;

  @override
  int get hashCode => Object.hash(id, obligationType, allocatedAmountPaise);
}

/// Result payload returned by `POST /api/v1/payments/confirm-cash`.
@immutable
class CashConfirmationModel {
  const CashConfirmationModel({
    required this.collectionId,
    required this.tripId,
    required this.tripPassengerId,
    required this.driverId,
    required this.totalCashCollectedPaise,
    required this.totalCashCollected,
    required this.rideFarePaise,
    required this.rideFare,
    required this.waitingChargePaise,
    required this.waitingCharge,
    required this.surchargeFeesPaise,
    required this.surchargeFees,
    required this.collectedFeeIds,
    required this.paymentStatus,
    this.confirmedAt,
    this.paymentAllocations = const [],
  });

  factory CashConfirmationModel.fromJson(Map<String, dynamic> json) {
    final rawCollectionId = json['collectionId'];
    if (rawCollectionId is! String || rawCollectionId.trim().isEmpty) {
      throw const FormatException(
        'CashConfirmationModel: missing or empty "collectionId"',
      );
    }
    final rawTripId = json['tripId'];
    if (rawTripId is! String || rawTripId.trim().isEmpty) {
      throw const FormatException(
        'CashConfirmationModel: missing or empty "tripId"',
      );
    }
    final rawTripPassengerId = json['tripPassengerId'];
    if (rawTripPassengerId is! String || rawTripPassengerId.trim().isEmpty) {
      throw const FormatException(
        'CashConfirmationModel: missing or empty "tripPassengerId"',
      );
    }
    final rawDriverId = json['driverId'];
    if (rawDriverId is! String || rawDriverId.trim().isEmpty) {
      throw const FormatException(
        'CashConfirmationModel: missing or empty "driverId"',
      );
    }
    final rawTotalCashCollected = json['totalCashCollected'];
    if (rawTotalCashCollected is! String || rawTotalCashCollected.trim().isEmpty) {
      throw const FormatException(
        'CashConfirmationModel: missing or empty "totalCashCollected"',
      );
    }
    final rawRideFare = json['rideFare'];
    if (rawRideFare is! String || rawRideFare.trim().isEmpty) {
      throw const FormatException(
        'CashConfirmationModel: missing or empty "rideFare"',
      );
    }
    final rawAllocations = json['paymentAllocations'];
    if (rawAllocations is! List) {
      throw const FormatException(
        'CashConfirmationModel: missing or invalid "paymentAllocations" list',
      );
    }

    final rawFeeIds = json['collectedFeeIds'] as List? ?? [];

    return CashConfirmationModel(
      collectionId: rawCollectionId.trim(),
      tripId: rawTripId.trim(),
      tripPassengerId: rawTripPassengerId.trim(),
      driverId: rawDriverId.trim(),
      totalCashCollectedPaise:
          (json['totalCashCollectedPaise'] as num?)?.toInt() ?? 0,
      totalCashCollected: rawTotalCashCollected.trim(),
      rideFarePaise: (json['rideFarePaise'] as num?)?.toInt() ?? 0,
      rideFare: rawRideFare.trim(),
      waitingChargePaise: (json['waitingChargePaise'] as num?)?.toInt() ?? 0,
      waitingCharge: json['waitingCharge'] as String? ?? '0.00',
      surchargeFeesPaise: (json['surchargeFeesPaise'] as num?)?.toInt() ?? 0,
      surchargeFees: json['surchargeFees'] as String? ?? '0.00',
      collectedFeeIds: rawFeeIds.map((e) => e.toString()).toList(),
      paymentStatus: json['paymentStatus'] as String? ?? 'PAID',
      confirmedAt: json['confirmedAt'] != null
          ? DateTime.tryParse(json['confirmedAt'] as String)
          : null,
      paymentAllocations: rawAllocations
          .map((a) =>
              PaymentAllocationModel.fromJson(Map<String, dynamic>.from(a as Map)))
          .toList(),
    );
  }

  final String collectionId;
  final String tripId;
  final String tripPassengerId;
  final String driverId;
  final int totalCashCollectedPaise;
  final String totalCashCollected;
  final int rideFarePaise;
  final String rideFare;
  final int waitingChargePaise;
  final String waitingCharge;
  final int surchargeFeesPaise;
  final String surchargeFees;
  final List<String> collectedFeeIds;
  final String paymentStatus;
  final DateTime? confirmedAt;
  final List<PaymentAllocationModel> paymentAllocations;

  Map<String, dynamic> toJson() => {
        'collectionId': collectionId,
        'tripId': tripId,
        'tripPassengerId': tripPassengerId,
        'driverId': driverId,
        'totalCashCollectedPaise': totalCashCollectedPaise,
        'totalCashCollected': totalCashCollected,
        'rideFarePaise': rideFarePaise,
        'rideFare': rideFare,
        'waitingChargePaise': waitingChargePaise,
        'waitingCharge': waitingCharge,
        'surchargeFeesPaise': surchargeFeesPaise,
        'surchargeFees': surchargeFees,
        'collectedFeeIds': collectedFeeIds,
        'paymentStatus': paymentStatus,
        if (confirmedAt != null) 'confirmedAt': confirmedAt!.toIso8601String(),
        'paymentAllocations':
            paymentAllocations.map((a) => a.toJson()).toList(),
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CashConfirmationModel &&
          runtimeType == other.runtimeType &&
          collectionId == other.collectionId &&
          tripId == other.tripId &&
          tripPassengerId == other.tripPassengerId &&
          totalCashCollectedPaise == other.totalCashCollectedPaise &&
          paymentStatus == other.paymentStatus;

  @override
  int get hashCode => Object.hash(
        collectionId,
        tripId,
        tripPassengerId,
        totalCashCollectedPaise,
        paymentStatus,
      );
}
