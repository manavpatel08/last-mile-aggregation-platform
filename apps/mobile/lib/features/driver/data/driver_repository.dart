import '../models/driver_onboarding_request.dart';

/// Contract for driver domain operations, onboarding, and profile registration.
abstract interface class DriverRepository {
  /// Submits candidate driver registration and primary vehicle details.
  Future<DriverOnboardingResponse> onboardDriver(
    DriverOnboardingRequest request,
  );
}
