import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/security/app_lock/envelope.dart';
import 'package:talon_companion/src/security/app_lock/lock_record.dart';
import 'package:talon_companion/src/security/app_lock/passcode_kdf.dart';
import 'package:talon_companion/src/security/app_lock/snapshot_cipher.dart';

/// Cheap Argon2id parameters: same code path, milliseconds instead of a
/// second. Production uses [KdfParams.standard].
const _fast = KdfParams.argon2id(memoryKiB: 64, iterations: 1);

void main() {
  group('passcode KDF', () {
    const deriver = Argon2PasscodeDeriver(useIsolate: false);
    final salt = Uint8List.fromList(List.generate(16, (i) => i));

    test('is deterministic for the same passcode, salt and params', () async {
      final a = await deriver.derive('123456', salt, _fast);
      final b = await deriver.derive('123456', salt, _fast);
      expect(a.verifier, b.verifier);
      expect(a.kek, b.kek);
      expect(a.verifier, hasLength(32));
      expect(a.kek, hasLength(32));
    });

    test('verifier and KEK are independent', () async {
      final k = await deriver.derive('123456', salt, _fast);
      expect(constantTimeEquals(k.verifier, k.kek), isFalse);
    });

    test('a different passcode, salt or cost changes everything', () async {
      final base = await deriver.derive('123456', salt, _fast);
      final otherCode = await deriver.derive('123457', salt, _fast);
      final otherSalt = await deriver.derive(
        '123456',
        Uint8List.fromList(List.generate(16, (i) => 255 - i)),
        _fast,
      );
      final otherCost = await deriver.derive(
        '123456',
        salt,
        const KdfParams.argon2id(memoryKiB: 64, iterations: 2),
      );
      for (final other in [otherCode, otherSalt, otherCost]) {
        expect(constantTimeEquals(base.verifier, other.verifier), isFalse);
        expect(constantTimeEquals(base.kek, other.kek), isFalse);
      }
    });

    test('runs on a background isolate too', () async {
      const isolated = Argon2PasscodeDeriver();
      final a = await isolated.derive('hunter22', salt, _fast);
      final b = await deriver.derive('hunter22', salt, _fast);
      expect(a.verifier, b.verifier);
    });

    test('standard parameters are OWASP Argon2id minimums', () {
      expect(KdfParams.standard.algorithm, 'argon2id');
      expect(KdfParams.standard.memoryKiB, greaterThanOrEqualTo(19456));
      expect(KdfParams.standard.iterations, greaterThanOrEqualTo(2));
    });

    test('params round-trip and unknown algorithms are refused', () {
      expect(KdfParams.fromJson(_fast.toJson()), _fast);
      expect(
        () => KdfParams.fromJson({'alg': 'md5', 'm': 1, 't': 1, 'p': 1}),
        throwsFormatException,
      );
      expect(
        () => KdfParams.fromJson({'alg': 'argon2id', 'm': 1, 't': 1, 'p': 1}),
        throwsFormatException,
      );
    });

    test('constantTimeEquals', () {
      expect(constantTimeEquals([1, 2, 3], [1, 2, 3]), isTrue);
      expect(constantTimeEquals([1, 2, 3], [1, 2, 4]), isFalse);
      expect(constantTimeEquals([1, 2], [1, 2, 3]), isFalse);
    });
  });

  group('envelope (AES-256-GCM)', () {
    final key = Envelope.randomBytes(32);

    test('round-trips and uses a fresh nonce per seal', () {
      final plain = utf8.encode('hello talon');
      final a = Envelope.seal(key, plain, aad: 'x');
      final b = Envelope.seal(key, plain, aad: 'x');
      expect(a, isNot(b));
      expect(Envelope.open(key, a, aad: 'x'), plain);
      expect(a.contains('hello'), isFalse);
    });

    test('refuses the wrong key, the wrong purpose and tampering', () {
      final sealed = Envelope.seal(key, [1, 2, 3], aad: 'x');
      expect(
        () => Envelope.open(Envelope.randomBytes(32), sealed, aad: 'x'),
        throwsA(isA<EnvelopeException>()),
      );
      expect(
        () => Envelope.open(key, sealed, aad: 'y'),
        throwsA(isA<EnvelopeException>()),
      );
      final json = (jsonDecode(sealed) as Map).cast<String, dynamic>();
      final ct = base64Decode(json['c'] as String);
      ct[0] ^= 1;
      json['c'] = base64Encode(ct);
      expect(
        () => Envelope.open(key, jsonEncode(json), aad: 'x'),
        throwsA(isA<EnvelopeException>()),
      );
      expect(
        () => Envelope.open(key, 'not json', aad: 'x'),
        throwsA(isA<EnvelopeException>()),
      );
    });

    test('rejects keys of the wrong size', () {
      expect(() => Envelope.seal([1, 2, 3], [1], aad: 'x'), throwsArgumentError);
    });
  });

  group('snapshot cipher', () {
    final key = Envelope.randomBytes(32);
    final snapshot = <String, dynamic>{
      'chats': [
        {'id': 'c1', 'title': 'Secret plans'},
      ],
      'messages': {
        'c1': [
          {'id': 'm1', 'text': 'the launch code is 0000'},
        ],
      },
    };

    test('round-trips without leaking content', () async {
      const cipher = SnapshotCipher(useIsolate: false);
      final sealed = await cipher.seal(key, snapshot);
      expect(sealed.contains('Secret plans'), isFalse);
      expect(sealed.contains('launch code'), isFalse);
      expect(await cipher.open(key, sealed), snapshot);
    });

    test('round-trips through a background isolate', () async {
      const cipher = SnapshotCipher();
      final sealed = await cipher.seal(key, snapshot);
      expect(SnapshotCipher.openSync(key, sealed), snapshot);
    });

    test('is not interchangeable with a wrapped key', () {
      final wrapped = Envelope.seal(key, key, aad: 'talon.applock.datakey.v1');
      expect(
        () => SnapshotCipher.openSync(key, wrapped),
        throwsA(isA<EnvelopeException>()),
      );
    });
  });

  group('lock record', () {
    AppLockRecord sample() => AppLockRecord(
          kdf: _fast,
          salt: Uint8List.fromList([1, 2, 3]),
          verifier: Uint8List.fromList([4, 5, 6]),
          wrappedDataKey: '{"v":1}',
          keyCheck: Uint8List.fromList([7, 8]),
          numeric: true,
          biometrics: true,
          timeoutSeconds: 60,
          wipeAfter: 10,
          requireUnlockForElevated: true,
          failedAttempts: 3,
          lastFailureAtMs: 42,
        );

    test('round-trips', () {
      final r = AppLockRecord.decode(sample().encode());
      expect(r.kdf, _fast);
      expect(r.salt, [1, 2, 3]);
      expect(r.verifier, [4, 5, 6]);
      expect(r.wrappedDataKey, '{"v":1}');
      expect(r.keyCheck, [7, 8]);
      expect(r.numeric, isTrue);
      expect(r.biometrics, isTrue);
      expect(r.timeoutSeconds, 60);
      expect(r.wipeAfter, 10);
      expect(r.requireUnlockForElevated, isTrue);
      expect(r.failedAttempts, 3);
      expect(r.lastFailureAtMs, 42);
    });

    test('copyWith can clear the optional fields', () {
      final r = sample().copyWith(clearWipeAfter: true, clearLastFailure: true);
      expect(r.wipeAfter, isNull);
      expect(r.lastFailureAtMs, isNull);
    });

    test('refuses unknown versions and garbage', () {
      final json = (jsonDecode(sample().encode()) as Map)..['v'] = 99;
      expect(() => AppLockRecord.decode(jsonEncode(json)), throwsFormatException);
      expect(() => AppLockRecord.decode('[]'), throwsFormatException);
    });
  });

  test('backoff doubles from 1s and caps at 60s', () {
    expect(
      [for (var i = 0; i <= 9; i++) unlockDelayAfter(i).inSeconds],
      [0, 1, 2, 4, 8, 16, 32, 60, 60, 60],
    );
  });

  test('passcode rules', () {
    expect(validatePasscode('12345'), isNotNull);
    expect(validatePasscode('abcde'), isNotNull);
    expect(validatePasscode(' 123456'), isNotNull);
    expect(validatePasscode('123456'), isNull);
    expect(validatePasscode('correct horse'), isNull);
    expect(isNumericPasscode('123456'), isTrue);
    expect(isNumericPasscode('12345a'), isFalse);
  });
}
