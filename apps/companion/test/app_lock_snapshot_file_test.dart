import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/security/app_lock/secret_store.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/services/private_store.dart';

/// The app lock and the offline snapshot's own file (#1059): with the lock
/// on, no plaintext snapshot may stay on disk, and the sealed copy is
/// written like the plaintext one — atomically, owner-only, off the UI
/// isolate.
void main() {
  late Directory tmp;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    tmp = await Directory.systemTemp.createTemp('talon-lock-snapshot-');
  });

  tearDown(() async {
    Prefs.sealedSnapshotSink = null;
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  File plainFile() => File('${tmp.path}/${PrivateStore.snapshotFileName}');

  Future<Prefs> prefsWithFile() async =>
      Prefs(await SharedPreferences.getInstance(), snapshotFile: plainFile());

  test('turning the lock on removes the plaintext snapshot file', () async {
    final prefs = await prefsWithFile();
    await prefs.saveSnapshot({
      'chats': [1],
    });
    expect(plainFile().existsSync(), isTrue);
    expect(prefs.snapshot, {
      'chats': [1],
    });

    await prefs.setAppLockEnabled(true);
    await prefs.clearPlainSnapshot();

    expect(plainFile().existsSync(), isFalse);
    expect(File('${plainFile().path}.tmp').existsSync(), isFalse);
    expect(prefs.snapshot, isNull);
  });

  test('while locked, saves go to the sealed sink and never to the file',
      () async {
    final prefs = await prefsWithFile();
    await prefs.setAppLockEnabled(true);
    Map<String, dynamic>? sealed;
    Prefs.sealedSnapshotSink = (snapshot) async {
      sealed = snapshot;
    };

    await prefs.saveSnapshot({
      'chats': [2],
    });

    expect(sealed, {
      'chats': [2],
    });
    expect(plainFile().existsSync(), isFalse);
    expect(prefs.snapshot, isNull);
  });

  test('the sealed snapshot file is replaced atomically and privately',
      () async {
    final dir = '${tmp.path}/support';
    final store = FileSealedSnapshotStore(dir: () async => dir);
    await store.write('sealed-1');
    await store.write('sealed-2');

    expect(await store.read(), 'sealed-2');
    final path = '$dir/${PrivateStore.sealedSnapshotFileName}';
    expect(File('$path.tmp').existsSync(), isFalse);
    if (Platform.isLinux) {
      expect(FileStat.statSync(path).mode & 0x1ff, 0x180); // 0600
      expect(FileStat.statSync(dir).mode & 0x1ff, 0x1c0); // 0700
    }

    await store.delete();
    expect(await store.read(), isNull);
  });
}
