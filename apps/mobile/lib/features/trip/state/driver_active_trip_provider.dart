import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../../../core/network/api_exception.dart';
import '../data/trip_repository.dart';
import '../models/cash_confirmation_model.dart';
import '../models/trip_detail_model.dart';

/// State management provider for the driver active trip and passenger boarding screen.
class DriverActiveTripProvider extends ChangeNotifier {
  DriverActiveTripProvider({TripRepository? repository}) {
    _repository = repository;
  }

  TripRepository? _repository;
  TripDetailModel? _trip;
  bool _isLoadingTrip = false;
  bool _isReportingArrival = false;
  bool _isStartingTrip = false;
  bool _isCompletingTrip = false;
  final Map<String, bool> _verifyingPassengers = {};
  final Map<String, bool> _completingPassengers = {};
  final Map<String, bool> _confirmingCashPassengers = {};
  final Map<String, String?> _passengerErrors = {};
  final Map<String, String?> _cashErrors = {};
  final Map<String, String> _idempotencyKeys = {};
  final Map<String, String> _lastAttemptedOtps = {};
  final Map<String, CompletePassengerResponse> _completedDropOffs = {};
  final Map<String, CashConfirmationModel> _confirmedCashReceipts = {};
  String? _generalError;
  String? _generalSuccess;
  String? _currentTripId;

  TripDetailModel? get trip => _trip;
  bool get isLoadingTrip => _isLoadingTrip;
  bool get isReportingArrival => _isReportingArrival;
  bool get isStartingTrip => _isStartingTrip;
  bool get isCompletingTrip => _isCompletingTrip;
  String? get generalError => _generalError;
  String? get generalSuccess => _generalSuccess;
  String? get currentTripId => _currentTripId;

  List<TripPassengerModel> get passengers => _trip?.passengers ?? const [];
  bool get isAtPickup => _trip?.isAtPickup ?? false;
  bool get isInProgress => _trip?.isInProgress ?? false;
  bool get isCompleted => _trip?.isCompleted ?? false;
  bool get allPassengersBoarded =>
      passengers.isNotEmpty &&
      passengers.every((p) => p.isBoarded || p.isNoShow) &&
      passengers.any((p) => p.isBoarded);
  bool get canStartTrip => isAtPickup && allPassengersBoarded;
  bool get canCompleteTrip =>
      isInProgress &&
      passengers.isNotEmpty &&
      passengers.every((p) => p.isTerminal);

  bool isVerifying(String passengerId) =>
      _verifyingPassengers[passengerId] ?? false;

  bool isCompletingPassenger(String passengerId) =>
      _completingPassengers[passengerId] ?? false;

  bool isConfirmingCash(String passengerId) =>
      _confirmingCashPassengers[passengerId] ?? false;

  String? errorForPassenger(String passengerId) =>
      _passengerErrors[passengerId];

  String? cashError(String passengerId) => _cashErrors[passengerId];

  CompletePassengerResponse? dropOffResult(String passengerId) =>
      _completedDropOffs[passengerId];

  CashConfirmationModel? cashReceipt(String passengerId) =>
      _confirmedCashReceipts[passengerId];

  bool isCashCollected(String passengerId) =>
      _confirmedCashReceipts.containsKey(passengerId);

  @visibleForTesting
  String? getIdempotencyKeyForPassenger(String passengerId) {
    final tripId = _currentTripId ?? _trip?.tripId;
    if (tripId == null) return null;
    return _idempotencyKeys['verify_${tripId}_$passengerId'];
  }

  @visibleForTesting
  String? getCashIdempotencyKeyForPassenger(String passengerId) {
    final tripId = _currentTripId ?? _trip?.tripId;
    if (tripId == null) return null;
    TripPassengerModel? passenger;
    try {
      passenger = _trip?.passengers.firstWhere(
        (p) => p.passengerId == passengerId || p.id == passengerId,
      );
    } catch (_) {}
    final tpId = passenger?.id ?? passengerId;
    return _idempotencyKeys['confirm_cash_${tripId}_$tpId'];
  }

  void setRepository(TripRepository repository) {
    _repository = repository;
  }

  /// Loads trip details and passenger manifest for the given trip ID.
  Future<void> loadTrip(
    String tripId, {
    TripRepository? repository,
  }) async {
    final repo = repository ?? _repository;
    if (repo == null) {
      _generalError = 'Trip repository is not initialized.';
      notifyListeners();
      return;
    }

    _currentTripId = tripId;
    _isLoadingTrip = true;
    _generalError = null;
    notifyListeners();

    try {
      final tripDetails = await repo.getTripDetails(tripId);
      _trip = tripDetails;
      _generalError = null;
    } on ApiException catch (e) {
      _generalError = e.message;
    } catch (e) {
      _generalError = 'Failed to load trip manifest. Please retry.';
    } finally {
      _isLoadingTrip = false;
      notifyListeners();
    }
  }

  /// Reports driver arrival at the pickup hub (`POST /api/v1/trips/:id/arrive-pickup`).
  Future<bool> reportArrival({TripRepository? repository}) async {
    final repo = repository ?? _repository;
    final tripId = _currentTripId ?? _trip?.tripId;

    if (repo == null || tripId == null) {
      _generalError = 'Cannot report arrival: missing trip ID or repository.';
      notifyListeners();
      return false;
    }

    _isReportingArrival = true;
    _generalError = null;
    _generalSuccess = null;
    notifyListeners();

    final idempotencyKey = _idempotencyKeys.putIfAbsent(
      'arrive_$tripId',
      () => const Uuid().v4(),
    );

    try {
      final response = await repo.arriveAtPickup(
        tripId: tripId,
        idempotencyKey: idempotencyKey,
      );

      if (_trip != null) {
        _trip = _trip!.copyWith(
          status: response.status,
          driverArrivedAt: response.driverArrivedAt ?? DateTime.now(),
        );
      }
      _generalSuccess = 'Arrival confirmed at pickup point!';
      _idempotencyKeys.remove('arrive_$tripId');
      return true;
    } on ApiException catch (e) {
      _generalError = e.message;
      if (!e.isTransient) {
        _idempotencyKeys.remove('arrive_$tripId');
      }
      return false;
    } catch (e) {
      _generalError = 'Arrival reporting failed. Please check GPS connection.';
      return false;
    } finally {
      _isReportingArrival = false;
      notifyListeners();
    }
  }

  /// Verifies a passenger's 4-digit boarding OTP (`POST /api/v1/trips/:id/verify-boarding`).
  Future<bool> verifyPassengerOtp({
    required String passengerId,
    required String otp,
    TripRepository? repository,
  }) async {
    final repo = repository ?? _repository;
    final tripId = _currentTripId ?? _trip?.tripId;

    if (repo == null || tripId == null) {
      _passengerErrors[passengerId] = 'Trip details not initialized.';
      notifyListeners();
      return false;
    }

    final trimmedOtp = otp.trim();
    if (trimmedOtp.length != 4 || int.tryParse(trimmedOtp) == null) {
      _passengerErrors[passengerId] = 'Please enter a valid 4-digit numeric OTP.';
      notifyListeners();
      return false;
    }

    _verifyingPassengers[passengerId] = true;
    _passengerErrors[passengerId] = null;
    _generalSuccess = null;
    notifyListeners();

    final keyIdentifier = 'verify_${tripId}_$passengerId';

    // If the user has changed the OTP from the previously attempted value,
    // this constitutes a distinct logical request requiring a fresh key.
    if (_lastAttemptedOtps.containsKey(keyIdentifier) &&
        _lastAttemptedOtps[keyIdentifier] != trimmedOtp) {
      _idempotencyKeys.remove(keyIdentifier);
    }
    _lastAttemptedOtps[keyIdentifier] = trimmedOtp;

    final idempotencyKey = _idempotencyKeys.putIfAbsent(
      keyIdentifier,
      () => const Uuid().v4(),
    );

    try {
      final result = await repo.verifyBoarding(
        tripId: tripId,
        passengerId: passengerId,
        otp: trimmedOtp,
        idempotencyKey: idempotencyKey,
      );

      if (result.success) {
        if (_trip != null) {
          final updatedPassengers = _trip!.passengers.map((p) {
            if (p.passengerId == passengerId || p.id == passengerId) {
              return p.copyWith(
                status: 'BOARDED',
                waitingChargePaise: result.waitingChargePaise,
                boardedAt: DateTime.now(),
              );
            }
            return p;
          }).toList();

          _trip = _trip!.copyWith(passengers: updatedPassengers);
        }
        _generalSuccess = 'Passenger boarding verified successfully!';
        _passengerErrors[passengerId] = null;
        // Successful verification permanently completes the operation.
        _idempotencyKeys.remove(keyIdentifier);
        _lastAttemptedOtps.remove(keyIdentifier);
        return true;
      } else {
        _passengerErrors[passengerId] = result.message ?? 'Verification failed.';
        // Non-success response is definitive: clear idempotency key so next attempt generates fresh key.
        _idempotencyKeys.remove(keyIdentifier);
        _lastAttemptedOtps.remove(keyIdentifier);
        return false;
      }
    } on ApiException catch (e) {
      _passengerErrors[passengerId] = e.message;
      if (!e.isTransient) {
        // Definitive backend response (e.g. 400 INVALID_OTP, 400 OTP_EXPIRED,
        // 400 OTP_MAX_ATTEMPTS_EXCEEDED).
        // Clear the idempotency key so the subsequent user attempt uses a fresh key.
        _idempotencyKeys.remove(keyIdentifier);
        _lastAttemptedOtps.remove(keyIdentifier);
      }
      // If e.isTransient is true (e.g. REQUEST_TIMEOUT, NETWORK_UNAVAILABLE, 5xx),
      // do NOT clear the key. Retrying the same logical request reuses the key.
      return false;
    } catch (e) {
      // Ambiguous non-ApiException or unknown transport error:
      // Retain the idempotency key so retrying does not create duplicate attempts.
      _passengerErrors[passengerId] =
          'Network error during verification. Please retry.';
      return false;
    } finally {
      _verifyingPassengers[passengerId] = false;
      notifyListeners();
    }
  }

  void clearPassengerError(String passengerId) {
    _passengerErrors.remove(passengerId);
    _cashErrors.remove(passengerId);
    notifyListeners();
  }

  /// Starts the vehicle trip (`POST /api/v1/trips/:id/start`).
  Future<bool> startTrip({TripRepository? repository}) async {
    final repo = repository ?? _repository;
    final tripId = _currentTripId ?? _trip?.tripId;

    if (repo == null || tripId == null) {
      _generalError = 'Cannot start trip: missing trip ID or repository.';
      notifyListeners();
      return false;
    }

    if (_isStartingTrip) return false;

    _isStartingTrip = true;
    _generalError = null;
    _generalSuccess = null;
    notifyListeners();

    final idempotencyKey = _idempotencyKeys.putIfAbsent(
      'start_$tripId',
      () => const Uuid().v4(),
    );

    try {
      final response = await repo.startTrip(
        tripId: tripId,
        idempotencyKey: idempotencyKey,
      );

      if (_trip != null) {
        _trip = _trip!.copyWith(
          status: response.status,
          startedAt: response.startedAt ?? DateTime.now(),
        );
      }
      _generalSuccess = 'Trip started! In transit to Gandhinagar.';
      _idempotencyKeys.remove('start_$tripId');
      return true;
    } on ApiException catch (e) {
      _generalError = e.message;
      if (!e.isTransient) {
        _idempotencyKeys.remove('start_$tripId');
      }
      return false;
    } catch (e) {
      _generalError = 'Failed to start trip. Please retry.';
      return false;
    } finally {
      _isStartingTrip = false;
      notifyListeners();
    }
  }

  /// Completes an individual passenger's drop-off (`POST /api/v1/trips/:id/passengers/:passengerId/complete`).
  Future<bool> completePassengerDropOff({
    required String passengerId,
    TripRepository? repository,
  }) async {
    final repo = repository ?? _repository;
    final tripId = _currentTripId ?? _trip?.tripId;

    if (repo == null || tripId == null) {
      _passengerErrors[passengerId] = 'Trip details not initialized.';
      notifyListeners();
      return false;
    }

    if (_completingPassengers[passengerId] == true) return false;

    _completingPassengers[passengerId] = true;
    _passengerErrors[passengerId] = null;
    _generalSuccess = null;
    notifyListeners();

    final keyIdentifier = 'complete_pass_${tripId}_$passengerId';
    final idempotencyKey = _idempotencyKeys.putIfAbsent(
      keyIdentifier,
      () => const Uuid().v4(),
    );

    try {
      final result = await repo.completePassengerDropOff(
        tripId: tripId,
        passengerId: passengerId,
        idempotencyKey: idempotencyKey,
      );

      _completedDropOffs[passengerId] = result;

      if (_trip != null) {
        final updatedPassengers = _trip!.passengers.map((p) {
          if (p.passengerId == passengerId || p.id == passengerId) {
            return p.copyWith(
              status: 'COMPLETED',
              finalRideFarePaise: result.rideFarePaise,
              waitingChargePaise: result.waitingChargePaise,
              droppedOffAt: DateTime.now(),
            );
          }
          return p;
        }).toList();

        _trip = _trip!.copyWith(passengers: updatedPassengers);
      }
      _generalSuccess = 'Drop-off completed for passenger!';
      _passengerErrors[passengerId] = null;
      _idempotencyKeys.remove(keyIdentifier);
      return true;
    } on ApiException catch (e) {
      _passengerErrors[passengerId] = e.message;
      if (!e.isTransient) {
        _idempotencyKeys.remove(keyIdentifier);
      }
      return false;
    } catch (e) {
      _passengerErrors[passengerId] =
          'Network error during drop-off completion. Please retry.';
      return false;
    } finally {
      _completingPassengers[passengerId] = false;
      notifyListeners();
    }
  }

  /// Confirms physical cash collection for a completed passenger (`POST /api/v1/payments/confirm-cash`).
  Future<bool> confirmCashCollection({
    required String passengerId,
    TripRepository? repository,
  }) async {
    final repo = repository ?? _repository;
    final tripId = _currentTripId ?? _trip?.tripId;

    if (repo == null || tripId == null) {
      _cashErrors[passengerId] = 'Trip details not initialized.';
      notifyListeners();
      return false;
    }

    // Duplicate submission prevention
    if (_confirmingCashPassengers[passengerId] == true) return false;
    if (_confirmedCashReceipts.containsKey(passengerId)) return false;

    // Verify passenger journey is completed
    TripPassengerModel? passenger;
    try {
      passenger = _trip?.passengers.firstWhere(
        (p) => p.passengerId == passengerId || p.id == passengerId,
      );
    } catch (_) {}

    if (passenger == null || !passenger.isCompleted) {
      _cashErrors[passengerId] =
          'Cash collection is only permitted after drop-off completion.';
      notifyListeners();
      return false;
    }

    // Authoritative amount from existing drop-off response
    final dropOff = _completedDropOffs[passengerId] ??
        _completedDropOffs[passenger.passengerId] ??
        _completedDropOffs[passenger.id];

    if (dropOff == null) {
      _cashErrors[passengerId] =
          'Authoritative drop-off fare breakdown not found.';
      notifyListeners();
      return false;
    }

    final amountCollectedPaise = dropOff.totalCashToCollectPaise;
    final tripPassengerId = passenger.id;

    _confirmingCashPassengers[passengerId] = true;
    _cashErrors[passengerId] = null;
    _generalSuccess = null;
    notifyListeners();

    final keyIdentifier = 'confirm_cash_${tripId}_$tripPassengerId';
    final idempotencyKey = _idempotencyKeys.putIfAbsent(
      keyIdentifier,
      () => const Uuid().v4(),
    );

    try {
      final receipt = await repo.confirmCash(
        tripId: tripId,
        tripPassengerId: tripPassengerId,
        amountCollectedPaise: amountCollectedPaise,
        idempotencyKey: idempotencyKey,
      );

      _confirmedCashReceipts[passengerId] = receipt;
      if (passenger.passengerId != passengerId) {
        _confirmedCashReceipts[passenger.passengerId] = receipt;
      }
      if (passenger.id != passengerId) {
        _confirmedCashReceipts[passenger.id] = receipt;
      }

      _cashErrors[passengerId] = null;
      _generalSuccess = 'Cash payment confirmed and receipt generated!';
      _idempotencyKeys.remove(keyIdentifier);
      return true;
    } on ApiException catch (e) {
      _cashErrors[passengerId] = e.message;
      if (e.errorCode == 'CASH_ALREADY_COLLECTED') {
        _idempotencyKeys.remove(keyIdentifier);
      } else if (!e.isTransient) {
        _idempotencyKeys.remove(keyIdentifier);
      }
      // If e.isTransient, key is retained so safe retry reuses the key
      return false;
    } catch (e) {
      // Ambiguous transport error: retain key for safe retry
      _cashErrors[passengerId] =
          'Network error during cash confirmation. Please retry.';
      return false;
    } finally {
      _confirmingCashPassengers[passengerId] = false;
      notifyListeners();
    }
  }

  /// Finalizes the overall vehicle trip (`POST /api/v1/trips/:id/complete`).
  Future<bool> completeTrip({TripRepository? repository}) async {
    final repo = repository ?? _repository;
    final tripId = _currentTripId ?? _trip?.tripId;

    if (repo == null || tripId == null) {
      _generalError = 'Cannot complete trip: missing trip ID or repository.';
      notifyListeners();
      return false;
    }

    if (_isCompletingTrip) return false;

    _isCompletingTrip = true;
    _generalError = null;
    _generalSuccess = null;
    notifyListeners();

    final idempotencyKey = _idempotencyKeys.putIfAbsent(
      'complete_trip_$tripId',
      () => const Uuid().v4(),
    );

    try {
      final response = await repo.completeTrip(
        tripId: tripId,
        idempotencyKey: idempotencyKey,
      );

      if (_trip != null) {
        _trip = _trip!.copyWith(
          status: response.status,
          completedAt: response.completedAt ?? DateTime.now(),
        );
      }
      _generalSuccess = 'Trip completed successfully! All drop-offs finished.';
      _idempotencyKeys.remove('complete_trip_$tripId');
      return true;
    } on ApiException catch (e) {
      _generalError = e.message;
      if (!e.isTransient) {
        _idempotencyKeys.remove('complete_trip_$tripId');
      }
      return false;
    } catch (e) {
      _generalError = 'Failed to complete trip. Please retry.';
      return false;
    } finally {
      _isCompletingTrip = false;
      notifyListeners();
    }
  }

  void clearMessages() {
    _generalError = null;
    _generalSuccess = null;
    notifyListeners();
  }

  void clear() {
    _trip = null;
    _isLoadingTrip = false;
    _isReportingArrival = false;
    _isStartingTrip = false;
    _isCompletingTrip = false;
    _verifyingPassengers.clear();
    _completingPassengers.clear();
    _confirmingCashPassengers.clear();
    _passengerErrors.clear();
    _cashErrors.clear();
    _completedDropOffs.clear();
    _confirmedCashReceipts.clear();
    _idempotencyKeys.clear();
    _lastAttemptedOtps.clear();
    _generalError = null;
    _generalSuccess = null;
    _currentTripId = null;
    notifyListeners();
  }
}
