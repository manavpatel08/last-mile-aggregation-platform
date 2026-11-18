import 'package:flutter/foundation.dart';

/// Immutable descriptor for a placeholder section shown on the Passenger Home screen.
class PassengerPlaceholderItem {
  const PassengerPlaceholderItem({
    required this.id,
    required this.title,
    required this.description,
  });

  final String id;
  final String title;
  final String description;
}

/// Feature-scoped Provider foundation for Passenger Home presentation state.
///
/// Contains placeholder metadata only; booking, fare quotes, maps, and live
/// tracking belong to subsequent implementation tasks.
class PassengerHomeProvider extends ChangeNotifier {
  final List<PassengerPlaceholderItem> _sections = const [
    PassengerPlaceholderItem(
      id: 'booking',
      title: 'Ride Booking',
      description:
          'Shared and private ride booking flows will be added in a subsequent task.',
    ),
    PassengerPlaceholderItem(
      id: 'active_ride',
      title: 'Active Ride Status',
      description:
          'Matching progress, boarding verification, and live trip status will appear here.',
    ),
    PassengerPlaceholderItem(
      id: 'history',
      title: 'Ride History & Receipts',
      description:
          'Completed ride summaries and cash settlement records will be integrated here.',
    ),
  ];

  List<PassengerPlaceholderItem> get sections => _sections;

  String get statusSummary =>
      'Passenger application foundation is ready. Live booking and backend integration are pending future stages.';
}
