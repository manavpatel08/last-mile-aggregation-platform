import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/core/theme/app_theme.dart';
import 'package:lastmile_mobile/features/driver/presentation/models/dispatch_offer_item.dart';
import 'package:lastmile_mobile/features/driver/presentation/widgets/dispatch_offer_card.dart';

import '../../fixtures/dispatch_offer_fixtures.dart';

void main() {
  Widget buildTestWidget({
    required DispatchOfferItem offer,
    ValueChanged<String>? onAccept,
    ValueChanged<String>? onReject,
  }) {
    return MaterialApp(
      theme: AppTheme.lightTheme,
      home: Scaffold(
        body: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: DispatchOfferCard(
              offer: offer,
              onAccept: onAccept,
              onReject: onReject,
            ),
          ),
        ),
      ),
    );
  }

  group('DispatchOfferCard Widget Tests', () {
    testWidgets('renders all details for a single active offer with simple Pending status', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(offer: DispatchOfferFixtures.sampleOffer1),
      );

      expect(find.byKey(const Key('dispatch_offer_card_grp-test-001')), findsOneWidget);
      expect(find.text('Ride Group #grp-test-001'), findsOneWidget);
      expect(find.text('PDEU High-Rise Gate'), findsOneWidget);
      expect(find.text('Infocity Circle Corridor'), findsOneWidget);
      expect(find.text('3 riders'), findsOneWidget);
      expect(find.text('2.4 km'), findsOneWidget);
      expect(find.text('+8% detour'), findsOneWidget);
      expect(find.text('₹48.00'), findsOneWidget);

      // Verify simple Pending presentation badge with no assumed countdown or remaining-time string
      expect(find.text('Pending'), findsOneWidget);
      expect(find.textContaining('left'), findsNothing);

      final acceptBtn = find.byKey(const Key('dispatch_offer_accept_button_grp-test-001'));
      final rejectBtn = find.byKey(const Key('dispatch_offer_reject_button_grp-test-001'));
      expect(acceptBtn, findsOneWidget);
      expect(rejectBtn, findsOneWidget);
    });

    testWidgets('renders expired state and disables action buttons', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(offer: DispatchOfferFixtures.expiredOffer),
      );

      final statusFinder = find.byKey(const Key('dispatch_offer_status_grp-test-expired'));
      expect(statusFinder, findsOneWidget);
      expect(find.descendant(of: statusFinder, matching: find.text('Expired')), findsOneWidget);

      final acceptBtn = tester.widget<FilledButton>(
        find.byKey(const Key('dispatch_offer_accept_button_grp-test-expired')),
      );
      final rejectBtn = tester.widget<OutlinedButton>(
        find.byKey(const Key('dispatch_offer_reject_button_grp-test-expired')),
      );

      expect(acceptBtn.onPressed, isNull);
      expect(rejectBtn.onPressed, isNull);
    });

    testWidgets('renders accepting pending-action state with loading spinner', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(offer: DispatchOfferFixtures.acceptingOffer),
      );

      final statusFinder = find.byKey(const Key('dispatch_offer_status_grp-test-accepting'));
      expect(statusFinder, findsOneWidget);
      expect(find.descendant(of: statusFinder, matching: find.text('Accepting...')), findsOneWidget);

      final acceptBtn = tester.widget<FilledButton>(
        find.byKey(const Key('dispatch_offer_accept_button_grp-test-accepting')),
      );
      final rejectBtn = tester.widget<OutlinedButton>(
        find.byKey(const Key('dispatch_offer_reject_button_grp-test-accepting')),
      );

      expect(acceptBtn.onPressed, isNull);
      expect(rejectBtn.onPressed, isNull);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('renders declining pending-action state with loading spinner', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(offer: DispatchOfferFixtures.decliningOffer),
      );

      final statusFinder = find.byKey(const Key('dispatch_offer_status_grp-test-declining'));
      expect(statusFinder, findsOneWidget);
      expect(find.descendant(of: statusFinder, matching: find.text('Declining...')), findsOneWidget);

      final acceptBtn = tester.widget<FilledButton>(
        find.byKey(const Key('dispatch_offer_accept_button_grp-test-declining')),
      );
      final rejectBtn = tester.widget<OutlinedButton>(
        find.byKey(const Key('dispatch_offer_reject_button_grp-test-declining')),
      );

      expect(acceptBtn.onPressed, isNull);
      expect(rejectBtn.onPressed, isNull);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('invokes onAccept callback when Accept button is tapped', (tester) async {
      String? acceptedId;
      await tester.pumpWidget(
        buildTestWidget(
          offer: DispatchOfferFixtures.sampleOffer1,
          onAccept: (id) => acceptedId = id,
          onReject: (_) {},
        ),
      );

      final acceptBtn = find.byKey(const Key('dispatch_offer_accept_button_grp-test-001'));
      await tester.tap(acceptBtn);
      await tester.pump();

      expect(acceptedId, 'grp-test-001');
    });

    testWidgets('invokes onReject callback when Decline button is tapped', (tester) async {
      String? rejectedId;
      await tester.pumpWidget(
        buildTestWidget(
          offer: DispatchOfferFixtures.sampleOffer2,
          onAccept: (_) {},
          onReject: (id) => rejectedId = id,
        ),
      );

      final rejectBtn = find.byKey(const Key('dispatch_offer_reject_button_grp-test-002'));
      await tester.tap(rejectBtn);
      await tester.pump();

      expect(rejectedId, 'grp-test-002');
    });

    testWidgets('disables action buttons when callbacks are null', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(
          offer: DispatchOfferFixtures.sampleOffer1,
          onAccept: null,
          onReject: null,
        ),
      );

      final acceptBtn = tester.widget<FilledButton>(
        find.byKey(const Key('dispatch_offer_accept_button_grp-test-001')),
      );
      final rejectBtn = tester.widget<OutlinedButton>(
        find.byKey(const Key('dispatch_offer_reject_button_grp-test-001')),
      );

      expect(acceptBtn.onPressed, isNull);
      expect(rejectBtn.onPressed, isNull);
    });

    testWidgets('renders cleanly when optional fields are null', (tester) async {
      const minimalOffer = DispatchOfferItem(
        id: 'grp-minimal-001',
        pickupLocationName: 'Gate A',
        dropoffLocationName: 'Gate B',
        passengerCount: 2,
        estimatedEarnings: '₹20.00',
      );

      await tester.pumpWidget(buildTestWidget(offer: minimalOffer));

      expect(find.text('Ride Group #grp-minimal-001'), findsOneWidget);
      expect(find.text('Pending'), findsOneWidget);
      expect(find.text('2 riders'), findsOneWidget);
      expect(find.text('₹20.00'), findsOneWidget);
      expect(find.textContaining('km'), findsNothing);
      expect(find.textContaining('detour'), findsNothing);
    });
  });
}
