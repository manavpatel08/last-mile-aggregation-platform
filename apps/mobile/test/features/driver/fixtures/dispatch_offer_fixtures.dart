import 'package:lastmile_mobile/features/driver/presentation/models/dispatch_offer_item.dart';

/// Test-only fixtures for testing dispatch offer presentation components.
///
/// STRICT GOVERNANCE RULE:
/// These fixtures are strictly confined to tests and must never enter
/// production dependency injection or production screens.
abstract final class DispatchOfferFixtures {
  static const sampleOffer1 = DispatchOfferItem(
    id: 'grp-test-001',
    pickupLocationName: 'PDEU High-Rise Gate',
    dropoffLocationName: 'Infocity Circle Corridor',
    passengerCount: 3,
    estimatedEarnings: '₹48.00',
    estimatedDistance: '2.4 km',
    detourPercentage: 8,
    status: DispatchOfferStatus.pending,
  );

  static const sampleOffer2 = DispatchOfferItem(
    id: 'grp-test-002',
    pickupLocationName: 'PDEU Gate 1 (Koba Highway)',
    dropoffLocationName: 'Sector 7 Bus Depot',
    passengerCount: 2,
    estimatedEarnings: '₹32.00',
    estimatedDistance: '1.8 km',
    detourPercentage: 0,
    status: DispatchOfferStatus.pending,
  );

  static const sampleOffer3 = DispatchOfferItem(
    id: 'grp-test-003',
    pickupLocationName: 'PDEU Hostel Block C',
    dropoffLocationName: 'Kudasan Crossroad',
    passengerCount: 4,
    estimatedEarnings: '₹64.00',
    estimatedDistance: '3.1 km',
    detourPercentage: 15,
    status: DispatchOfferStatus.pending,
  );

  static const expiredOffer = DispatchOfferItem(
    id: 'grp-test-expired',
    pickupLocationName: 'PDEU Main Quadrangle',
    dropoffLocationName: 'Sector 21 Market',
    passengerCount: 2,
    estimatedEarnings: '₹30.00',
    estimatedDistance: '1.5 km',
    detourPercentage: 5,
    status: DispatchOfferStatus.expired,
  );

  static const acceptingOffer = DispatchOfferItem(
    id: 'grp-test-accepting',
    pickupLocationName: 'PDEU Knowledge Corridor',
    dropoffLocationName: 'Bhaijipura Circle',
    passengerCount: 3,
    estimatedEarnings: '₹45.00',
    estimatedDistance: '2.0 km',
    detourPercentage: 10,
    status: DispatchOfferStatus.accepting,
  );

  static const decliningOffer = DispatchOfferItem(
    id: 'grp-test-declining',
    pickupLocationName: 'PDEU Innovation Center',
    dropoffLocationName: 'Sargasan Crossroad',
    passengerCount: 1,
    estimatedEarnings: '₹25.00',
    estimatedDistance: '1.2 km',
    detourPercentage: 0,
    status: DispatchOfferStatus.declining,
  );
}
