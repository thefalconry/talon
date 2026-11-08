import 'dart:convert';
import 'dart:typed_data';

import 'package:talon_companion/src/security/app_lock/app_lock_controller.dart';
import 'package:talon_companion/src/security/app_lock/biometrics.dart';
import 'package:talon_companion/src/security/app_lock/envelope.dart';
import 'package:talon_companion/src/security/app_lock/lock_record.dart';
import 'package:talon_companion/src/security/app_lock/passcode_kdf.dart';
import 'package:talon_companion/src/security/app_lock/secret_store.dart';

/// Real Argon2id, trivial cost — keeps unit tests fast.
const testKdf = KdfParams.argon2id(memoryKiB: 64, iterations: 1);

/// Instant, synchronous stand-in for the KDF (widget tests run in fake async,
/// where a real KDF's scheduling would need pumping). Same shape of output.
class FakeDeriver extends PasscodeDeriver {
  const FakeDeriver();

  @override
  Future<PasscodeKeys> derive(
    String passcode,
    List<int> salt,
    KdfParams params,
  ) =>
      Future.value(
        Argon2PasscodeDeriver.splitMaster(
          Argon2PasscodeDeriver.labelledKey(
            [...salt, ...utf8.encode(passcode)],
            'fake-kdf',
          ),
        ),
      );
}

class FakeBiometrics extends BiometricUnlocker {
  Uint8List? key;
  bool cancel = false;

  @override
  String get label => 'Fingerprint';

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<bool> enroll(Uint8List dataKey, {required String reason}) async {
    if (cancel) return false;
    key = Uint8List.fromList(dataKey);
    return true;
  }

  @override
  Future<Uint8List?> unlock({required String reason}) async =>
      cancel ? null : key;

  @override
  Future<void> clear() async {
    key = null;
  }
}

class ThrowingSecretStore implements SecretStore {
  @override
  Future<String?> read(String key) => Future.error(StateError('keystore'));

  @override
  Future<void> write(String key, String value) =>
      Future.error(StateError('keystore'));

  @override
  Future<void> delete(String key) => Future.error(StateError('keystore'));
}

/// The data key, recovered the long way from the stored record — proves the
/// record alone (plus the passcode) is enough, and nothing else is needed.
Future<Uint8List> unlockKey(
  MemorySecretStore store,
  String passcode, {
  PasscodeDeriver deriver = const Argon2PasscodeDeriver(useIsolate: false),
}) async {
  final record =
      AppLockRecord.decode(store.values[AppLockController.recordKey]!);
  final keys = await deriver.derive(passcode, record.salt, record.kdf);
  return Envelope.open(
    keys.kek,
    record.wrappedDataKey,
    aad: 'talon.applock.datakey.v1',
  );
}
