import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:lastmile_mobile/core/theme/app_theme.dart';
import 'package:lastmile_mobile/features/driver/presentation/widgets/driver_availability_card.dart';

void main() {
  Widget buildTestWidget({bool isOnline = false}) {
    return MaterialApp(
      theme: AppTheme.lightTheme,
      home: Scaffold(
        body: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: DriverAvailabilityCard(isOnline: isOnline),
          ),
        ),
      ),
    );
  }

  group('DriverAvailabilityCard Widget Tests', () {
    testWidgets('renders card with disabled Switch (onChanged is null)', (tester) async {
      await tester.pumpWidget(buildTestWidget(isOnline: false));

      expect(find.byKey(const Key('driver_availability_card')), findsOneWidget);
      expect(find.text('Driver Availability'), findsOneWidget);
      expect(find.text('Duty Status'), findsOneWidget);

      final switchFinder = find.byKey(const Key('driver_availability_switch'));
      expect(switchFinder, findsOneWidget);

      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.value, isFalse);
      expect(switchWidget.onChanged, isNull,
          reason: 'Switch must be disabled in Phase 1 because backend endpoint is not yet connected.');
    });

    testWidgets('displays offline badge when isOnline is false', (tester) async {
      await tester.pumpWidget(buildTestWidget(isOnline: false));

      final badgeFinder = find.byKey(const Key('driver_availability_status_badge'));
      expect(badgeFinder, findsOneWidget);
      expect(find.descendant(of: badgeFinder, matching: find.text('Offline (Disabled)')), findsOneWidget);
    });

    testWidgets('displays online badge when isOnline is true while switch remains disabled', (tester) async {
      await tester.pumpWidget(buildTestWidget(isOnline: true));

      final badgeFinder = find.byKey(const Key('driver_availability_status_badge'));
      expect(badgeFinder, findsOneWidget);
      expect(find.descendant(of: badgeFinder, matching: find.text('Online (Disabled)')), findsOneWidget);

      final switchWidget = tester.widget<Switch>(find.byKey(const Key('driver_availability_switch')));
      expect(switchWidget.value, isTrue);
      expect(switchWidget.onChanged, isNull);
    });

    testWidgets('displays clear explanation that dispatch integration is pending', (tester) async {
      await tester.pumpWidget(buildTestWidget());

      expect(find.byKey(const Key('driver_availability_explanation')), findsOneWidget);
      expect(
        find.textContaining(
          'Online availability will be enabled once backend dispatch integration is connected',
        ),
        findsOneWidget,
      );
    });

    testWidgets('tapping disabled switch does not change state or throw', (tester) async {
      await tester.pumpWidget(buildTestWidget(isOnline: false));

      final switchFinder = find.byKey(const Key('driver_availability_switch'));
      await tester.tap(switchFinder);
      await tester.pumpAndSettle();

      final switchWidget = tester.widget<Switch>(switchFinder);
      expect(switchWidget.value, isFalse);
      expect(switchWidget.onChanged, isNull);
    });
  });
}
