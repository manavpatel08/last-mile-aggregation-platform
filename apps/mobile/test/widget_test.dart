import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/app/app.dart';
import 'package:lastmile_mobile/core/config/app_config.dart';

void main() {
  const baseConfig = AppConfig(
    apiBaseUrl: 'http://localhost:3000/api/v1',
    socketBaseUrl: 'ws://localhost:3000/realtime',
    appEnv: 'development',
  );

  group('LastMileApp navigation foundation', () {
    testWidgets(
      'navigates from Role Selection to Passenger Home and back',
      (WidgetTester tester) async {
        await tester.pumpWidget(const LastMileApp(config: baseConfig));
        await tester.pumpAndSettle();

        expect(find.text('LastMile'), findsOneWidget);
        expect(find.byKey(const Key('role_card_passenger')), findsOneWidget);
        expect(find.byKey(const Key('role_card_driver')), findsOneWidget);

        await tester.tap(find.text('Continue as Passenger'));
        await tester.pumpAndSettle();

        expect(find.text('Passenger Home'), findsOneWidget);
        expect(find.text('Passenger Workspace'), findsOneWidget);
        expect(find.text('Ride Booking'), findsOneWidget);

        await tester.tap(find.byKey(const Key('switch_mode_button')));
        await tester.pumpAndSettle();

        expect(find.text('Choose an interface mode'), findsOneWidget);
      },
    );

    testWidgets(
      'navigates from Role Selection to Driver Home and back',
      (WidgetTester tester) async {
        await tester.pumpWidget(const LastMileApp(config: baseConfig));
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.text('Continue as Driver'));
        await tester.tap(find.text('Continue as Driver'));
        await tester.pumpAndSettle();

        expect(find.text('Driver Home'), findsOneWidget);
        expect(find.text('Driver Workspace'), findsOneWidget);
        expect(find.text('Driver Onboarding & Verification'), findsOneWidget);

        await tester.tap(find.byKey(const Key('switch_mode_button')));
        await tester.pumpAndSettle();

        expect(find.text('Choose an interface mode'), findsOneWidget);
      },
    );

    testWidgets(
      'respects initialMode override for Passenger launch',
      (WidgetTester tester) async {
        const passengerConfig = AppConfig(
          apiBaseUrl: 'http://localhost:3000/api/v1',
          socketBaseUrl: 'ws://localhost:3000/realtime',
          appEnv: 'development',
          initialMode: AppMode.passenger,
        );

        await tester.pumpWidget(const LastMileApp(config: passengerConfig));
        await tester.pumpAndSettle();

        expect(find.text('Passenger Home'), findsOneWidget);
      },
    );

    testWidgets(
      'respects initialMode override for Driver launch',
      (WidgetTester tester) async {
        const driverConfig = AppConfig(
          apiBaseUrl: 'http://localhost:3000/api/v1',
          socketBaseUrl: 'ws://localhost:3000/realtime',
          appEnv: 'development',
          initialMode: AppMode.driver,
        );

        await tester.pumpWidget(const LastMileApp(config: driverConfig));
        await tester.pumpAndSettle();

        expect(find.text('Driver Home'), findsOneWidget);
      },
    );
  });
}
