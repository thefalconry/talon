/// Golden renders of the settings home and every chapter page, phone and
/// desktop.
///
///   TALON_GOLDENS=1 flutter test test/golden/settings_golden_test.dart --update-goldens
library;

import 'package:flutter/foundation.dart' show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/security/app_lock/app_lock_controller.dart';
import 'package:talon_companion/src/security/app_lock/secret_store.dart';
import 'package:talon_companion/src/services/secure_window.dart';
import 'package:talon_companion/src/ui/app_lock/app_lock_gate.dart';
import 'package:talon_companion/src/ui/settings/notifications_card.dart';
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
  editable: ['model', 'botDisplayName', 'timezone', 'pulse', 'heartbeat',
    'dream', 'pulseIntervalMs', 'heartbeatIntervalMinutes'],
  healthy: true,
  uptimeMs: 176400000,
  sessions: 63,
  messages: 43,
  memoryMb: 168,
);

const _chapters = [
  'Connection',
  'Agent',
  'Mesh & device control',
  'Security',
  'Notifications',
  'Appearance',
  'Voice',
  'Updates',
  'Advanced',
];

String _slug(String t) =>
    t.toLowerCase().replaceAll('&', 'and').replaceAll(RegExp('[^a-z]+'), '_');

void main() {
  if (!goldensEnabled) {
    test('settings page goldens skipped (set TALON_GOLDENS=1)', () {});
    return;
  }

  setUpAll(goldenSetUpAll);

  Future<void> render(WidgetTester tester, String name,
      {required bool phone,
      double? height,
      String? open,
      bool lockOn = false,
      Brightness brightness = Brightness.dark}) async {
    goldenSetUp(brightness: brightness);
    // flutter_test defaults to Android; desktop renders pretend to be macOS
    // so Android-only chapters (Voice, Notifications) drop out as they do.
    debugDefaultTargetPlatformOverride =
        phone ? TargetPlatform.android : TargetPlatform.macOS;
    if (phone) {
      SecureWindow.debugOverride(supported: true);
      NotificationsCard.debugSupported = true;
    }
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
    final lock = AppLockController(
      prefs: state.prefs,
      store: MemorySecretStore(),
      sealedSnapshots: MemorySealedSnapshotStore(),
      deriver: const FakeDeriver(),
    );
    if (lockOn) {
      await tester.runAsync(() async {
        await lock.load();
        await lock.enable('123456');
      });
    }
    await tester.pumpWidget(goldenApp(AppLockScope(
      controller: lock,
      child: SettingsScreen(state: state),
    )));
    if (open != null) {
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text(open).first);
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump(const Duration(milliseconds: 400));
    }
    await shoot(tester, name);
    debugDefaultTargetPlatformOverride = null;
    SecureWindow.debugOverride(supported: false);
    NotificationsCard.debugSupported = null;
  }

  testWidgets('phone · settings home', (tester) async {
    await render(tester, 'sp_phone_home', phone: true);
  });

  testWidgets('phone · settings home (light)', (tester) async {
    await render(tester, 'sp_phone_home_light',
        phone: true, brightness: Brightness.light);
  });

  for (final chapter in _chapters) {
    testWidgets('phone · settings · $chapter', (tester) async {
      await render(tester, 'sp_phone_${_slug(chapter)}',
          phone: true, height: 1900, open: chapter);
    });
  }

  testWidgets('phone · settings · Security (lock on)', (tester) async {
    await render(tester, 'sp_phone_security_lock_on',
        phone: true, height: 1300, open: 'Security', lockOn: true);
  });

  // Voice and Notifications are Android-only; desktop has neither chapter.
  for (final chapter in _chapters
      .where((c) => c != 'Voice' && c != 'Notifications')) {
    testWidgets('desktop · settings · $chapter', (tester) async {
      await render(tester, 'sp_desktop_${_slug(chapter)}',
          phone: false,
          height: chapter == 'Connection' ? 760 : 1300,
          open: chapter == 'Connection' ? null : chapter);
    });
  }

  testWidgets('desktop · settings · Security (lock on)', (tester) async {
    await render(tester, 'sp_desktop_security_lock_on',
        phone: false, open: 'Security', lockOn: true);
  });

  testWidgets('desktop · settings (light)', (tester) async {
    await render(tester, 'sp_desktop_connection_light',
        phone: false, brightness: Brightness.light);
  });
}
