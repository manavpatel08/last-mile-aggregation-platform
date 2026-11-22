import 'package:flutter/foundation.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/realtime/models/realtime_event.dart';
import '../../booking/data/booking_repository.dart';
import '../data/trip_repository.dart';
import '../models/passenger_boarding_pass.dart';

/// State management provider for the passenger active trip and boarding pass screen.
class PassengerActiveTripProvider extends ChangeNotifier {
  PassengerActiveTripProvider({
    TripRepository? repository,
    BookingRepository? bookingRepository,
  }) {
    _repository = repository;
    _bookingRepository = bookingRepository;
  }

  TripRepository? _repository;
  BookingRepository? _bookingRepository;
  PassengerBoardingPass? _boardingPass;
  DriverLocationBroadcastData? _driverLocation;
  bool _isLoading = false;
  String? _errorMessage;
  String? _currentBookingId;
  bool _isPaymentConfirmed = false;
  Map<String, dynamic>? _lastPaymentReceipt;

  PassengerBoardingPass? get boardingPass => _boardingPass;
  DriverLocationBroadcastData? get driverLocation => _driverLocation;
  bool get isLoading => _isLoading;
  String? get errorMessage => _errorMessage;
  String? get currentBookingId => _currentBookingId;
  bool get isPaymentConfirmed => _isPaymentConfirmed;
  Map<String, dynamic>? get lastPaymentReceipt => _lastPaymentReceipt;

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

  /// Sets or updates the active repository instances.
  void setRepositories({
    TripRepository? repository,
    BookingRepository? bookingRepository,
  }) {
    if (repository != null) _repository = repository;
    if (bookingRepository != null) _bookingRepository = bookingRepository;
  }

  /// Loads the passenger boarding pass for the given booking ID.
  Future<void> loadBoardingPass(
    String bookingId, {
    TripRepository? repository,
    BookingRepository? bookingRepository,
  }) async {
    final repo = repository ?? _repository;
    final bookingRepo = bookingRepository ?? _bookingRepository;

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
      // If OTP has already been verified/consumed, recover authoritative booking status
      if (e.errorCode == 'OTP_ALREADY_CONSUMED' ||
          e.errorCode == 'OTP_ALREADY_VERIFIED') {
        if (bookingRepo != null) {
          try {
            final details = await bookingRepo.getBookingDetails(bookingId);
            if (_boardingPass != null) {
              _boardingPass = _boardingPass!.copyWith(
                bookingStatus: details.status,
              );
            } else {
              _boardingPass = PassengerBoardingPass(
                bookingId: bookingId,
                passengerId: details.passengerId ?? '',
                tripId: '',
                boardingOtp: '••••',
                expiresAt: DateTime.now().add(const Duration(hours: 1)),
                bookingStatus: details.status,
                driver: const BoardingPassDriver(name: 'Assigned Driver'),
              );
            }
            _errorMessage = null;
          } catch (_) {
            if (_boardingPass != null) {
              _errorMessage = null;
            } else {
              _errorMessage = e.message;
            }
          }
        } else if (_boardingPass != null) {
          // If bookingRepo not available but boarding pass was cached,
          // keep cached pass and clear error.
          _errorMessage = null;
        } else {
          _errorMessage = e.message;
        }
      } else {
        _errorMessage = e.message;
      }
    } catch (e) {
      _errorMessage = 'Unable to load boarding pass. Please check connection.';
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  /// Refreshes the currently loaded boarding pass.
  Future<void> refresh({
    TripRepository? repository,
    BookingRepository? bookingRepository,
  }) async {
    if (_currentBookingId != null) {
      await loadBoardingPass(
        _currentBookingId!,
        repository: repository,
        bookingRepository: bookingRepository,
      );
    }
  }

  /// Updates driver location telemetry received from `driver.location.updated`.
  void onDriverLocationUpdated(DriverLocationBroadcastData data) {
    _driverLocation = data;
    notifyListeners();
  }

  /// Handles `driver.arrived` event.
  void onDriverArrived() {
    if (_boardingPass != null) {
      _boardingPass = _boardingPass!.copyWith(bookingStatus: 'DRIVER_ARRIVED');
      notifyListeners();
    }
  }

  /// Handles `passenger.boarded` event.
  void onPassengerBoarded() {
    if (_boardingPass != null) {
      _boardingPass = _boardingPass!.copyWith(bookingStatus: 'BOARDED');
      notifyListeners();
    }
  }

  /// Handles `trip.status.updated` event.
  void onTripStatusUpdated(String status) {
    if (_boardingPass != null) {
      _boardingPass = _boardingPass!.copyWith(bookingStatus: status);
      notifyListeners();
    }
  }

  /// Handles `payment.confirmed` event.
  void onPaymentConfirmed(Map<String, dynamic> data) {
    _isPaymentConfirmed = true;
    _lastPaymentReceipt = data;
    notifyListeners();
  }

  /// Handles `trip.completed` event.
  void onTripCompleted() {
    if (_boardingPass != null) {
      _boardingPass = _boardingPass!.copyWith(bookingStatus: 'COMPLETED');
      notifyListeners();
    }
  }

  /// Handles `trip.cancelled` event.
  void onTripCancelled() {
    if (_boardingPass != null) {
      _boardingPass = _boardingPass!.copyWith(bookingStatus: 'CANCELLED');
      notifyListeners();
    }
  }

  /// Clears state when leaving the active trip screen.
  void clear() {
    _boardingPass = null;
    _driverLocation = null;
    _isPaymentConfirmed = false;
    _lastPaymentReceipt = null;
    _isLoading = false;
    _errorMessage = null;
    _currentBookingId = null;
    notifyListeners();
  }
}
