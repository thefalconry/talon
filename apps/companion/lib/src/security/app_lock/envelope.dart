import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart'
    show Mac, SecretBox, SecretBoxAuthenticationError, SecretKeyData;
import 'package:cryptography/dart.dart' show DartAesGcm;

/// AES-256-GCM sealing for everything the app lock keeps at rest: the data
/// key (wrapped with the passcode-derived key) and the chat snapshot
/// (encrypted with the data key).
///
/// The output is a small self-describing JSON string —
/// `{"v":1,"n":<nonce>,"c":<ciphertext>,"t":<tag>}`, base64 — so it can live
/// in a secure-store value or a file alike. Every seal uses a fresh random
/// 96-bit nonce; [aad] binds the ciphertext to its purpose, so a wrapped key
/// can't be passed off as a snapshot or the other way round.
///
/// Synchronous on purpose: callers decide whether a payload is big enough to
/// move to a background isolate (the snapshot is; a 32-byte key is not).
class Envelope {
  Envelope._();

  static const int version = 1;
  static const int keyLength = 32;

  static final DartAesGcm _aes = DartAesGcm.with256bits();
  static final Random _random = Random.secure();

  /// Cryptographically random bytes (keys, salts, nonces).
  static Uint8List randomBytes(int length) {
    final out = Uint8List(length);
    for (var i = 0; i < length; i++) {
      out[i] = _random.nextInt(256);
    }
    return out;
  }

  static String seal(List<int> key, List<int> plaintext, {required String aad}) {
    _checkKey(key);
    final box = _aes.encryptSync(
      plaintext,
      secretKeyData: SecretKeyData(key),
      nonce: randomBytes(12),
      aad: utf8.encode(aad),
    );
    return jsonEncode({
      'v': version,
      'n': base64Encode(box.nonce),
      'c': base64Encode(box.cipherText),
      't': base64Encode(box.mac.bytes),
    });
  }

  /// Decrypt an envelope made by [seal]. Throws [EnvelopeException] when the
  /// input is malformed, sealed for another purpose, or was sealed with a
  /// different key (GCM authentication fails) — never returns garbage.
  static Uint8List open(List<int> key, String envelope, {required String aad}) {
    _checkKey(key);
    final Map<String, dynamic> json;
    try {
      final decoded = jsonDecode(envelope);
      if (decoded is! Map) throw const FormatException('not an object');
      json = decoded.cast<String, dynamic>();
    } on FormatException {
      throw const EnvelopeException('malformed envelope');
    }
    if (json['v'] != version) {
      throw const EnvelopeException('unsupported envelope version');
    }
    final List<int> nonce;
    final List<int> cipherText;
    final List<int> tag;
    try {
      nonce = base64Decode(json['n'] as String);
      cipherText = base64Decode(json['c'] as String);
      tag = base64Decode(json['t'] as String);
    } catch (_) {
      throw const EnvelopeException('malformed envelope');
    }
    try {
      final clear = _aes.decryptSync(
        SecretBox(cipherText, nonce: nonce, mac: Mac(tag)),
        secretKeyData: SecretKeyData(key),
        aad: utf8.encode(aad),
      );
      return Uint8List.fromList(clear);
    } on SecretBoxAuthenticationError {
      throw const EnvelopeException('authentication failed');
    } on ArgumentError {
      throw const EnvelopeException('malformed envelope');
    }
  }

  static void _checkKey(List<int> key) {
    if (key.length != keyLength) {
      throw ArgumentError.value(key.length, 'key', 'expected $keyLength bytes');
    }
  }
}

class EnvelopeException implements Exception {
  final String message;
  const EnvelopeException(this.message);
  @override
  String toString() => 'EnvelopeException: $message';
}
