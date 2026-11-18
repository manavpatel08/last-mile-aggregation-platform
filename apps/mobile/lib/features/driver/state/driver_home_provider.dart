import 'package:flutter/foundation.dart';

/// Immutable descriptor for a placeholder section shown on the Driver Home screen.
class DriverPlaceholderItem {
  const DriverPlaceholderItem({
    required this.id,
    required this.title,
    required this.description,
  });

  final String id;
  final String title;
  final String description;
}

/// Feature-scoped Provider foundation for Driver Home presentation state.
///
/// Contains placeholder metadata only; driver onboarding, online availability,
/// dispatch offers, GPS streaming, and trip execution belong to later tasks.
class DriverHomeProvider extends ChangeNotifier {
  final List<DriverPlaceholderItem> _sections = const [
    DriverPlaceholderItem(
      id: 'onboarding',
      title: 'Driver Onboarding & Verification',
      description:
          'Document submission and administrator approval status will be integrated here.',
    ),
    DriverPlaceholderItem(
      id: 'dispatch',
      title: 'Dispatch Offers',
      description:
          'Sequential 1-to-1 ride group dispatch offers will appear here once dispatch APIs are connected.',
    ),
    DriverPlaceholderItem(
      id: 'active_trip',
      title: 'Active Trip & Passenger Manifest',
      description:
          'Pickup arrival, boarding verification, drop-off progression, and cash confirmation will appear here.',
    ),
  ];

  List<DriverPlaceholderItem> get sections => _sections;

  String get statusSummary =>
      'Driver application foundation is ready. Operational driver access is enforced by backend verification status.';
}
