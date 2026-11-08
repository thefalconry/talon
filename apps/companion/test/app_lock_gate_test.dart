import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/security/app_lock/app_lock_controller.dart';
import 'package:talon_companion/src/security/app_lock/secret_store.dart';
import 'package:talon_companion/src/security/app_lock/snapshot_cipher.dart';
import 'package:talon_companion/src/services/pair_links.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/app_lock/app_lock_gate.dart';
import 'package:talon_companion/src/ui/app_lock/lock_screen.dart';
import 'package:talon_companion/src/ui/pair_confirm_dialog.dart';
import 'package:talon_companion/src/ui/root_view.dart';
import 'package:talon_companion/src/ui/settings/app_lock_card.dart';

import 'app_lock_harness.dart';

const _fp = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

void main() {
  late MemorySecretStore store;
  late MemorySealedSnapshotStore sealed;
  late DateTime now;

  setUp(() {
    store = MemorySecretStore();
    sealed = MemorySealedSnapshotStore();
    now = DateTime(2026, 9, 1, 12);
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);
  });

  tearDown(() => Prefs.sealedSnapshotSink = null);

  AppLockController make(Prefs prefs) => AppLockController(
        prefs: prefs,
        store: store,
        sealedSnapshots: sealed,
        deriver: const FakeDeriver(),
        cipher: const SnapshotCipher(useIsolate: false),
        clock: () => now,
      );

  /// Set the lock up (timeout "immediately", so no idle timer runs in the
  /// test), then return a cold-started, locked controller.
  Future<AppLockController> locked(
    Prefs prefs, {
    bool gate = false,
  }) async {
    final setup = make(prefs);
    await setup.load();
    await setup.enable('123456');
    await setup.setTimeoutSeconds(0);
    if (gate) await setup.setRequireUnlockForElevated(true);
    setup.dispose();
    final lock = make(prefs);
    await lock.load();
    return lock;
  }

  Widget app(AppLockController lock, Widget home) => MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: AppLockGate(
            controller: lock,
            relayBackgroundApprovals: false,
            child: child!,
          ),
        ),
        home: home,
      );

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  Future<void> typeAndSubmit(WidgetTester tester, String passcode) async {
    await tester.enterText(find.byKey(LockScreen.passcodeFieldKey), passcode);
    await tester.tap(find.byKey(LockScreen.submitKey));
    await settle(tester);
  }

  Future<void> finish(WidgetTester tester, AppLockController lock) async {
    await tester.pumpWidget(const SizedBox());
    lock.dispose();
  }

  testWidgets('covers every route until unlocked', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final lock = await locked(prefs);

    await tester.pumpWidget(
      app(lock, const Scaffold(body: Text('secret chat'))),
    );
    await settle(tester);
    expect(find.text('Talon is locked'), findsOneWidget);
    expect(find.text('secret chat'), findsNothing);

    await typeAndSubmit(tester, '123456');
    expect(find.text('Talon is locked'), findsNothing);
    expect(find.text('secret chat'), findsOneWidget);
    await finish(tester, lock);
  });

  testWidgets('a wrong passcode backs off before the next try',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final lock = await locked(prefs);
    await tester.pumpWidget(app(lock, const Scaffold(body: Text('app'))));
    await settle(tester);

    await typeAndSubmit(tester, '000000');
    expect(find.textContaining('Try again in 1s'), findsOneWidget);
    expect(lock.locked, isTrue);

    now = now.add(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Wrong passcode.'), findsOneWidget);

    await typeAndSubmit(tester, '123456');
    expect(lock.locked, isFalse);
    await finish(tester, lock);
  });

  testWidgets('forgot passcode resets the lock and erases the connection',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final lock = await locked(prefs);
    var wiped = false;
    lock.onWipe = () async => wiped = true;
    await tester.pumpWidget(app(lock, const Scaffold(body: Text('app'))));
    await settle(tester);

    await tester.tap(find.byKey(LockScreen.forgotKey));
    await settle(tester);
    expect(wiped, isFalse, reason: 'asks first');
    await tester.tap(find.byKey(LockScreen.resetConfirmKey));
    await settle(tester);

    expect(wiped, isTrue);
    expect(lock.enabled, isFalse);
    expect(find.text('app'), findsOneWidget);
    await finish(tester, lock);
  });

  testWidgets('a pairing link waits for the unlock', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final lock = await locked(prefs);
    final state = _PairState(prefs);
    addTearDown(state.dispose);
    final link = Uri(
      scheme: 'talon',
      host: 'pair',
      queryParameters: {'u': 'https://192.168.1.2:19880', 't': 'tok', 'f': _fp},
    ).toString();

    await tester.pumpWidget(
      app(
        lock,
        Scaffold(body: RootView(state: state, pairLinks: _FakeLinks(link))),
      ),
    );
    await settle(tester);
    expect(
      find.byType(PairConfirmDialog, skipOffstage: false),
      findsNothing,
      reason: 'not even pushed behind the lock',
    );

    await typeAndSubmit(tester, '123456');
    await settle(tester);
    expect(find.byType(PairConfirmDialog), findsOneWidget);
    expect(state.applied, isEmpty, reason: 'still needs Connect');
    await finish(tester, lock);
  });

  testWidgets('device commands wait for an on-device approval',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final lock = await locked(prefs, gate: true);
    await tester.pumpWidget(app(lock, const Scaffold(body: Text('app'))));
    await settle(tester);
    await typeAndSubmit(tester, '123456');
    expect(find.text('app'), findsOneWidget);

    String? outcome = 'pending';
    lock.approveCommand('exec').then((r) => outcome = r);
    await settle(tester);
    expect(find.text('Approve device command?'), findsOneWidget);
    expect(find.textContaining('“exec”'), findsOneWidget);
    expect(outcome, 'pending');

    await typeAndSubmit(tester, '123456');
    expect(outcome, isNull, reason: 'approved');
    expect(find.text('Approve device command?'), findsNothing);

    // Inside the approval window: no prompt at all.
    expect(await lock.approveCommand('delete'), isNull);

    now = now.add(AppLockController.approvalWindow);
    lock.approveCommand('exec').then((r) => outcome = r);
    await settle(tester);
    await tester.tap(find.byKey(LockScreen.denyKey));
    await settle(tester);
    expect(outcome, AppLockController.deniedByUser);
    await finish(tester, lock);
  });

  testWidgets('Settings: turning the lock on asks for the passcode twice',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final lock = make(prefs);
    await lock.load();
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTalonTheme(),
        home: Scaffold(
          body: SingleChildScrollView(child: AppLockCard(controller: lock)),
        ),
      ),
    );
    await tester.tap(find.byType(Switch).first);
    await settle(tester);

    await tester.enterText(
      find.byKey(const ValueKey('app-lock-new-passcode')),
      '123456',
    );
    await tester.enterText(
      find.byKey(const ValueKey('app-lock-confirm-passcode')),
      '654321',
    );
    await tester.tap(find.text('Save'));
    await settle(tester);
    expect(find.textContaining('don’t match'), findsOneWidget);
    expect(lock.enabled, isFalse);

    await tester.enterText(
      find.byKey(const ValueKey('app-lock-confirm-passcode')),
      '123456',
    );
    await tester.tap(find.text('Save'));
    await settle(tester);
    expect(lock.enabled, isTrue);
    expect(prefs.appLockEnabled, isTrue);
    expect(find.text('Lock after'), findsOneWidget);
    await finish(tester, lock);
  });
}

class _FakeLinks extends PairLinks {
  _FakeLinks(this._pending) : super(isSupported: () => true);

  String? _pending;

  @override
  Future<String?> consume() async {
    final link = _pending;
    _pending = null;
    return link;
  }
}

class _PairState extends AppState {
  _PairState(super.prefs) : super(narrowLayout: true);

  final applied = <ConnectionConfig>[];

  @override
  Future<void> applyConfig(ConnectionConfig config) async {
    applied.add(config);
  }

  @override
  Future<ConfigSnapshot?> loadConfig() async => null;

  @override
  Future<void> refreshMeshDevices() async {}

  @override
  Future<void> refreshMeshBackgroundHealth() async {}
}
