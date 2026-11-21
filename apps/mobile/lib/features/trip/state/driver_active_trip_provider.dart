import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../../../core/network/api_exception.dart';
import '../data/trip_repository.dart';
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
  final Map<String, bool> _verifyingPassengers = {};
  final Map<String, String?> _passengerErrors = {};
  final Map<String, String> _idempotencyKeys = {};
  String? _generalError;
  String? _generalSuccess;
  String? _currentTripId;

  TripDetailModel? get trip => _trip;
  bool get isLoadingTrip => _isLoadingTrip;
  bool get isReportingArrival => _isReportingArrival;
  String? get generalError => _generalError;
  String? get generalSuccess => _generalSuccess;
  String? get currentTripId => _currentTripId;

  List<TripPassengerModel> get passengers => _trip?.passengers ?? const [];
  bool get isAtPickup => _trip?.isAtPickup ?? false;
  bool get allPassengersBoarded =>
      passengers.isNotEmpty && passengers.every((p) => p.isBoarded || p.isNoShow);

  bool isVerifying(String passengerId) =>
      _verifyingPassengers[passengerId] ?? false;

  String? errorForPassenger(String passengerId) =>
      _passengerErrors[passengerId];

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
        _idempotencyKeys.remove(keyIdentifier);
        return true;
      } else {
        _passengerErrors[passengerId] = result.message ?? 'Verification failed.';
        return false;
      }
    } on ApiException catch (e) {
      _passengerErrors[passengerId] = e.message;
      return false;
    } catch (e) {
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
    notifyListeners();
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
    _verifyingPassengers.clear();
    _passengerErrors.clear();
    _idempotencyKeys.clear();
    _generalError = null;
    _generalSuccess = null;
    _currentTripId = null;
    notifyListeners();
  }
}
