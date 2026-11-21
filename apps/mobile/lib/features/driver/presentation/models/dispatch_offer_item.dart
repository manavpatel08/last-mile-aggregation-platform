/// Presentation-only models and status enums for driver dispatch offers.
///
/// Designed to be decoupled from backend DTOs to support Phase 1 UI-first development
/// and testing before Stage 6 dispatch engine integration.
library;

/// Presentation status of an individual dispatch offer.
enum DispatchOfferStatus {
  /// Offer is pending driver review.
  pending,

  /// Offer expired.
  expired,

  /// Driver tapped accept; atomic reservation transaction in progress.
  accepting,

  /// Driver tapped decline; rejection recording and cascade in progress.
  declining,
}

/// Presentation state for the driver dispatch offers inbox.
enum DispatchInboxState {
  /// Production Phase 1 state: backend dispatch engine (Stage 6) is not yet integrated.
  disconnected,

  /// Actively loading or polling for active offers.
  loading,

  /// Authoritative empty response from backend: no pending offers available.
  empty,

  /// Network, authorization, or server failure retrieving offers.
  error,

  /// One or more active dispatch offers are available for review.
  ready,
}

/// Immutable presentation model representing a single dispatch offer.
class DispatchOfferItem {
  const DispatchOfferItem({
    required this.id,
    required this.pickupLocationName,
    required this.dropoffLocationName,
    required this.passengerCount,
    required this.estimatedEarnings,
    this.estimatedDistance,
    this.detourPercentage,
    this.status = DispatchOfferStatus.pending,
  });

  /// Unique offer or group identifier.
  final String id;

  /// User-friendly name of the group pickup point (e.g. "PDEU High-Rise Gate").
  final String pickupLocationName;

  /// User-friendly name of the group destination / drop-off corridor.
  final String dropoffLocationName;

  /// Total number of passengers grouped for this ride.
  final int passengerCount;

  /// Formatted estimated earnings for the driver (e.g. "₹45.00").
  final String estimatedEarnings;

  /// Estimated travel distance formatted with units (e.g. "2.4 km").
  final String? estimatedDistance;

  /// Detour percentage incurred for pickup (e.g. 8 for 8%).
  final int? detourPercentage;

  /// Current presentation status of this offer.
  final DispatchOfferStatus status;

  /// Whether this offer has expired based purely on status.
  bool get isExpired => status == DispatchOfferStatus.expired;

  /// Whether an accept or decline action is currently in flight for this offer.
  bool get isActionPending =>
      status == DispatchOfferStatus.accepting ||
      status == DispatchOfferStatus.declining;
}
