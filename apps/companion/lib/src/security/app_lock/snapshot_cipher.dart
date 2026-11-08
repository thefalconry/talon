import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'envelope.dart';

/// Encrypts / decrypts the offline chat snapshot with the app lock's data
/// key. A thin, storage-agnostic layer on purpose: it turns a snapshot map
/// into an opaque string and back, and leaves *where* that string lives to
/// the caller — today [SealedSnapshotStore]'s file, tomorrow whatever file
/// the snapshot moves to (#1059) — so whoever owns snapshot storage can adopt
/// it by routing their encode/decode through [seal] / [open].
class SnapshotCipher {
  /// Purpose binding for snapshot envelopes (see [Envelope]).
  static const String aad = 'talon.snapshot.v1';

  /// Snapshots up to this size are sealed on the calling isolate; bigger ones
  /// (JSON encode + AES-GCM over hundreds of KB) move off the UI isolate.
  static const int inlineLimitBytes = 16 * 1024;

  final bool useIsolate;
  const SnapshotCipher({this.useIsolate = true});

  Future<String> seal(Uint8List dataKey, Map<String, dynamic> snapshot) async {
    final key = Uint8List.fromList(dataKey);
    if (!useIsolate) return sealSync(key, snapshot);
    return Isolate.run(() => sealSync(key, snapshot), debugName: 'snapshot-seal');
  }

  Future<Map<String, dynamic>> open(Uint8List dataKey, String sealed) async {
    final key = Uint8List.fromList(dataKey);
    if (!useIsolate || sealed.length <= inlineLimitBytes) {
      return openSync(key, sealed);
    }
    return Isolate.run(() => openSync(key, sealed), debugName: 'snapshot-open');
  }

  static String sealSync(List<int> dataKey, Map<String, dynamic> snapshot) =>
      Envelope.seal(dataKey, utf8.encode(jsonEncode(snapshot)), aad: aad);

  /// Throws [EnvelopeException] for a wrong key / tampered file and
  /// [FormatException] if the decrypted payload isn't a snapshot object.
  static Map<String, dynamic> openSync(List<int> dataKey, String sealed) {
    final clear = Envelope.open(dataKey, sealed, aad: aad);
    final decoded = jsonDecode(utf8.decode(clear));
    if (decoded is! Map) throw const FormatException('snapshot is not an object');
    return decoded.cast<String, dynamic>();
  }
}
