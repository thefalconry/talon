import 'dart:typed_data';

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/security/app_lock/app_lock_controller.dart';
import 'package:talon_companion/src/security/app_lock/biometrics.dart';
import 'package:talon_companion/src/security/app_lock/passcode_kdf.dart';
import 'package:talon_companion/src/security/app_lock/secret_store.dart';
import 'package:talon_companion/src/security/app_lock/snapshot_cipher.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'app_lock_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MemorySecretStore store;
  late MemorySealedSnapshotStore sealed;
  late DateTime now;
  final created = <AppLockController>[];

  final snapshot = <String, dynamic>{
    'chats': [
      {'id': 'c1', 'title': 'Plans'},
    ],
    'messages': {
      'c1': [
        {'id': 'm1', 'role': 'user', 'text': 'hello'},
      ],
    },
  };

  setUp(() {
    store = MemorySecretStore();
    sealed = MemorySealedSnapshotStore();
    now = DateTime(2026, 9, 1, 12);
  });

  tearDown(() {
    for (final c in created) {
      c.dispose();
    }
    created.clear();
    Prefs.sealedSnapshotSink = null;
  });

  Future<Prefs> prefsWith([Map<String, Object> values = const {}]) async {
    SharedPreferences.setMockInitialValues(values);
    return Prefs.load();
  }

  AppLockController controller(
    Prefs prefs, {
    BiometricUnlocker biometrics = const NoBiometrics(),
  }) {
    final c = AppLockController(
      prefs: prefs,
      store: store,
      sealedSnapshots: sealed,
      biometrics: biometrics,
      deriver: const Argon2PasscodeDeriver(useIsolate: false),
      cipher: const SnapshotCipher(useIsolate: false),
      kdfParams: testKdf,
      clock: () => now,
    );
    created.add(c);
    return c;
  }

  /// A lock set up with [passcode] in a first "process"; returns a fresh
  /// controller as after a cold start, loaded.
  Future<AppLockController> coldStart(
    Prefs prefs,
    String passcode, {
    Future<void> Function(AppLockController)? configure,
  }) async {
    final first = controller(prefs);
    await first.load();
    await first.enable(passcode);
    await configure?.call(first);
    final second = controller(prefs);
    await second.load();
    return second;
  }

  group('enabling', () {
    test('seals the plaintext snapshot and removes it', () async {
      final prefs = await prefsWith();
      await prefs.saveSnapshot(snapshot);
      expect(prefs.snapshot, snapshot);

      final lock = controller(prefs);
      await lock.load();
      expect(lock.status, AppLockStatus.disabled);
      await lock.enable('123456');

      expect(lock.status, AppLockStatus.unlocked);
      expect(prefs.appLockEnabled, isTrue);
      expect(prefs.snapshot, isNull, reason: 'no plaintext left behind');
      expect(sealed.value, isNotNull);
      expect(sealed.value!.contains('Plans'), isFalse);
      expect(sealed.value!.contains('hello'), isFalse);
    });

    test('never stores the passcode', () async {
      final prefs = await prefsWith();
      final lock = controller(prefs);
      await lock.load();
      await lock.enable('271828');
      final raw = store.values[AppLockController.recordKey]!;
      expect(raw.contains('271828'), isFalse);
      expect(lock.numericPasscode, isTrue);
    });

    test('rejects weak passcodes', () async {
      final prefs = await prefsWith();
      final lock = controller(prefs);
      await lock.load();
      await expectLater(lock.enable('1234'), throwsArgumentError);
      expect(lock.enabled, isFalse);
    });

    test('snapshots saved while on go sealed, never plaintext', () async {
      final prefs = await prefsWith();
      final lock = controller(prefs);
      await lock.load();
      await lock.enable('123456');
      await prefs.saveSnapshot(snapshot);
      expect(prefs.snapshot, isNull);
      expect(
        SnapshotCipher.openSync(
          await unlockKey(store, '123456'),
          sealed.value!,
        ),
        snapshot,
      );
    });
  });

  group('cold start', () {
    test('starts locked from the prefs mirror, before the record loads',
        () async {
      final prefs = await prefsWith({'applock.enabled.v1': true});
      final lock = controller(prefs);
      expect(lock.locked, isTrue);
      expect(lock.ready, isFalse);
    });

    test('unlocks with the passcode and releases the snapshot', () async {
      final prefs = await prefsWith();
      await prefs.saveSnapshot(snapshot);
      final lock = await coldStart(prefs, '123456');
      expect(lock.locked, isTrue);

      Map<String, dynamic>? restored;
      lock.onSnapshotUnsealed = (s) => restored = s;
      final result = await lock.unlockWithPasscode('123456');
      expect(result.ok, isTrue);
      expect(lock.status, AppLockStatus.unlocked);
      expect(restored, snapshot);
    });

    test('whenUnlocked waits for the unlock', () async {
      final prefs = await prefsWith();
      final lock = await coldStart(prefs, '123456');
      var done = false;
      final waiting = lock.whenUnlocked().then((_) => done = true);
      await Future<void>.delayed(Duration.zero);
      expect(done, isFalse);
      await lock.unlockWithPasscode('123456');
      await waiting;
      expect(done, isTrue);
    });

    test('a save while locked waits for the key, and wins over the old copy',
        () async {
      final prefs = await prefsWith();
      await prefs.saveSnapshot(snapshot);
      final lock = await coldStart(prefs, '123456');
      final before = sealed.value;

      final live = <String, dynamic>{'chats': <Object>[], 'messages': {}};
      await prefs.saveSnapshot(live); // no key yet: deferred, not dropped
      expect(sealed.value, before);

      Map<String, dynamic>? restored;
      lock.onSnapshotUnsealed = (s) => restored = s;
      await lock.unlockWithPasscode('123456');
      expect(restored, isNull, reason: 'live data is newer than the cache');
      expect(
        SnapshotCipher.openSync(await unlockKey(store, '123456'), sealed.value!),
        live,
      );
    });

    test('a lost record turns the lock off and drops the sealed cache',
        () async {
      final prefs = await prefsWith({'applock.enabled.v1': true});
      sealed.value = 'stale';
      final lock = controller(prefs);
      await lock.load();
      expect(lock.status, AppLockStatus.disabled);
      expect(prefs.appLockEnabled, isFalse);
      expect(sealed.value, isNull);
    });

    test('an unreadable store keeps it locked with only a reset', () async {
      final prefs = await prefsWith({'applock.enabled.v1': true});
      final lock = AppLockController(
        prefs: prefs,
        store: ThrowingSecretStore(),
        sealedSnapshots: sealed,
        deriver: const Argon2PasscodeDeriver(useIsolate: false),
        clock: () => now,
      );
      created.add(lock);
      await lock.load();
      expect(lock.locked, isTrue);
      expect(lock.storeError, isTrue);
      final r = await lock.unlockWithPasscode('123456');
      expect(r.outcome, UnlockOutcome.unavailable);
    });
  });

  group('keychain recovery', () {
    AppLockController withStores(
      Prefs prefs,
      SecretStore primary,
      SecretStore params,
    ) {
      final c = AppLockController(
        prefs: prefs,
        store: primary,
        sealedSnapshots: sealed,
        deriver: const Argon2PasscodeDeriver(useIsolate: false),
        cipher: const SnapshotCipher(useIsolate: false),
        kdfParams: testKdf,
        clock: () => now,
        paramsStore: params,
      );
      created.add(c);
      return c;
    }

    test('the params mirror never holds the verifier', () async {
      final prefs = await prefsWith();
      final params = MemorySecretStore();
      final first = withStores(prefs, store, params);
      await first.load();
      await first.enable('123456');
      final mirror = params.values[AppLockController.paramsKey]!;
      expect(mirror, isNot(contains('verifier')));
      expect(store.values[AppLockController.recordKey], contains('verifier'));
    });

    test('an unreadable keychain is recovered with the passcode, not erased',
        () async {
      final prefs = await prefsWith();
      final params = MemorySecretStore();
      final first = withStores(prefs, store, params);
      await first.load();
      await first.enable('123456');

      // Next launch: a new code signature, the keychain item won't open.
      var wiped = false;
      final lock = withStores(prefs, ThrowingSecretStore(), params)
        ..onWipe = () async => wiped = true;
      await lock.load();
      expect(lock.locked, isTrue);
      expect(lock.storeError, isFalse);
      expect(lock.recovering, isTrue);

      var r = await lock.unlockWithPasscode('000000');
      expect(r.outcome, UnlockOutcome.wrongPasscode);
      expect(lock.locked, isTrue);

      now = now.add(const Duration(seconds: 2));
      r = await lock.unlockWithPasscode('123456');
      expect(r.outcome, UnlockOutcome.success);
      expect(lock.status, AppLockStatus.unlocked);
      expect(wiped, isFalse);
      expect(prefs.appLockEnabled, isTrue);
    });

    test('recovery writes the record back to a store that accepts it',
        () async {
      final prefs = await prefsWith();
      final params = MemorySecretStore();
      final first = withStores(prefs, store, params);
      await first.load();
      await first.enable('123456');
      store.values.clear(); // the item this build can see is gone

      final lock = withStores(prefs, store, params);
      await lock.load();
      expect(lock.recovering, isTrue);
      expect(lock.enabled, isTrue, reason: 'never falls open');

      final r = await lock.unlockWithPasscode('123456');
      expect(r.outcome, UnlockOutcome.success);
      expect(lock.recovering, isFalse);
      expect(store.values[AppLockController.recordKey], contains('verifier'));

      // And the next launch reads it normally.
      final again = withStores(prefs, store, params);
      await again.load();
      expect(again.recovering, isFalse);
      expect(
        (await again.unlockWithPasscode('123456')).outcome,
        UnlockOutcome.success,
      );
    });

    test('retryLoad reads the store again after a denied prompt', () async {
      final prefs = await prefsWith();
      final first = controller(prefs);
      await first.load();
      await first.enable('123456');

      final flaky = _FlakySecretStore(store)..failing = true;
      final lock = AppLockController(
        prefs: prefs,
        store: flaky,
        sealedSnapshots: sealed,
        deriver: const Argon2PasscodeDeriver(useIsolate: false),
        cipher: const SnapshotCipher(useIsolate: false),
        kdfParams: testKdf,
        clock: () => now,
      );
      created.add(lock);
      await lock.load();
      expect(lock.storeError, isTrue);

      flaky.failing = false; // "Always Allow" this time
      await lock.retryLoad();
      expect(lock.storeError, isFalse);
      expect(lock.locked, isTrue);
      expect(
        (await lock.unlockWithPasscode('123456')).outcome,
        UnlockOutcome.success,
      );
    });
  });

  group('failures', () {
    test('back off 1s, 2s, 4s and survive a restart', () async {
      final prefs = await prefsWith();
      final lock = await coldStart(prefs, '123456');

      var r = await lock.unlockWithPasscode('000000');
      expect(r.outcome, UnlockOutcome.wrongPasscode);
      expect(r.retryAfter, const Duration(seconds: 1));

      r = await lock.unlockWithPasscode('123456');
      expect(r.outcome, UnlockOutcome.throttled, reason: 'even the right one');

      now = now.add(const Duration(seconds: 1));
      r = await lock.unlockWithPasscode('000000');
      expect(r.retryAfter, const Duration(seconds: 2));

      // Kill the app: the count and the wait are persisted.
      final again = controller(prefs);
      await again.load();
      expect(again.failedAttempts, 2);
      expect(again.retryAfter, const Duration(seconds: 2));

      now = now.add(const Duration(seconds: 2));
      r = await again.unlockWithPasscode('123456');
      expect(r.ok, isTrue);
      expect(again.failedAttempts, 0);
      expect(again.retryAfter, Duration.zero);
    });

    test('erase the connection at the threshold when enabled', () async {
      final prefs = await prefsWith();
      await prefs.saveSnapshot(snapshot);
      final lock = await coldStart(
        prefs,
        '123456',
        configure: (c) => c.setWipeAfter(3),
      );
      var wiped = 0;
      lock.onWipe = () async => wiped++;

      UnlockResult r = await lock.unlockWithPasscode('000000');
      expect(r.attemptsLeft, 2);
      now = now.add(const Duration(minutes: 1));
      r = await lock.unlockWithPasscode('000000');
      expect(r.attemptsLeft, 1);
      now = now.add(const Duration(minutes: 1));
      r = await lock.unlockWithPasscode('000000');

      expect(r.outcome, UnlockOutcome.wiped);
      expect(wiped, 1);
      expect(lock.status, AppLockStatus.disabled);
      expect(store.values, isEmpty);
      expect(sealed.value, isNull);
      expect(prefs.appLockEnabled, isFalse);
      expect(prefs.snapshot, isNull);
    });

    test('is off by default: failures only slow things down', () async {
      final prefs = await prefsWith();
      final lock = await coldStart(prefs, '123456');
      var wiped = 0;
      lock.onWipe = () async => wiped++;
      for (var i = 0; i < 12; i++) {
        now = now.add(const Duration(minutes: 2));
        final r = await lock.unlockWithPasscode('000000');
        expect(r.outcome, UnlockOutcome.wrongPasscode);
        expect(r.attemptsLeft, isNull);
      }
      expect(wiped, 0);
      expect(lock.enabled, isTrue);
    });

    test('forgot passcode: reset erases the lock and the connection',
        () async {
      final prefs = await prefsWith();
      final lock = await coldStart(prefs, '123456');
      var wiped = false;
      lock.onWipe = () async => wiped = true;
      final waiting = lock.whenUnlocked();
      await lock.reset(wipeConnection: true);
      await waiting; // a held pairing link may proceed — into a fresh pairing
      expect(wiped, isTrue);
      expect(lock.enabled, isFalse);
      expect(store.values, isEmpty);
    });
  });

  group('turning it off', () {
    test('needs the passcode and restores the plaintext cache', () async {
      final prefs = await prefsWith();
      await prefs.saveSnapshot(snapshot);
      final lock = await coldStart(prefs, '123456');

      var r = await lock.disable('000000');
      expect(r.outcome, UnlockOutcome.wrongPasscode);
      expect(lock.enabled, isTrue);

      now = now.add(const Duration(seconds: 5));
      r = await lock.disable('123456');
      expect(r.ok, isTrue);
      expect(lock.status, AppLockStatus.disabled);
      expect(prefs.appLockEnabled, isFalse);
      expect(prefs.snapshot, snapshot);
      expect(sealed.value, isNull);
      expect(store.values, isEmpty);
    });
  });

  test('change passcode', () async {
    final prefs = await prefsWith();
    final lock = await coldStart(prefs, '123456');
    await lock.unlockWithPasscode('123456');
    final r = await lock.changePasscode('123456', 'a longer password');
    expect(r.ok, isTrue);
    expect(lock.numericPasscode, isFalse);

    final fresh = controller(prefs);
    await fresh.load();
    expect((await fresh.unlockWithPasscode('123456')).ok, isFalse);
    now = now.add(const Duration(seconds: 2));
    expect((await fresh.unlockWithPasscode('a longer password')).ok, isTrue);
  });

  group('timeout', () {
    test('locks on return after the timeout, not before', () async {
      final prefs = await prefsWith();
      final lock = controller(prefs);
      await lock.load();
      await lock.enable('123456');

      lock.onLifecycle(AppLifecycleState.inactive);
      lock.onLifecycle(AppLifecycleState.hidden);
      lock.onLifecycle(AppLifecycleState.paused);
      now = now.add(const Duration(minutes: 4));
      lock.onLifecycle(AppLifecycleState.resumed);
      expect(lock.status, AppLockStatus.unlocked);

      lock.onLifecycle(AppLifecycleState.paused);
      now = now.add(const Duration(minutes: 5));
      lock.onLifecycle(AppLifecycleState.resumed);
      expect(lock.status, AppLockStatus.locked);
    });

    test('"immediately" locks as the app leaves', () async {
      final prefs = await prefsWith();
      final lock = controller(prefs);
      await lock.load();
      await lock.enable('123456');
      await lock.setTimeoutSeconds(0);
      lock.onLifecycle(AppLifecycleState.inactive);
      expect(lock.locked, isFalse, reason: 'inactive is not "away"');
      lock.onLifecycle(AppLifecycleState.hidden);
      expect(lock.locked, isTrue);
    });

    testWidgets('locks after idling in the foreground', (tester) async {
      final prefs = await prefsWith();
      final lock = AppLockController(
        prefs: prefs,
        store: store,
        sealedSnapshots: sealed,
        deriver: const FakeDeriver(),
        cipher: const SnapshotCipher(useIsolate: false),
        clock: () => now,
      );
      await lock.load();
      await lock.enable('123456');

      now = now.add(const Duration(minutes: 3));
      lock.noteActivity();
      now = now.add(const Duration(minutes: 2));
      await tester.pump(const Duration(minutes: 5));
      expect(lock.locked, isFalse, reason: 'active 2 minutes ago');

      now = now.add(const Duration(minutes: 3));
      await tester.pump(const Duration(minutes: 3));
      expect(lock.locked, isTrue);
      lock.dispose();
    });
  });

  group('elevated-command approval', () {
    Future<AppLockController> gated(Prefs prefs) async {
      final lock = controller(prefs);
      await lock.load();
      await lock.enable('123456');
      await lock.setRequireUnlockForElevated(true);
      return lock;
    }

    test('off by default: everything passes', () async {
      final prefs = await prefsWith();
      final lock = controller(prefs);
      await lock.load();
      await lock.enable('123456');
      expect(await lock.approveCommand('exec'), isNull);
      expect(prefs.appLockElevatedGate, isFalse);
    });

    test('prompts, approves with the passcode, and covers a window', () async {
      final prefs = await prefsWith();
      final lock = await gated(prefs);
      expect(prefs.appLockElevatedGate, isTrue);

      final first = lock.approveCommand('exec');
      final second = lock.approveCommand('write_file');
      await Future<void>.delayed(Duration.zero);
      expect(lock.pendingApproval?.command, 'exec', reason: 'one prompt');

      final r = await lock.approveWithPasscode('123456');
      expect(r.ok, isTrue);
      expect(await first, isNull);
      expect(await second, isNull);
      expect(lock.pendingApproval, isNull);

      expect(await lock.approveCommand('exec'), isNull, reason: 'in window');
      now = now.add(AppLockController.approvalWindow);
      final third = lock.approveCommand('exec');
      await Future<void>.delayed(Duration.zero);
      expect(lock.pendingApproval, isNotNull);
      lock.denyPending();
      expect(await third, AppLockController.deniedByUser);
    });

    test('a wrong passcode does not approve', () async {
      final prefs = await prefsWith();
      final lock = await gated(prefs);
      final pending = lock.approveCommand('exec');
      await Future<void>.delayed(Duration.zero);
      final r = await lock.approveWithPasscode('000000');
      expect(r.ok, isFalse);
      expect(lock.pendingApproval, isNotNull);
      lock.denyPending();
      expect(await pending, AppLockController.deniedByUser);
    });

    test('refused outright with the app in the background', () async {
      final prefs = await prefsWith();
      final lock = await gated(prefs);
      lock.onLifecycle(AppLifecycleState.paused);
      expect(
        await lock.approveCommand('exec'),
        AppLockController.deniedInBackground,
      );
    });

    test('going to the background refuses a waiting prompt', () async {
      final prefs = await prefsWith();
      final lock = await gated(prefs);
      final pending = lock.approveCommand('exec');
      await Future<void>.delayed(Duration.zero);
      lock.onLifecycle(AppLifecycleState.paused);
      expect(await pending, AppLockController.deniedByUser);
    });
  });

  group('biometrics', () {
    test('enrol, then unlock without the passcode', () async {
      final prefs = await prefsWith();
      final bio = FakeBiometrics();
      final first = controller(prefs, biometrics: bio);
      await first.load();
      await first.enable('123456');
      expect(await first.setBiometrics(true), isTrue);
      expect(first.biometricsEnabled, isTrue);

      final lock = controller(prefs, biometrics: bio);
      await lock.load();
      expect(lock.locked, isTrue);
      expect(await lock.unlockWithBiometrics(), isTrue);
      expect(lock.status, AppLockStatus.unlocked);
    });

    test('a stale enrolled key is refused and biometrics switched off',
        () async {
      final prefs = await prefsWith();
      final bio = FakeBiometrics();
      final first = controller(prefs, biometrics: bio);
      await first.load();
      await first.enable('123456');
      await first.setBiometrics(true);
      bio.key = Uint8List(32); // not the data key

      final lock = controller(prefs, biometrics: bio);
      await lock.load();
      expect(await lock.unlockWithBiometrics(), isFalse);
      expect(lock.locked, isTrue);
      expect(lock.biometricsEnabled, isFalse);
    });

    test('cancelled prompt leaves it locked', () async {
      final prefs = await prefsWith();
      final bio = FakeBiometrics();
      final first = controller(prefs, biometrics: bio);
      await first.load();
      await first.enable('123456');
      await first.setBiometrics(true);
      bio.cancel = true;
      final lock = controller(prefs, biometrics: bio);
      await lock.load();
      expect(await lock.unlockWithBiometrics(), isFalse);
      expect(lock.locked, isTrue);
    });
  });
}

class _FlakySecretStore implements SecretStore {
  _FlakySecretStore(this.inner);

  final SecretStore inner;
  bool failing = false;

  @override
  Future<String?> read(String key) async {
    if (failing) throw StateError('keychain access denied');
    return inner.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    if (failing) throw StateError('keychain access denied');
    await inner.write(key, value);
  }

  @override
  Future<void> delete(String key) async {
    if (failing) throw StateError('keychain access denied');
    await inner.delete(key);
  }
}
