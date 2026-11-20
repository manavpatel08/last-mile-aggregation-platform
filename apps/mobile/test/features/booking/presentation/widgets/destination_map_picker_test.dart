import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

import 'package:lastmile_mobile/features/booking/models/pickup_point.dart';
import 'package:lastmile_mobile/features/booking/presentation/widgets/destination_map_picker.dart';

class FakeUrlLauncherPlatform extends UrlLauncherPlatform {
  String? lastUrl;
  LaunchOptions? lastOptions;
  int launchCallCount = 0;
  bool launchResult = true;
  Exception? errorToThrow;

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    launchCallCount++;
    lastUrl = url;
    lastOptions = options;
    if (errorToThrow != null) {
      throw errorToThrow!;
    }
    return launchResult;
  }
}

void main() {
  late UrlLauncherPlatform originalLauncher;
  late FakeUrlLauncherPlatform fakeLauncher;

  setUp(() {
    originalLauncher = UrlLauncherPlatform.instance;
    fakeLauncher = FakeUrlLauncherPlatform();
    UrlLauncherPlatform.instance = fakeLauncher;
  });

  tearDown(() {
    UrlLauncherPlatform.instance = originalLauncher;
  });

  Widget buildTestableWidget() {
    return MaterialApp(
      home: Scaffold(
        body: DestinationMapPicker(
          selectedPickupPoint: const PickupPoint(
            id: 'hub-pdeu',
            name: 'PDEU Main Gate',
            serviceZoneId: 'zone-1',
            radiusMeters: 150.0,
            latitude: 23.1550,
            longitude: 72.6668,
            isActive: true,
          ),
          serviceRegions: const [],
          passengerLocation: const LatLng(23.1550, 72.6668),
          selectedDestination: null,
          onDestinationSelected: (_) {},
        ),
      ),
    );
  }

  group('DestinationMapPicker OpenStreetMap Attribution Tests', () {
    testWidgets(
        '1 & 2 & 3: attribution is visible and tapping launches exact copyright URL with external application mode',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(buildTestableWidget());
      await tester.pumpAndSettle();

      // 1. Attribution is visible
      final attributionFinder = find.byKey(const Key('osm_attribution'));
      expect(attributionFinder, findsOneWidget);
      expect(find.text('© OpenStreetMap contributors'), findsOneWidget);

      // 2. Tapping it invokes launchUrl
      await tester.tap(attributionFinder);
      await tester.pumpAndSettle();

      expect(fakeLauncher.launchCallCount, 1);
      // Exact destination URL verified
      expect(
        fakeLauncher.lastUrl,
        'https://www.openstreetmap.org/copyright',
      );
      // 3. External application launch mode verified
      expect(
        fakeLauncher.lastOptions?.mode,
        PreferredLaunchMode.externalApplication,
      );
    });

    testWidgets('4: a successful launch does not show an error',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      fakeLauncher.launchResult = true;

      await tester.pumpWidget(buildTestableWidget());
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('osm_attribution')));
      await tester.pumpAndSettle();

      expect(fakeLauncher.launchCallCount, 1);
      expect(find.byKey(const Key('osm_attribution_error_snackbar')), findsNothing);
      expect(
        find.text('Unable to open OpenStreetMap copyright page.'),
        findsNothing,
      );
    });

    testWidgets('5: a false launch result is handled without a crash and displays error',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      fakeLauncher.launchResult = false;

      await tester.pumpWidget(buildTestableWidget());
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('osm_attribution')));
      await tester.pump(); // Render SnackBar

      expect(fakeLauncher.launchCallCount, 1);
      expect(find.byKey(const Key('osm_attribution_error_snackbar')), findsOneWidget);
      expect(
        find.text('Unable to open OpenStreetMap copyright page.'),
        findsOneWidget,
      );
    });

    testWidgets('6: a platform exception is handled without a crash',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      fakeLauncher.errorToThrow = PlatformException(
        code: 'ACTIVITY_NOT_FOUND',
        message: 'No application found to handle URL',
      );

      await tester.pumpWidget(buildTestableWidget());
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('osm_attribution')));
      await tester.pump();

      expect(fakeLauncher.launchCallCount, 1);
      expect(find.byKey(const Key('osm_attribution_error_snackbar')), findsOneWidget);
      expect(
        find.text('Unable to open OpenStreetMap copyright page.'),
        findsOneWidget,
      );
    });

    testWidgets('7: the attribution remains visible and usable after a failed launch',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      // Attempt 1 fails with false result
      fakeLauncher.launchResult = false;

      await tester.pumpWidget(buildTestableWidget());
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('osm_attribution')));
      await tester.pump();

      expect(fakeLauncher.launchCallCount, 1);
      expect(
        find.text('Unable to open OpenStreetMap copyright page.'),
        findsOneWidget,
      );

      // Attribution remains visible and usable
      final attributionFinder = find.byKey(const Key('osm_attribution'));
      expect(attributionFinder, findsOneWidget);
      expect(find.text('© OpenStreetMap contributors'), findsOneWidget);

      // Attempt 2 succeeds
      fakeLauncher.launchResult = true;
      await tester.tap(attributionFinder);
      await tester.pumpAndSettle();

      expect(fakeLauncher.launchCallCount, 2);
    });
  });
}
