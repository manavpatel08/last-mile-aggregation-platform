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

  /// Fetches registered vehicles for the authenticated driver (`GET /api/v1/drivers/vehicles`).
  Future<List<DriverVehicle>> getVehicles();
}
