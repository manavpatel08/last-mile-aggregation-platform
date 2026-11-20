import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../core/theme/app_colors.dart';
import '../../models/pickup_point.dart';
import '../../models/service_region.dart';

/// Interactive map allowing the passenger to visualize service boundaries,
/// pickup geofences, and select a ride destination by tapping or choosing a preset.
class DestinationMapPicker extends StatefulWidget {
  const DestinationMapPicker({
    super.key,
    required this.selectedPickupPoint,
    required this.serviceRegions,
    required this.passengerLocation,
    required this.selectedDestination,
    required this.onDestinationSelected,
    this.height = 320,
  });

  final PickupPoint? selectedPickupPoint;
  final List<ServiceRegion> serviceRegions;
  final LatLng? passengerLocation;
  final LatLng? selectedDestination;
  final ValueChanged<LatLng> onDestinationSelected;
  final double height;

  @override
  State<DestinationMapPicker> createState() => _DestinationMapPickerState();
}

class _DestinationMapPickerState extends State<DestinationMapPicker> {
  late final MapController _mapController;

  static const copyrightUrl = 'https://www.openstreetmap.org/copyright';
  static const _defaultCenter = LatLng(23.1550, 72.6668); // PDEU campus

  @override
  void initState() {
    super.initState();
    _mapController = MapController();
  }

  @override
  void dispose() {
    _mapController.dispose();
    super.dispose();
  }

  Future<void> _handleAttributionTap() async {
    final uri = Uri.parse(copyrightUrl);
    try {
      final success = await launchUrl(
        uri,
        mode: LaunchMode.externalApplication,
      );
      if (!success && mounted) {
        _showAttributionError();
      }
    } catch (_) {
      if (mounted) {
        _showAttributionError();
      }
    }
  }

  void _showAttributionError() {
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.hideCurrentSnackBar();
    messenger?.showSnackBar(
      const SnackBar(
        key: Key('osm_attribution_error_snackbar'),
        content: Text('Unable to open OpenStreetMap copyright page.'),
        duration: Duration(seconds: 4),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final pickup = widget.selectedPickupPoint;
    final initialCenter = pickup != null
        ? LatLng(pickup.latitude, pickup.longitude)
        : (widget.passengerLocation ?? _defaultCenter);

    // Build service region polygon
    final polygons = <Polygon>[];
    for (final region in widget.serviceRegions) {
      final points = region.polygonCoordinates;
      if (points.isNotEmpty) {
        polygons.add(
          Polygon(
            points: points,
            color: AppColors.primary.withValues(alpha: 0.08),
            borderColor: AppColors.primary,
            borderStrokeWidth: 2,
          ),
        );
      }
    }

    // Build pickup 150m geofence circle
    final circles = <CircleMarker>[];
    if (pickup != null) {
      circles.add(
        CircleMarker(
          point: LatLng(pickup.latitude, pickup.longitude),
          radius: pickup.radiusMeters,
          useRadiusInMeter: true,
          color: AppColors.success.withValues(alpha: 0.15),
          borderColor: AppColors.success,
          borderStrokeWidth: 2,
        ),
      );
    }

    // Build markers: Pickup, Passenger Location, Destination
    final markers = <Marker>[];

    if (pickup != null) {
      markers.add(
        Marker(
          point: LatLng(pickup.latitude, pickup.longitude),
          width: 40,
          height: 40,
          child: Tooltip(
            message: pickup.name,
            child: Container(
              decoration: const BoxDecoration(
                color: AppColors.success,
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.hub_outlined,
                color: Colors.white,
                size: 22,
              ),
            ),
          ),
        ),
      );
    }

    if (widget.passengerLocation != null) {
      markers.add(
        Marker(
          point: widget.passengerLocation!,
          width: 32,
          height: 32,
          child: const Tooltip(
            message: 'Your Location',
            child: Icon(
              Icons.my_location,
              color: AppColors.secondary,
              size: 26,
            ),
          ),
        ),
      );
    }

    if (widget.selectedDestination != null) {
      markers.add(
        Marker(
          point: widget.selectedDestination!,
          width: 44,
          height: 44,
          child: const Tooltip(
            message: 'Destination',
            child: Icon(
              Icons.location_on,
              color: AppColors.error,
              size: 40,
            ),
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: Container(
            height: widget.height,
            decoration: BoxDecoration(
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Stack(
              children: [
                FlutterMap(
                  mapController: _mapController,
                  options: MapOptions(
                    initialCenter: initialCenter,
                    initialZoom: 13.5,
                    onTap: (tapPosition, point) {
                      widget.onDestinationSelected(point);
                    },
                  ),
                  children: [
                    TileLayer(
                      urlTemplate:
                          'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                      userAgentPackageName: 'lastmile_mobile',
                    ),
                    if (polygons.isNotEmpty) PolygonLayer(polygons: polygons),
                    if (circles.isNotEmpty) CircleLayer(circles: circles),
                    if (markers.isNotEmpty) MarkerLayer(markers: markers),
                  ],
                ),
                Positioned(
                  top: 10,
                  right: 10,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.9),
                      borderRadius: BorderRadius.circular(20),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.1),
                          blurRadius: 4,
                        ),
                      ],
                    ),
                    child: const Text(
                      'Tap map to set destination',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: AppColors.textPrimary,
                      ),
                    ),
                  ),
                ),
                Positioned(
                  bottom: 8,
                  right: 8,
                  child: Container(
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.85),
                      borderRadius: BorderRadius.circular(4),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.1),
                          blurRadius: 2,
                        ),
                      ],
                    ),
                    child: Material(
                      color: Colors.transparent,
                      child: InkWell(
                        key: const Key('osm_attribution'),
                        borderRadius: BorderRadius.circular(4),
                        onTap: _handleAttributionTap,
                        child: const Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 3,
                          ),
                          child: Text(
                            '© OpenStreetMap contributors',
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w500,
                              color: AppColors.textSecondary,
                              decoration: TextDecoration.underline,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            ActionChip(
              avatar: const Icon(Icons.place_outlined, size: 16),
              label: const Text('Infocity (23.188, 72.628)'),
              onPressed: () {
                final target = const LatLng(23.1885, 72.6288);
                widget.onDestinationSelected(target);
                _mapController.move(target, 14.0);
              },
            ),
            ActionChip(
              avatar: const Icon(Icons.place_outlined, size: 16),
              label: const Text('CH Road (23.215, 72.636)'),
              onPressed: () {
                final target = const LatLng(23.2156, 72.6369);
                widget.onDestinationSelected(target);
                _mapController.move(target, 14.0);
              },
            ),
            ActionChip(
              avatar: const Icon(Icons.place_outlined, size: 16),
              label: const Text('Bhaijipura (23.162, 72.655)'),
              onPressed: () {
                final target = const LatLng(23.1620, 72.6550);
                widget.onDestinationSelected(target);
                _mapController.move(target, 14.0);
              },
            ),
          ],
        ),
      ],
    );
  }
}
