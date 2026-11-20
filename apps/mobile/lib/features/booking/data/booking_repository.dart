import '../models/booking_request.dart';
import '../models/booking_response.dart';
import '../models/fare_quote.dart';
import '../models/location_validation.dart';
import '../models/pickup_point.dart';
import '../models/service_region.dart';

/// Repository interface for passenger ride booking and location services.
abstract class BookingRepository {
  /// Fetches transit pickup hubs (e.g. PDEU Main Gate).
  Future<List<PickupPoint>> getPickupZones();

  /// Fetches active service region boundaries.
  Future<List<ServiceRegion>> getServiceRegions();

  /// Validates whether destination coordinates are inside the service area.
  Future<DestinationValidationResult> validateDestination({
    required double latitude,
    required double longitude,
  });

  /// Validates whether passenger coordinates are within the 150m pickup geofence.
  Future<PickupValidationResult> validatePickup({
    required String pickupPointId,
    required double latitude,
    required double longitude,
  });

  /// Generates a binding 2-minute fare quote.
  Future<FareQuote> generateFareQuote({
    required String pickupPointId,
    required double destinationLatitude,
    required double destinationLongitude,
  });

  /// Submits an idempotent ride booking request.
  Future<BookingResponse> createBooking({
    required BookingRequest request,
    required String idempotencyKey,
  });

  /// Retrieves the current active booking for the authenticated passenger, if any.
  Future<BookingResponse?> getActiveBooking();
}
