import '../models/accept_offer_response.dart';
import '../models/driver_dispatch_offer.dart';
import '../models/driver_onboarding_request.dart';
import '../models/driver_status_response.dart';
import '../models/driver_vehicle.dart';

/// Contract for driver domain operations, onboarding, and profile registration.
abstract interface class DriverRepository {
  /// Submits candidate driver registration and primary vehicle details.
  Future<DriverOnboardingResponse> onboardDriver(
    DriverOnboardingRequest request,
  );

  /// Fetches operational status for an approved driver (`GET /api/v1/drivers/status`).
  Future<DriverStatusResponse> getDriverStatus();

  /// Updates driver operational status / online availability (`PATCH /api/v1/drivers/status`).
  Future<DriverStatusResponse> updateStatus({required bool isOnline});

  /// Reports driver foreground GPS fix to Redis cache (`POST /api/v1/drivers/location`).
  Future<void> reportLocation({
    required double latitude,
    required double longitude,
    double? heading,
    double? speed,
  });

  /// Fetches pending dispatch offers for the authenticated driver (`GET /api/v1/drivers/offers/pending`).
  Future<List<DriverDispatchOffer>> getPendingOffers();

  /// Accepts a dispatch offer (`POST /api/v1/drivers/offers/:id/accept`).
  Future<AcceptOfferResponse> acceptOffer({
    required String offerId,
    required String idempotencyKey,
  });

  /// Explicitly rejects a dispatch offer (`POST /api/v1/drivers/offers/:id/reject`).
  Future<void> rejectOffer({
    required String offerId,
    required String idempotencyKey,
    String? reason,
  });

  /// Fetches registered vehicles for the authenticated driver (`GET /api/v1/drivers/vehicles`).
  Future<List<DriverVehicle>> getVehicles();
}
