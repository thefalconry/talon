import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/attachment_opener.dart';

/// File chips download with the Authorization header and open the local
/// copy, so the bridge token never appears in a URL handed to another app.
void main() {
  late Directory cache;
  late HttpServer server;
  final requests = <HttpRequest>[];
  final launched = <(String, String)>[];

  setUp(() async {
    cache = Directory.systemTemp.createTempSync('talon-attach-open');
    requests.clear();
    launched.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      requests.add(req);
      final ok =
          req.headers.value(HttpHeaders.authorizationHeader) == 'Bearer secret';
      if (!ok) {
        req.response.statusCode = 401;
      } else {
        req.response.write('file-bytes:${req.uri.queryParameters['id']}');
      }
      await req.response.close();
    });
  });

  tearDown(() async {
    await server.close(force: true);
    cache.deleteSync(recursive: true);
  });

  AttachmentOpener opener({bool launchOk = true}) => AttachmentOpener(
        cacheRoot: () async => cache,
        launch: (file, mime) async {
          launched.add((file.path, mime));
          return launchOk;
        },
      );

  String url(String id) => 'http://127.0.0.1:${server.port}/media?id=$id';

  test('downloads with the auth header and opens the local copy', () async {
    final file = await opener().open(
      url: url('a'),
      name: 'report.pdf',
      mimeType: 'application/pdf',
      headers: const {'Authorization': 'Bearer secret'},
    );

    expect(requests, hasLength(1));
    expect(requests.single.uri.queryParameters, {'id': 'a'});
    expect(await file.readAsString(), 'file-bytes:a');
    expect(file.path, endsWith('${Platform.pathSeparator}report.pdf'));
    expect(file.path, startsWith(cache.path));
    expect(launched, [(file.path, 'application/pdf')]);
  });

  test('a second tap reuses the download', () async {
    final o = opener();
    const auth = {'Authorization': 'Bearer secret'};
    final first = await o.open(
        url: url('b'), name: 'x.txt', mimeType: 't', headers: auth);
    final second = await o.open(
        url: url('b'), name: 'x.txt', mimeType: 't', headers: auth);
    expect(second.path, first.path);
    expect(requests, hasLength(1));
    expect(launched, hasLength(2));
  });

  test('same name, different media ids do not collide', () async {
    const auth = {'Authorization': 'Bearer secret'};
    final a =
        await opener().fetch(url: url('1'), name: 'logs.zip', headers: auth);
    final b =
        await opener().fetch(url: url('2'), name: 'logs.zip', headers: auth);
    expect(a.path, isNot(b.path));
    expect(await a.readAsString(), 'file-bytes:1');
    expect(await b.readAsString(), 'file-bytes:2');
  });

  test('a refused download throws and leaves nothing behind', () async {
    await expectLater(
      opener().open(url: url('c'), name: 'c.bin', mimeType: 'x'),
      throwsA(isA<AttachmentException>()),
    );
    expect(launched, isEmpty);
    final leftovers = cache
        .listSync(recursive: true)
        .whereType<File>()
        .map((f) => f.path)
        .toList();
    expect(leftovers, isEmpty);
  });

  test('no app to open it is reported', () async {
    await expectLater(
      opener(launchOk: false).open(
        url: url('d'),
        name: 'd.bin',
        mimeType: 'x',
        headers: const {'Authorization': 'Bearer secret'},
      ),
      throwsA(isA<AttachmentException>()),
    );
  });

  test('names become one safe path segment', () {
    expect(AttachmentOpener.safeName('report.pdf'), 'report.pdf');
    expect(AttachmentOpener.safeName('../../etc/passwd'), '_.._etc_passwd');
    expect(AttachmentOpener.safeName('..'), 'attachment');
    expect(AttachmentOpener.safeName(''), 'attachment');
    expect(AttachmentOpener.safeName(r'a\b:c'), 'a_b_c');
  });
}
