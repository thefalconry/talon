import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:path/path.dart' as p;
import 'package:talon_companion/src/services/model_manager.dart';

/// A fake artifact server: serves [body], honours `Range` when [ranges] is
/// on, and can cut the stream short after [failAfter] bytes.
class _Server {
  _Server(this.body);

  final Uint8List body;
  bool ranges = true;
  int? failAfter;
  int status = 200;
  final requests = <http.BaseRequest>[];

  http.Client client() => MockClient.streaming((request, _) async {
        requests.add(request);
        if (status != 200) {
          return http.StreamedResponse(const Stream.empty(), status);
        }
        var start = 0;
        final range = request.headers['Range'];
        if (ranges && range != null) {
          start = int.parse(RegExp(r'bytes=(\d+)-').firstMatch(range)!.group(1)!);
        }
        final slice = body.sublist(start);
        final cut = failAfter;
        failAfter = null; // Only the first response fails.
        Stream<List<int>> stream() async* {
          const chunk = 1000;
          for (var i = 0; i < slice.length; i += chunk) {
            if (cut != null && i >= cut) {
              throw http.ClientException('Connection reset by peer');
            }
            yield slice.sublist(i, math.min(i + chunk, slice.length));
          }
        }

        return http.StreamedResponse(
          stream(),
          start > 0 ? 206 : 200,
          contentLength: slice.length,
        );
      });
}

Uint8List _bytes(int n) =>
    Uint8List.fromList(List.generate(n, (i) => (i * 31 + 7) & 0xff));

String _sha(List<int> b) => sha256.convert(b).toString();

/// Unpacker stand-in: writes the files a spec requires, so manager tests
/// need no real archive.
Future<void> _fakeUnpack(ModelSpec spec, File artifact, Directory dest) async {
  final root = spec.archiveRoot == null
      ? dest
      : Directory(p.join(dest.path, spec.archiveRoot));
  for (final rel in spec.requiredFiles) {
    final f = File(p.join(root.path, rel));
    await f.parent.create(recursive: true);
    await f.writeAsString('x');
  }
}

ModelSpec _spec(Uint8List body, {String? sha}) => ModelSpec(
      id: 'test-model',
      label: 'Test model',
      url: Uri.parse('https://models.example/test-model.tar.bz2'),
      sha256: sha ?? _sha(body),
      sizeBytes: body.length,
      packaging: ModelPackaging.tarBz2,
      archiveRoot: 'test-model',
      requiredFiles: const ['model.onnx', 'data/phontab'],
    );

void main() {
  late Directory root;
  late _Server server;
  late int clients;
  late Uint8List body;

  ModelManager manager({ModelUnpacker? unpacker}) => ModelManager(
        root: () async => root,
        httpClient: () {
          clients++;
          return server.client();
        },
        unpacker: unpacker ?? _fakeUnpack,
        progressInterval: Duration.zero,
      );

  File partial(ModelSpec spec) => File(p.join(root.path, '${spec.id}.download'));

  setUp(() async {
    root = await Directory.systemTemp.createTemp('models');
    body = _bytes(10000);
    server = _Server(body);
    clients = 0;
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  test('downloads, verifies, unpacks and reports installed', () async {
    final spec = _spec(body);
    final models = manager();
    final phases = <ModelPhase>[];
    models.addListener(() => phases.add(models.status(spec).phase));

    expect(await models.installedPath(spec), isNull);
    expect(await models.install(spec), isTrue);

    final dir = await models.installedPath(spec);
    expect(dir, p.join(root.path, 'test-model'));
    expect(File(p.join(dir!, 'model.onnx')).existsSync(), isTrue);
    expect(File(p.join(dir, 'data', 'phontab')).existsSync(), isTrue);
    expect(models.status(spec).installed, isTrue);
    expect(partial(spec).existsSync(), isFalse, reason: 'artifact removed');
    expect(
      Directory(p.join(root.path, 'test-model.staging')).existsSync(),
      isFalse,
    );
    expect(phases, containsAllInOrder([
      ModelPhase.downloading,
      ModelPhase.verifying,
      ModelPhase.extracting,
      ModelPhase.installed,
    ]));
    final marker = jsonDecode(
      File(p.join(dir, '.talon-model.json')).readAsStringSync(),
    ) as Map;
    expect(marker['sha256'], spec.sha256);
  });

  test('rejects a SHA-256 mismatch and deletes the download', () async {
    final spec = _spec(body, sha: 'f' * 64);
    final models = manager();

    expect(await models.install(spec), isFalse);
    final status = models.status(spec);
    expect(status.phase, ModelPhase.failed);
    expect(status.error, contains('Checksum mismatch'));
    expect(partial(spec).existsSync(), isFalse);
    expect(await models.installedPath(spec), isNull);
    expect(Directory(p.join(root.path, 'test-model')).existsSync(), isFalse);
  });

  test('an interrupted download keeps the partial file and resumes it',
      () async {
    final spec = _spec(body);
    final models = manager();
    server.failAfter = 4000;

    expect(await models.install(spec), isFalse);
    expect(models.status(spec).phase, ModelPhase.failed);
    expect(models.status(spec).error, contains('interrupted'));
    expect(await models.installedPath(spec), isNull);
    expect(partial(spec).lengthSync(), 4000);

    expect(await models.install(spec), isTrue);
    expect(server.requests.last.headers['Range'], 'bytes=4000-');
    expect(await models.installedPath(spec), isNotNull);
  });

  test('restarts from zero when the server ignores the range request',
      () async {
    final spec = _spec(body);
    final models = manager();
    server
      ..failAfter = 3000
      ..ranges = false;
    expect(await models.install(spec), isFalse);

    expect(await models.install(spec), isTrue);
    expect(await models.installedPath(spec), isNotNull);
  });

  test('a short stream that ends cleanly is still an interruption', () async {
    final spec = ModelSpec(
      id: 'short',
      label: 'Short',
      url: Uri.parse('https://models.example/short.bin'),
      sha256: _sha(body),
      sizeBytes: body.length + 10,
      packaging: ModelPackaging.file,
      fileName: 'short.bin',
    );
    final models = manager();
    expect(await models.install(spec), isFalse);
    expect(models.status(spec).error, contains('interrupted'));
  });

  test('an HTTP error fails without creating anything', () async {
    final spec = _spec(body);
    server.status = 404;
    final models = manager();
    expect(await models.install(spec), isFalse);
    expect(models.status(spec).error, contains('HTTP 404'));
    expect(await models.installedPath(spec), isNull);
  });

  test('skips the network when already installed', () async {
    final spec = _spec(body);
    expect(await manager().install(spec), isTrue);
    expect(clients, 1);

    // A fresh manager (app restart) sees the install on disk.
    final again = manager();
    expect((await again.refresh(spec)).installed, isTrue);
    expect(await again.install(spec), isTrue);
    expect(clients, 1, reason: 'no second download');
  });

  test('an install missing a required file is not considered installed',
      () async {
    final spec = _spec(body);
    final models = manager();
    await models.install(spec);
    File(p.join(root.path, 'test-model', 'model.onnx')).deleteSync();
    expect(await models.installedPath(spec), isNull);
  });

  test('concurrent installs share one download', () async {
    final spec = _spec(body);
    final models = manager();
    final results = await Future.wait([models.install(spec), models.install(spec)]);
    expect(results, [true, true]);
    expect(clients, 1);
  });

  test('cancel pauses with the partial kept; install resumes', () async {
    final spec = _spec(body);
    final models = manager();
    models.addListener(() {
      final s = models.status(spec);
      if (s.phase == ModelPhase.downloading && s.receivedBytes >= 2000) {
        models.cancel(spec);
      }
    });
    expect(await models.install(spec), isFalse);
    final status = models.status(spec);
    expect(status.phase, ModelPhase.absent);
    expect(status.receivedBytes, greaterThan(0));
    expect(partial(spec).existsSync(), isTrue);

    final fresh = manager();
    expect(await fresh.install(spec), isTrue);
  });

  test('delete removes the model and any partial download', () async {
    final spec = _spec(body);
    final models = manager();
    await models.install(spec);
    await partial(spec).writeAsBytes([1, 2, 3]);

    await models.delete(spec);
    expect(await models.installedPath(spec), isNull);
    expect(partial(spec).existsSync(), isFalse);
    expect(Directory(p.join(root.path, 'test-model')).existsSync(), isFalse);
    expect(models.status(spec).phase, ModelPhase.absent);
  });

  test('a failing unpack leaves nothing installed', () async {
    final spec = _spec(body);
    final models = manager(
      unpacker: (spec, artifact, dest) async =>
          throw const ModelInstallException('corrupt archive'),
    );
    expect(await models.install(spec), isFalse);
    expect(models.status(spec).error, 'corrupt archive');
    expect(await models.installedPath(spec), isNull);
    expect(
      Directory(p.join(root.path, 'test-model.staging')).existsSync(),
      isFalse,
    );
  });

  group('tar.bz2 unpacking', () {
    Uint8List tarBz2(Map<String, String> files) {
      final archive = Archive();
      for (final e in files.entries) {
        archive.add(ArchiveFile.bytes(e.key, utf8.encode(e.value)));
      }
      return Uint8List.fromList(
        BZip2Encoder().encodeBytes(TarEncoder().encodeBytes(archive)),
      );
    }

    test('installs a real archive end to end', () async {
      final archive = tarBz2({
        'test-model/model.onnx': 'weights',
        'test-model/data/phontab': 'phonemes',
        'test-model/README.md': 'hello',
      });
      server = _Server(archive);
      final spec = _spec(archive);
      final models = manager(unpacker: unpackInIsolate);

      expect(await models.install(spec), isTrue);
      final dir = (await models.installedPath(spec))!;
      expect(File(p.join(dir, 'model.onnx')).readAsStringSync(), 'weights');
      expect(File(p.join(dir, 'data', 'phontab')).readAsStringSync(), 'phonemes');
      expect(File(p.join(dir, 'README.md')).readAsStringSync(), 'hello');
    });

    test('refuses entries that escape the model directory', () async {
      final archive = tarBz2({'../evil.txt': 'nope'});
      final artifact = File(p.join(root.path, 'evil.tar.bz2'))
        ..writeAsBytesSync(archive);
      final out = Directory(p.join(root.path, 'out'))..createSync();
      expect(
        () => extractTarBz2(artifact.path, out.path),
        throwsA(isA<ModelInstallException>()),
      );
      expect(File(p.join(root.path, 'evil.txt')).existsSync(), isFalse);
    });
  });
}
