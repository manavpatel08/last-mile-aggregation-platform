import 'package:flutter/foundation.dart';

import '../../../core/network/api_exception.dart';
import '../data/trip_repository.dart';
import '../models/passenger_boarding_pass.dart';

/// State management provider for the passenger active trip and boarding pass screen.
class PassengerActiveTripProvider extends ChangeNotifier {
  PassengerActiveTripProvider({TripRepository? repository}) {
    _repository = repository;
  }

  TripRepository? _repository;
  PassengerBoardingPass? _boardingPass;
  bool _isLoading = false;
  String? _errorMessage;
  String? _currentBookingId;

  PassengerBoardingPass? get boardingPass => _boardingPass;
  bool get isLoading => _isLoading;
  String? get errorMessage => _errorMessage;
  String? get currentBookingId => _currentBookingId;

  bool get hasBoardingPass => _boardingPass != null;
  bool get isDriverArrived => _boardingPass?.isDriverArrived ?? false;
  bool get isBoarded => _boardingPass?.isBoarded ?? false;
  bool get isExpired => _boardingPass?.isExpired ?? false;

  /// Formatted 4-digit OTP with spaces for clean display (e.g., "4 8 2 1").
  String get formattedOtp {
    final raw = _boardingPass?.boardingOtp ?? '';
    if (raw.length == 4) {
      return '${raw[0]}  ${raw[1]}  ${raw[2]}  ${raw[3]}';
    }
    return raw;
  }

  /// Sets or updates the active repository instance.
  void setRepository(TripRepository repository) {
    _repository = repository;
  }

  /// Loads the passenger boarding pass for the given booking ID.
  Future<void> loadBoardingPass(
    String bookingId, {
    TripRepository? repository,
  }) async {
    final repo = repository ?? _repository;
    if (repo == null) {
      _errorMessage = 'Trip repository is not initialized.';
      notifyListeners();
      return;
    }

    _currentBookingId = bookingId;
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();

    try {
      final pass = await repo.getPassengerBoardingPass(bookingId);
      _boardingPass = pass;
      _errorMessage = null;
    } on ApiException catch (e) {
      _errorMessage = e.message;
    } catch (e) {
      _errorMessage = 'Unable to load boarding pass. Please check connection.';
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  /// Refreshes the currently loaded boarding pass.
  Future<void> refresh({TripRepository? repository}) async {
    if (_currentBookingId != null) {
      await loadBoardingPass(_currentBookingId!, repository: repository);
    }
  }

  /// Clears state when leaving the active trip screen.
  void clear() {
    _boardingPass = null;
    _isLoading = false;
    _errorMessage = null;
    _currentBookingId = null;
    notifyListeners();
  }
}
