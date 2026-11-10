import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/security/app_lock/app_lock_controller.dart';
import 'package:talon_companion/src/security/app_lock/secret_store.dart';
import 'package:talon_companion/src/services/secure_window.dart';
import 'package:talon_companion/src/ui/app_lock/app_lock_gate.dart';
import 'package:talon_companion/src/ui/settings/settings_widgets.dart';
import 'package:talon_companion/src/ui/settings_screen.dart';

import 'app_lock_harness.dart';

void main() {
  Widget app(AppState state, {AppLockController? lock}) => MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: lock == null
            ? SettingsScreen(state: state)
            : AppLockScope(
                controller: lock,
                child: SettingsScreen(state: state),
              ),
      );

  testWidgets('paints local settings before daemon config resolves', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final state = _DelayedSettingsState(prefs);
    addTearDown(state.dispose);

    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);

    await tester.pumpWidget(app(state));
    await tester.pump();

    // The home's local chapters are usable on the very first frame even
    // while the daemon request remains deliberately unresolved; the
    // daemon-backed ones (Agent, Mesh) wait for it.
    expect(find.text('Connection'), findsOneWidget);
    expect(find.text('Disconnected · this computer'), findsOneWidget);
    expect(find.text('Appearance'), findsOneWidget);
    expect(find.text('Light theme · text 100%'), findsOneWidget);
    expect(find.text('Agent'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    state.configResult.complete(_config);
    await tester.pump();
    await tester.pump();

    expect(find.text('Agent'), findsOneWidget);
    expect(find.text('Opus 4.8 · heartbeat on'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('the home runs connection first, advanced last, then version',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final state = _DelayedSettingsState(prefs);
    addTearDown(state.dispose);
    state.configResult.complete(_config);

    await tester.pumpWidget(app(state));
    await tester.pump();
    await tester.pump();

    double y(String title) => tester.getTopLeft(find.text(title)).dy;
    final order = [
      'Connection',
      'Agent',
      'Mesh & device control',
      'Appearance',
      'Updates',
      'Advanced',
    ];
    for (var i = 1; i < order.length; i++) {
      expect(y(order[i]), greaterThan(y(order[i - 1])),
          reason: '${order[i]} should follow ${order[i - 1]}');
    }
    expect(find.byKey(const Key('settings-version-footer')), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(const Key('settings-version-footer'))).dy,
      greaterThan(y('Advanced')),
    );
  });

  testWidgets('a home row pushes its chapter; Advanced ends in the danger zone',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final state = _DelayedSettingsState(prefs);
    addTearDown(state.dispose);
    state.configResult.complete(_config);

    await tester.pumpWidget(app(state));
    await tester.pump();
    await tester.pump();

    await tester.tap(find.text('Advanced'));
    await tester.pumpAndSettle();
    expect(find.text('DIAGNOSTICS'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('DANGER ZONE'), 300,
        scrollable: find.byType(Scrollable).last);
    expect(
      tester.getTopLeft(find.text('DANGER ZONE')).dy,
      greaterThan(tester.getTopLeft(find.text('ABOUT')).dy),
    );

    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Agent'));
    await tester.pumpAndSettle();
    expect(find.text('GENERAL'), findsOneWidget);
    expect(find.text('BACKGROUND AGENTS'), findsOneWidget);
  });

  testWidgets('Security: screenshot blocking follows the lock until set',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final state = _DelayedSettingsState(prefs);
    addTearDown(state.dispose);
    state.configResult.complete(_config);
    SecureWindow.debugOverride(supported: true);
    addTearDown(() => SecureWindow.debugOverride(supported: false));
    final lock = AppLockController(
      prefs: prefs,
      store: MemorySecretStore(),
      sealedSnapshots: MemorySealedSnapshotStore(),
      deriver: const FakeDeriver(),
    );
    addTearDown(lock.dispose);

    await tester.pumpWidget(app(state, lock: lock));
    await tester.pump();
    await tester.pump();

    // No passcode: the default is off.
    expect(lock.blockScreenshots, isFalse);
    expect(find.text('No passcode · screenshots allowed'), findsOneWidget);

    await tester.tap(find.text('Security'));
    await tester.pumpAndSettle();
    expect(find.text('APP LOCK'), findsOneWidget);
    expect(find.text('SCREEN PRIVACY'), findsOneWidget);
    final row = find.ancestor(
      of: find.text('Block screenshots and screen recording'),
      matching: find.byType(Row),
    );
    await tester.tap(
        find.descendant(of: row.first, matching: find.byType(Switch)));
    await tester.pumpAndSettle();
    expect(lock.blockScreenshots, isTrue);
    expect(prefs.blockScreenshots, isTrue);

    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('No passcode · screenshots blocked'), findsOneWidget);
  });

  testWidgets('desktop: a rail of the same chapters beside the pane',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final state = _DelayedSettingsState(prefs);
    addTearDown(state.dispose);
    state.configResult.complete(_config);
    tester.view.physicalSize = const Size(1100, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(app(state));
    await tester.pump();
    await tester.pump();

    expect(find.byType(RailTile), findsWidgets);
    expect(find.text('CONNECTION'), findsOneWidget);
    await tester.tap(find.text('Updates'));
    await tester.pumpAndSettle();
    expect(find.text('UPDATES'), findsOneWidget);
    expect(find.text('CONNECTION'), findsNothing);
  });
}

class _DelayedSettingsState extends AppState {
  _DelayedSettingsState(super.prefs) : super(narrowLayout: true);

  final configResult = Completer<ConfigSnapshot?>();

  @override
  Future<ConfigSnapshot?> loadConfig() => configResult.future;

  @override
  Future<void> refreshMeshDevices() async {}

  @override
  Future<void> refreshMeshBackgroundHealth() async {}
}

const _config = ConfigSnapshot(
  backend: 'claude',
  frontend: 'telegram',
  model: 'opus',
  modelDisplay: 'Opus 4.8',
  botDisplayName: 'Talon',
  timezone: 'UTC',
  pulse: false,
  pulseIntervalMs: 300000,
  heartbeat: true,
  heartbeatIntervalMinutes: 60,
  dream: false,
  editable: ['model', 'botDisplayName', 'timezone'],
  healthy: true,
  uptimeMs: 1000,
  sessions: 1,
  messages: 2,
  memoryMb: 64,
);
