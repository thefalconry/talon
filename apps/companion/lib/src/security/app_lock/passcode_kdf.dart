import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart' show SecretKey;
import 'package:cryptography/dart.dart' show DartArgon2id;

/// Cost parameters for turning an app-lock passcode into key material.
///
/// Stored next to the verifier so they can be raised later without locking
/// anyone out: a record always verifies with the parameters it was made with.
class KdfParams {
  /// Only Argon2id today. Anything else in a stored record is refused rather
  /// than guessed at.
  final String algorithm;

  /// Argon2 memory cost, in 1 KiB blocks.
  final int memoryKiB;
  final int iterations;
  final int parallelism;

  const KdfParams.argon2id({
    this.memoryKiB = 19456,
    this.iterations = 2,
    this.parallelism = 1,
  }) : algorithm = 'argon2id';

  /// OWASP's minimum recommendation for Argon2id: 19 MiB, t=2, p=1. Derived
  /// on a background isolate, so the cost is a short spinner on unlock, never
  /// a janked frame.
  static const KdfParams standard = KdfParams.argon2id();

  Map<String, dynamic> toJson() => {
        'alg': algorithm,
        'm': memoryKiB,
        't': iterations,
        'p': parallelism,
      };

  factory KdfParams.fromJson(Map<String, dynamic> json) {
    final alg = json['alg'];
    final m = json['m'];
    final t = json['t'];
    final p = json['p'];
    if (alg != 'argon2id' || m is! int || t is! int || p is! int) {
      throw const FormatException('unsupported app-lock KDF parameters');
    }
    if (p < 1 || m < 8 * p || t < 1) {
      throw const FormatException('invalid app-lock KDF parameters');
    }
    return KdfParams.argon2id(memoryKiB: m, iterations: t, parallelism: p);
  }

  @override
  bool operator ==(Object other) =>
      other is KdfParams &&
      other.algorithm == algorithm &&
      other.memoryKiB == memoryKiB &&
      other.iterations == iterations &&
      other.parallelism == parallelism;

  @override
  int get hashCode => Object.hash(algorithm, memoryKiB, iterations, parallelism);
}

/// What a passcode derives to. Neither half is the passcode, and the
/// passcode itself is never stored anywhere.
class PasscodeKeys {
  /// Stored in the lock record; compared (constant time) on unlock.
  final Uint8List verifier;

  /// Wraps the random data key that encrypts the chat snapshot. Never stored.
  final Uint8List kek;

  const PasscodeKeys({required this.verifier, required this.kek});
}

/// Derives [PasscodeKeys] from a passcode + salt. An interface so widget tests
/// can swap the memory-hard KDF for something instant.
abstract class PasscodeDeriver {
  const PasscodeDeriver();
  Future<PasscodeKeys> derive(String passcode, List<int> salt, KdfParams params);
}

/// Argon2id → 32-byte master → two independent keys via HMAC-SHA256 with
/// distinct labels (a one-block HKDF-expand), so the stored verifier reveals
/// nothing about the key-encryption key.
class Argon2PasscodeDeriver extends PasscodeDeriver {
  /// Run on a background isolate (the default). Tests pass false.
  final bool useIsolate;
  const Argon2PasscodeDeriver({this.useIsolate = true});

  @override
  Future<PasscodeKeys> derive(
    String passcode,
    List<int> salt,
    KdfParams params,
  ) async {
    final saltCopy = Uint8List.fromList(salt);
    final m = params.memoryKiB;
    final t = params.iterations;
    final p = params.parallelism;
    final master = useIsolate
        ? await Isolate.run(
            () => argon2id(passcode, saltCopy, memoryKiB: m, iterations: t, parallelism: p),
            debugName: 'app-lock-kdf',
          )
        : await argon2id(passcode, saltCopy, memoryKiB: m, iterations: t, parallelism: p);
    return splitMaster(master);
  }

  /// Raw Argon2id (RFC 9106) of [passcode] with [salt], 32-byte output.
  static Future<Uint8List> argon2id(
    String passcode,
    List<int> salt, {
    required int memoryKiB,
    required int iterations,
    required int parallelism,
  }) async {
    final algorithm = DartArgon2id(
      parallelism: parallelism,
      memory: memoryKiB,
      iterations: iterations,
      hashLength: 32,
      // Compute right here: callers already run this off the UI isolate, and
      // at p=1 a nested isolate (plus an FFI buffer) buys nothing.
      maxIsolates: 0,
    );
    final key = await algorithm.deriveKey(
      secretKey: SecretKey(utf8.encode(passcode)),
      nonce: salt,
    );
    return Uint8List.fromList(await key.extractBytes());
  }

  /// Split a 32-byte master secret into the verifier and the KEK.
  static PasscodeKeys splitMaster(List<int> master) => PasscodeKeys(
        verifier: labelledKey(master, 'talon.applock.verifier.v1'),
        kek: labelledKey(master, 'talon.applock.kek.v1'),
      );

  static Uint8List labelledKey(List<int> key, String label) => Uint8List.fromList(
        crypto.Hmac(crypto.sha256, key).convert(utf8.encode(label)).bytes,
      );
}

/// Constant-time equality for secrets (length is not secret).
bool constantTimeEquals(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}
