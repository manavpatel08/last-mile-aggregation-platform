import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/core/theme/app_theme.dart';
import 'package:lastmile_mobile/features/booking/models/booking_response.dart';
import 'package:lastmile_mobile/features/booking/presentation/widgets/active_booking_card.dart';

void main() {
  group('ActiveBookingCard Widget Tests', () {
    testWidgets('renders active booking card and triggers onViewDetails on tap',
        (tester) async {
      bool viewDetailsCalled = false;

      final booking = BookingResponse(
        bookingId: 'book-12345678-abcd',
        status: 'CONFIRMED',
        agreedFareCeiling: '45.00',
        maxWaitDeadline: DateTime(2026, 11, 20, 12, 30),
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.lightTheme,
          home: Scaffold(
            body: ActiveBookingCard(
              booking: booking,
              onViewDetails: () {
                viewDetailsCalled = true;
              },
            ),
          ),
        ),
      );

      expect(find.byKey(const Key('active_booking_card')), findsOneWidget);
      expect(find.byKey(const Key('active_booking_status_badge')), findsOneWidget);
      expect(find.text('CONFIRMED'), findsOneWidget);
      expect(find.text('BOOK-123'), findsOneWidget);
      expect(find.text('₹45.00'), findsOneWidget);

      final detailsButton = find.byKey(const Key('active_booking_details_button'));
      expect(detailsButton, findsOneWidget);

      await tester.tap(detailsButton);
      await tester.pumpAndSettle();

      expect(viewDetailsCalled, isTrue);
    });

    testWidgets('does not render details button when onViewDetails is null',
        (tester) async {
      final booking = BookingResponse(
        bookingId: 'book-12345678-abcd',
        status: 'REQUESTED',
        agreedFareCeiling: '40.00',
        maxWaitDeadline: DateTime(2026, 11, 20, 12, 30),
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.lightTheme,
          home: Scaffold(
            body: ActiveBookingCard(
              booking: booking,
            ),
          ),
        ),
      );

      expect(find.byKey(const Key('active_booking_details_button')), findsNothing);
    });

    testWidgets(
        'renders view trip button when status is DRIVER_ASSIGNED, DRIVER_ARRIVED, BOARDED, or IN_PROGRESS',
        (tester) async {
      for (final status in [
        'DRIVER_ASSIGNED',
        'DRIVER_ARRIVED',
        'BOARDED',
        'IN_PROGRESS',
      ]) {
        final booking = BookingResponse(
          bookingId: 'book-active-$status',
          status: status,
          agreedFareCeiling: '45.00',
          maxWaitDeadline: DateTime(2026, 11, 20, 12, 30),
        );

        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.lightTheme,
            home: Scaffold(
              body: ActiveBookingCard(booking: booking),
            ),
          ),
        );

        expect(
          find.byKey(const Key('active_booking_view_trip_button')),
          findsOneWidget,
          reason: 'View trip button must be visible for status $status',
        );
      }
    });

    testWidgets(
        'does not render view trip button when status is REQUESTED or MATCHING',
        (tester) async {
      for (final status in ['REQUESTED', 'MATCHING']) {
        final booking = BookingResponse(
          bookingId: 'book-pending-$status',
          status: status,
          agreedFareCeiling: '40.00',
          maxWaitDeadline: DateTime(2026, 11, 20, 12, 30),
        );

        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.lightTheme,
            home: Scaffold(
              body: ActiveBookingCard(booking: booking),
            ),
          ),
        );

        expect(
          find.byKey(const Key('active_booking_view_trip_button')),
          findsNothing,
          reason: 'View trip button must NOT be visible for status $status',
        );
      }
    });
  });
}
