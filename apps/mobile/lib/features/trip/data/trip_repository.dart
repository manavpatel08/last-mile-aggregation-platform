import '../models/passenger_boarding_pass.dart';
import '../models/trip_detail_model.dart';

/// Abstract contract for trip operations, passenger boarding pass retrieval,
/// driver arrival reporting, and boarding OTP verification.
abstract class TripRepository {
  /// Retrieves the passenger boarding pass with 4-digit OTP and assigned driver info.
  Future<PassengerBoardingPass> getPassengerBoardingPass(String bookingId);

  /// Retrieves trip manifest and all passenger journey states.
  Future<TripDetailModel> getTripDetails(String tripId);

  /// Reports driver arrival at the pickup hub.
  Future<ArrivePickupResponse> arriveAtPickup({
    required String tripId,
    required String idempotencyKey,
  });

  /// Verifies a passenger's 4-digit boarding OTP.
  Future<VerifyBoardingResponse> verifyBoarding({
    required String tripId,
    required String passengerId,
    required String otp,
    required String idempotencyKey,
  });

  /// Starts the vehicle trip after passengers are boarded (`POST /api/v1/trips/:id/start`).
  Future<StartTripResponse> startTrip({
    required String tripId,
    required String idempotencyKey,
  });

  /// Completes an individual passenger drop-off (`POST /api/v1/trips/:id/passengers/:passengerId/complete`).
  Future<CompletePassengerResponse> completePassengerDropOff({
    required String tripId,
    required String passengerId,
    required String idempotencyKey,
  });

  /// Finalizes the overall vehicle trip after all drop-offs (`POST /api/v1/trips/:id/complete`).
  Future<CompleteTripResponse> completeTrip({
    required String tripId,
    required String idempotencyKey,
  });
}
