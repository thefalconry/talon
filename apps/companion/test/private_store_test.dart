import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/services/private_store.dart';

/// The Linux settings file holds the bridge token and recent chats; it (and
/// its directory) must end up readable by the current user only.
void main() {
  // chmod semantics are POSIX; the store only acts on Linux anyway.
  final posix = Platform.isLinux || Platform.isMacOS;

  int modeOf(String path) => FileStat.statSync(path).mode & 0x1ff;

  late Directory tmp;
  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('talon-private-store-');
  });
  tearDown(() async {
    Prefs.privateStore = null;
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  test('restricts an existing store to the owner', () async {
    final dir = Directory('${tmp.path}/support');
    await dir.create();
    final file = File('${dir.path}/${PrivateStore.prefsFileName}');
    await file.writeAsString('{}');
    await Process.run('chmod', ['755', dir.path]);
    await Process.run('chmod', ['644', file.path]);

    await PrivateStore(supportDir: () async => dir.path, applies: () => true)
        .harden();

    expect(modeOf(dir.path), 0x1c0); // 0700
    expect(modeOf(file.path), 0x180); // 0600
  }, skip: !posix);

  test('restricts an existing chat snapshot file too', () async {
    final dir = Directory('${tmp.path}/support');
    await dir.create();
    final file = File('${dir.path}/${PrivateStore.snapshotFileName}');
    await file.writeAsString('{}');
    await Process.run('chmod', ['644', file.path]);

    await PrivateStore(supportDir: () async => dir.path, applies: () => true)
        .harden();

    expect(modeOf(file.path), 0x180); // 0600
  }, skip: !posix);

  test('the snapshot writer creates a private file and directory', () {
    final dir = '${tmp.path}/fresh/support';
    final path = '$dir/${PrivateStore.snapshotFileName}';
    writeSnapshotFile(path, {'chats': []});
    writeSnapshotFile(path, {'chats': [1]});

    expect(File(path).readAsStringSync(), '{"chats":[1]}');
    expect(modeOf(path), 0x180); // 0600
    expect(modeOf(dir), 0x1c0); // 0700
    expect(File('$path.tmp').existsSync(), isFalse);
  }, skip: !Platform.isLinux);

  test('creates a missing directory already private', () async {
    final path = '${tmp.path}/nested/support';
    await PrivateStore(supportDir: () async => path, applies: () => true)
        .harden();
    expect(Directory(path).existsSync(), isTrue);
    expect(modeOf(path), 0x1c0);
  }, skip: !posix);

  test('does nothing where the platform already scopes it', () async {
    var asked = false;
    await PrivateStore(
      supportDir: () async {
        asked = true;
        return tmp.path;
      },
      applies: () => false,
    ).harden();
    expect(asked, isFalse);
  });

  test('never throws when the directory cannot be resolved', () async {
    await PrivateStore(
      supportDir: () async => throw StateError('no support dir'),
      applies: () => true,
    ).harden();
  });

  test('saving the connection re-applies the restriction', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final dir = Directory('${tmp.path}/support');
    await dir.create();
    final file = File('${dir.path}/${PrivateStore.prefsFileName}');
    await file.writeAsString('{}');
    await Process.run('chmod', ['644', file.path]);
    Prefs.privateStore =
        PrivateStore(supportDir: () async => dir.path, applies: () => true);

    await prefs.setConnection(const ConnectionConfig(host: '10.0.0.2'));

    expect(modeOf(file.path), 0x180);
  }, skip: !posix);
}
