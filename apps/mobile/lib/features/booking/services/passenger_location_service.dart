import 'package:geolocator/geolocator.dart';

/// Structured result of a location query.
class LocationResult {
  const LocationResult.success({
    required this.latitude,
    required this.longitude,
  })  : isSuccess = true,
        errorMessage = null,
        isPermissionDenied = false,
        isLocationServiceDisabled = false;

  const LocationResult.failure(
    this.errorMessage, {
    this.isPermissionDenied = false,
    this.isLocationServiceDisabled = false,
  })  : isSuccess = false,
        latitude = null,
        longitude = null;

  final bool isSuccess;
  final double? latitude;
  final double? longitude;
  final String? errorMessage;
  final bool isPermissionDenied;
  final bool isLocationServiceDisabled;
}

/// Abstract contract for obtaining passenger device coordinates.
abstract class PassengerLocationService {
  Future<LocationResult> getCurrentLocation();
}

/// Production implementation of [PassengerLocationService] utilizing [Geolocator].
class GeolocatorPassengerLocationService implements PassengerLocationService {
  const GeolocatorPassengerLocationService();

  @override
  Future<LocationResult> getCurrentLocation() async {
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        return const LocationResult.failure(
          'Location services are disabled on your device. Please enable location services in Settings.',
          isLocationServiceDisabled: true,
        );
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied) {
          return const LocationResult.failure(
            'Location permission was denied. Please grant location access to verify pickup zone proximity.',
            isPermissionDenied: true,
          );
        }
      }

      if (permission == LocationPermission.deniedForever) {
        return const LocationResult.failure(
          'Location permissions are permanently denied. Please enable them in your device settings.',
          isPermissionDenied: true,
        );
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );

      return LocationResult.success(
        latitude: position.latitude,
        longitude: position.longitude,
      );
    } catch (e) {
      return LocationResult.failure(
        'Unable to acquire device location: ${e.toString()}',
      );
    }
  }
}

/// Test/mock implementation of [PassengerLocationService].
class FakePassengerLocationService implements PassengerLocationService {
  FakePassengerLocationService({
    this.initialResult = const LocationResult.success(
      latitude: 23.1550,
      longitude: 72.6668,
    ),
  });

  LocationResult initialResult;

  @override
  Future<LocationResult> getCurrentLocation() async => initialResult;
}
