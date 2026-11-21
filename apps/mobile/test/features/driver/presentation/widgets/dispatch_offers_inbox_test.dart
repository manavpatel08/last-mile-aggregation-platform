import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/core/theme/app_theme.dart';
import 'package:lastmile_mobile/features/driver/presentation/models/dispatch_offer_item.dart';
import 'package:lastmile_mobile/features/driver/presentation/widgets/dispatch_offers_inbox.dart';

import '../../fixtures/dispatch_offer_fixtures.dart';

void main() {
  Widget buildTestWidget({
    DispatchInboxState state = DispatchInboxState.disconnected,
    List<DispatchOfferItem> offers = const [],
    String? errorMessage,
    VoidCallback? onRetry,
    ValueChanged<String>? onAcceptOffer,
    ValueChanged<String>? onRejectOffer,
  }) {
    return MaterialApp(
      theme: AppTheme.lightTheme,
      home: Scaffold(
        body: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: DispatchOffersInbox(
              state: state,
              offers: offers,
              errorMessage: errorMessage,
              onRetry: onRetry,
              onAcceptOffer: onAcceptOffer,
              onRejectOffer: onRejectOffer,
            ),
          ),
        ),
      ),
    );
  }

  group('DispatchOffersInbox Widget Tests', () {
    testWidgets('renders disconnected state with Not Connected badge and clear notice', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(state: DispatchInboxState.disconnected),
      );

      expect(find.text('Dispatch Offers'), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_disconnected_card')), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_disconnected_badge')), findsOneWidget);
      expect(find.text('Not Connected'), findsOneWidget);
      expect(find.text('Dispatch Offers Not Connected'), findsOneWidget);
      expect(
        find.textContaining('Real-time dispatch offers will appear here once the backend dispatch engine (Stage 6) is connected'),
        findsOneWidget,
      );
      expect(find.byIcon(Icons.cloud_off_outlined), findsOneWidget);

      // Verify no fabricated count like "0 active" or "active" is displayed in disconnected state
      expect(find.textContaining('active'), findsNothing);
      expect(find.byKey(const Key('driver_offers_count_badge')), findsNothing);

      // Verify no fake offers, countdowns, or accept/decline buttons
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.textContaining('Accept'), findsNothing);
      expect(find.textContaining('Decline'), findsNothing);
    });

    testWidgets('renders loading state with progress indicator', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(state: DispatchInboxState.loading),
      );

      expect(find.text('Dispatch Offers'), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_loading_card')), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_loading_text')), findsOneWidget);
      expect(find.text('Checking for dispatch offers...'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('renders neutral empty state with No Pending Offers message', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(state: DispatchInboxState.empty),
      );

      expect(find.text('Dispatch Offers'), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_empty_card')), findsOneWidget);
      expect(find.text('No Pending Offers'), findsOneWidget);
      expect(find.text('No pending offers right now.'), findsOneWidget);
      expect(find.byIcon(Icons.inbox_outlined), findsOneWidget);

      // Ensure no claims about matching routes or online state
      expect(find.textContaining('matched'), findsNothing);
      expect(find.textContaining('route'), findsNothing);
    });

    testWidgets('renders error state with message and triggers retry on button tap', (tester) async {
      var retryCalled = false;
      await tester.pumpWidget(
        buildTestWidget(
          state: DispatchInboxState.error,
          errorMessage: 'Connection timed out while polling dispatch offers.',
          onRetry: () => retryCalled = true,
        ),
      );

      expect(find.byKey(const Key('driver_offers_error_card')), findsOneWidget);
      expect(find.text('Failed to load dispatch offers'), findsOneWidget);
      expect(find.text('Connection timed out while polling dispatch offers.'), findsOneWidget);

      final retryBtn = find.byKey(const Key('driver_offers_retry_button'));
      expect(retryBtn, findsOneWidget);

      await tester.tap(retryBtn);
      await tester.pump();

      expect(retryCalled, isTrue);
    });

    testWidgets('renders multiple offer cards in ready state with active count badge', (tester) async {
      final offers = [
        DispatchOfferFixtures.sampleOffer1,
        DispatchOfferFixtures.sampleOffer2,
        DispatchOfferFixtures.sampleOffer3,
      ];

      await tester.pumpWidget(
        buildTestWidget(
          state: DispatchInboxState.ready,
          offers: offers,
        ),
      );

      expect(find.byKey(const Key('driver_offers_count_badge')), findsOneWidget);
      expect(find.text('3 active'), findsOneWidget);
      expect(find.byKey(const Key('driver_offers_list')), findsOneWidget);

      expect(find.byKey(const Key('dispatch_offer_card_grp-test-001')), findsOneWidget);
      expect(find.byKey(const Key('dispatch_offer_card_grp-test-002')), findsOneWidget);
      expect(find.byKey(const Key('dispatch_offer_card_grp-test-003')), findsOneWidget);

      expect(find.text('PDEU High-Rise Gate'), findsOneWidget);
      expect(find.text('PDEU Gate 1 (Koba Highway)'), findsOneWidget);
      expect(find.text('PDEU Hostel Block C'), findsOneWidget);
    });

    testWidgets('falls back to neutral empty state when ready state has an empty list', (tester) async {
      await tester.pumpWidget(
        buildTestWidget(
          state: DispatchInboxState.ready,
          offers: const [],
        ),
      );

      expect(find.byKey(const Key('driver_offers_empty_card')), findsOneWidget);
      expect(find.text('No Pending Offers'), findsOneWidget);
      expect(find.text('No pending offers right now.'), findsOneWidget);
    });

    testWidgets('delegates accept and decline taps to callbacks when provided', (tester) async {
      String? acceptedId;
      String? declinedId;

      await tester.pumpWidget(
        buildTestWidget(
          state: DispatchInboxState.ready,
          offers: [DispatchOfferFixtures.sampleOffer1],
          onAcceptOffer: (id) => acceptedId = id,
          onRejectOffer: (id) => declinedId = id,
        ),
      );

      await tester.tap(find.byKey(const Key('dispatch_offer_accept_button_grp-test-001')));
      await tester.pump();
      expect(acceptedId, 'grp-test-001');

      await tester.tap(find.byKey(const Key('dispatch_offer_reject_button_grp-test-001')));
      await tester.pump();
      expect(declinedId, 'grp-test-001');
    });
  });
}
