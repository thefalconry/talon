import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/settings_screen.dart';

void main() {
  testWidgets('paints local settings before daemon config resolves', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final state = _DelayedSettingsState(prefs);
    addTearDown(state.dispose);

    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: SettingsScreen(state: state),
      ),
    );
    await tester.pump();

    // These are all local and should be usable on the very first frame even
    // while the daemon request remains deliberately unresolved.
    expect(find.text('Disconnected'), findsOneWidget);
    expect(find.text('APPEARANCE'), findsOneWidget);
    expect(find.text('Auto'), findsOneWidget);
    expect(find.text('SETTINGS UNAVAILABLE'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    state.configResult.complete(_config);
    await tester.pump();
    await tester.pump();

    expect(find.text('GENERAL'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('the phone column runs connection first, danger zone last', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final state = _DelayedSettingsState(prefs);
    addTearDown(state.dispose);
    state.configResult.complete(_config);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: SettingsScreen(state: state),
      ),
    );
    await tester.pump();
    await tester.pump();

    double y(String eyebrow) => tester.getTopLeft(find.text(eyebrow)).dy;
    final order = [
      'CONNECTION',
      'GENERAL',
      'MESH & DEVICE CONTROL',
      'APPEARANCE',
      'DIAGNOSTICS',
      'ABOUT',
      'DANGER ZONE',
    ];
    for (var i = 1; i < order.length; i++) {
      expect(y(order[i]), greaterThan(y(order[i - 1])),
          reason: '${order[i]} should follow ${order[i - 1]}');
    }
    expect(find.byKey(const Key('settings-version-footer')), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(const Key('settings-version-footer'))).dy,
      greaterThan(y('DANGER ZONE')),
    );
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
