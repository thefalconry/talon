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
        // Optional headers a link-download test can steer: `ct` sets the
        // Content-Type, `fn` sets a Content-Disposition filename.
        final ct = req.uri.queryParameters['ct'];
        if (ct != null) req.response.headers.contentType = ContentType.parse(ct);
        final fn = req.uri.queryParameters['fn'];
        if (fn != null) {
          req.response.headers
              .set('content-disposition', 'attachment; filename="$fn"');
        }
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

  // A bare `/media?id=…` link in message text carries no name or MIME, so
  // openLink recovers both from the response and opens the local copy.
  test('openLink names the file from Content-Disposition and opens it',
      () async {
    final file = await opener().openLink(
      url: '${url('z')}&ct=application/pdf&fn=invoice.pdf',
      headers: const {'Authorization': 'Bearer secret'},
    );

    expect(requests, hasLength(1));
    expect(await file.readAsString(), 'file-bytes:z');
    expect(file.path, endsWith('${Platform.pathSeparator}invoice.pdf'));
    expect(launched, [(file.path, 'application/pdf')]);
  });

  test('openLink falls back to the media id plus a MIME extension', () async {
    final file = await opener().openLink(
      url: '${url('mmuk3t31w')}&ct=application/zip',
      headers: const {'Authorization': 'Bearer secret'},
    );

    expect(file.path, endsWith('${Platform.pathSeparator}mmuk3t31w.zip'));
    expect(launched.single.$2, 'application/zip');
  });

  test('openLink without the auth header is refused and opens nothing',
      () async {
    await expectLater(
      opener().openLink(url: url('q')),
      throwsA(isA<AttachmentException>()),
    );
    expect(launched, isEmpty);
  });

  test('nameFromResponse prefers disposition, then id, then a default', () {
    String n(Map<String, String> h, String ct, {String u = 'http://x/media?id=abc'}) =>
        AttachmentOpener.nameFromResponse(u, h, ct);

    expect(n({'content-disposition': 'attachment; filename="a.pdf"'}, 'x'),
        'a.pdf');
    expect(n(const {}, 'application/zip'), 'abc.zip');
    expect(n(const {}, 'application/octet-stream'), 'abc');
    expect(n(const {}, 'image/png', u: 'http://x/media'), 'media.png');
    expect(n(const {}, 'text/x-patch', u: 'http://x/media?id=mmuk3t376'),
        'mmuk3t376.patch');
    expect(n(const {}, 'text/x-diff', u: 'http://x/media?id=mmuk3t376'),
        'mmuk3t376.diff');
    expect(
        n(const {}, 'text/x-patch',
            u: 'http://x/media?id=m1&filename=0001-fix.patch'),
        '0001-fix.patch');
    expect(
        n({'content-disposition': 'attachment; filename="0001-fix.patch"'},
            'text/x-diff'),
        '0001-fix.patch');
  });

  test('openLink with explicit name uses the declared name', () async {
    final file = await opener().openLink(
      url: '${url('m42')}&ct=text/x-diff',
      name: '0001-fix.patch',
      headers: const {'Authorization': 'Bearer secret'},
    );

    expect(file.path, endsWith('${Platform.pathSeparator}0001-fix.patch'));
  });

  test('save copies the download into Downloads without overwriting',
      () async {
    final downloads = Directory.systemTemp.createTempSync('talon-dl-');
    addTearDown(() => downloads.deleteSync(recursive: true));
    File('${downloads.path}${Platform.pathSeparator}report.pdf')
        .writeAsStringSync('older file');
    final o = AttachmentOpener(
      cacheRoot: () async => cache,
      launch: (file, mime) async => true,
      downloadsRoot: () async => downloads,
    );
    final saved = await o.save(
      url: url('s'),
      name: 'report.pdf',
      mimeType: 'application/pdf',
      headers: const {'Authorization': 'Bearer secret'},
    );
    expect(saved.location, endsWith('report (1).pdf'));
    expect(File(saved.location).existsSync(), isTrue);
    // The existing file is untouched.
    expect(
      File('${downloads.path}${Platform.pathSeparator}report.pdf')
          .readAsStringSync(),
      'older file',
    );
  });

  test('save reports a missing Downloads folder instead of pretending',
      () async {
    final o = AttachmentOpener(
      cacheRoot: () async => cache,
      launch: (file, mime) async => true,
      downloadsRoot: () async => null,
    );
    await expectLater(
      o.save(
        url: url('t'),
        name: 't.bin',
        mimeType: 'application/octet-stream',
        headers: const {'Authorization': 'Bearer secret'},
      ),
      throwsA(isA<AttachmentException>()),
    );
  });

  test('uniqueTarget counts up before the extension', () {
    final dir = Directory.systemTemp.createTempSync('talon-uniq-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final sep = Platform.pathSeparator;
    expect(AttachmentOpener.uniqueTarget(dir, 'a.txt').path,
        '${dir.path}${sep}a.txt');
    File('${dir.path}${sep}a.txt').writeAsStringSync('x');
    File('${dir.path}${sep}a (1).txt').writeAsStringSync('x');
    expect(AttachmentOpener.uniqueTarget(dir, 'a.txt').path,
        '${dir.path}${sep}a (2).txt');
    File('${dir.path}${sep}noext').writeAsStringSync('x');
    expect(AttachmentOpener.uniqueTarget(dir, 'noext').path,
        '${dir.path}${sep}noext (1)');
  });
}
