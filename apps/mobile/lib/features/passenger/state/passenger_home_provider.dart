import 'package:flutter/foundation.dart';

import '../../booking/data/booking_repository.dart';
import '../../booking/models/booking_response.dart';

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
class PassengerHomeProvider extends ChangeNotifier {
  final List<PassengerPlaceholderItem> _sections = const [
    PassengerPlaceholderItem(
      id: 'active_ride',
      title: 'Active Ride Tracking',
      description:
          'Driver assignment, boarding confirmation, and live GPS streaming will appear here.',
    ),
    PassengerPlaceholderItem(
      id: 'history',
      title: 'Ride History & Receipts',
      description:
          'Completed ride summaries and cash settlement records will be integrated here.',
    ),
  ];

  List<PassengerPlaceholderItem> get sections => _sections;

  BookingResponse? _activeBooking;
  bool _isLoadingActiveBooking = false;
  String? _activeBookingError;

  BookingResponse? get activeBooking => _activeBooking;
  bool get isLoadingActiveBooking => _isLoadingActiveBooking;
  String? get activeBookingError => _activeBookingError;

  String get statusSummary => _activeBooking != null
      ? 'Active booking in progress (${_activeBooking!.status}). Ceiling: ₹${_activeBooking!.agreedFareCeiling}'
      : 'PDEU campus last-mile connectivity is active. Request a ride anytime.';

  void updateActiveBooking(BookingResponse? booking) {
    _activeBooking = booking;
    notifyListeners();
  }

  Future<void> loadActiveBooking(BookingRepository bookingRepository) async {
    _isLoadingActiveBooking = true;
    _activeBookingError = null;
    notifyListeners();

    try {
      final booking = await bookingRepository.getActiveBooking();
      _activeBooking = booking;
    } catch (e) {
      _activeBookingError = e.toString();
    } finally {
      _isLoadingActiveBooking = false;
      notifyListeners();
    }
  }
}
