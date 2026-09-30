/// Golden renders of the settings screen, top to bottom.
///
///   TALON_GOLDENS=1 flutter test test/golden --update-goldens
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/security/app_lock/app_lock_controller.dart';
import 'package:talon_companion/src/security/app_lock/secret_store.dart';
import 'package:talon_companion/src/ui/app_lock/app_lock_gate.dart';
import 'package:talon_companion/src/ui/settings_screen.dart';

import '../app_lock_harness.dart';
import 'chat_fixtures.dart';
import 'golden_harness.dart';

const ConfigSnapshot _config = ConfigSnapshot(
  backend: 'claude',
  frontend: 'telegram',
  model: 'opus',
  modelDisplay: 'Opus',
  botDisplayName: 'Talon',
  timezone: '',
  pulse: false,
  pulseIntervalMs: 300000,
  heartbeat: true,
  heartbeatIntervalMinutes: 60,
  dream: false,
  editable: [
    'model',
    'botDisplayName',
    'timezone',
    'pulse',
    'heartbeat',
    'dream',
    'pulseIntervalMs',
    'heartbeatIntervalMinutes',
  ],
  healthy: true,
  uptimeMs: 176400000,
  sessions: 63,
  messages: 43,
  memoryMb: 168,
);

void main() {
  if (!goldensEnabled) {
    test('settings goldens skipped (set TALON_GOLDENS=1)', () {});
    return;
  }

  setUpAll(goldenSetUpAll);

  Future<void> render(WidgetTester tester, String name,
      {required bool phone,
      double? height,
      Brightness brightness = Brightness.dark,
      String? tapChapter}) async {
    goldenSetUp(brightness: brightness);
    phone
        ? usePhone(tester, height: height ?? 844)
        : useDesktop(tester, height: height ?? 760);
    final state = seededState(
      narrow: phone,
      chats: [chatFor(markdown)],
      messages: {'c1': markdown.messages},
    );
    state.appConfig = _config;
    addTearDown(state.dispose);
    // An installed-but-unset app lock, so its section renders as on device.
    final lock = AppLockController(
      prefs: state.prefs,
      store: MemorySecretStore(),
      sealedSnapshots: MemorySealedSnapshotStore(),
      deriver: const FakeDeriver(),
    );
    await tester.pumpWidget(goldenApp(AppLockScope(
      controller: lock,
      child: SettingsScreen(state: state),
    )));
    if (tapChapter != null) {
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text(tapChapter).first);
    }
    await shoot(tester, name);
  }

  // Tall viewports so the whole page is visible in one image.
  testWidgets('phone · settings (full)', (tester) async {
    await render(tester, 'phone_settings_full', phone: true, height: 6400);
  });

  testWidgets('phone · settings (fold)', (tester) async {
    await render(tester, 'phone_settings', phone: true);
  });

  testWidgets('phone · settings (light, full)', (tester) async {
    await render(tester, 'phone_settings_full_light',
        phone: true, height: 6400, brightness: Brightness.light);
  });

  testWidgets('desktop · settings', (tester) async {
    await render(tester, 'desktop_settings', phone: false, height: 1600);
  });
}
