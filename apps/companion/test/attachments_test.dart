import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/state/composer_attachments.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/composer.dart';
import 'package:talon_companion/src/ui/message_bubble.dart';

/// Attaching files of any type: what the composer stages, what it uploads on
/// send, and how a message renders the files that came back.
void main() {
  late Directory tmp;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('talon-attach-test');
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  /// A real file on disk — staging reads its length, and the send streams it.
  File write(String name, [int bytes = 32]) {
    final file = File('${tmp.path}${Platform.pathSeparator}$name');
    file.writeAsBytesSync(List.filled(bytes, 0x41));
    return file;
  }

  Widget host(Widget child) => MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, c) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: c!,
        ),
        home: Scaffold(body: child),
      );

  /// Staged files upload off real files on disk, so the I/O has to run
  /// outside the fake-async zone before the resulting frames can be pumped.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 40)),
      );
      await tester.pump();
    }
  }

  Future<void> settleSend(WidgetTester tester) async {
    await tester.tap(find.bySemanticsLabel('Send message'));
    await settle(tester);
  }

  /// An uploader that answers with the daemon record the real bridge would.
  UploadFile uploaderRecording(
    List<String> names, {
    List<int>? streamedBytes,
    bool Function(String filename)? failFor,
  }) =>
      (bytes, length, filename, contentType, {onProgress}) async {
        names.add(filename);
        streamedBytes?.add(await bytes.expand((c) => c).length);
        if (failFor?.call(filename) ?? false) return null;
        onProgress?.call(length);
        return Attachment(
          path: '/uploads/$filename',
          name: filename,
          size: length,
          mimeType: contentType,
          url: '/media?id=$filename',
          image: contentType.startsWith('image/'),
        );
      };

  group('mime typing', () {
    test('types the files people actually attach, images apart', () {
      expect(mimeTypeFor('photo.PNG'), 'image/png');
      expect(mimeTypeFor('backup.zip'), 'application/zip');
      expect(mimeTypeFor('report.pdf'), 'application/pdf');
      expect(mimeTypeFor('notes.md'), 'text/markdown');
      expect(mimeTypeFor('clip.mov'), 'video/quicktime');
      expect(mimeTypeFor('app.apk'), 'application/vnd.android.package-archive');
      expect(mimeTypeFor('noextension'), 'application/octet-stream');
      expect(mimeTypeFor('weird.zzz'), 'application/octet-stream');
    });

    test('gives each family its own icon', () {
      expect(iconForMime('image/png'), Icons.image_outlined);
      expect(iconForMime('application/zip'), Icons.folder_zip_outlined);
      expect(iconForMime('application/pdf'), Icons.picture_as_pdf_outlined);
      expect(iconForMime('audio/mpeg'), Icons.audiotrack_outlined);
      expect(iconForMime('text/csv'), Icons.table_chart_outlined);
      expect(
          iconForMime('application/x-thing'), Icons.insert_drive_file_outlined);
    });

    test('formats sizes the way the chips show them', () {
      expect(formatBytes(0), '');
      expect(formatBytes(512), '512 B');
      expect(formatBytes(2048), '2.0 KB');
      expect(formatBytes(84213), '82 KB');
      expect(formatBytes(1048576), '1.0 MB');
    });
  });

  group('staging', () {
    test('stages any file type and refuses duplicates', () {
      final attachments = ComposerAttachments();
      final zip = write('archive.zip', 2048);
      final png = write('shot.png');

      expect(attachments.addPaths([zip.path, png.path]), 2);
      expect(attachments.length, 2);
      expect(attachments.files.map((f) => f.name), ['archive.zip', 'shot.png']);
      expect(attachments.files.first.mimeType, 'application/zip');
      expect(attachments.files.first.isImage, isFalse);
      expect(attachments.files.last.isImage, isTrue);
      expect(attachments.files.first.sizeLabel, '2.0 KB');

      // The same path dropped twice stays one attachment.
      expect(attachments.addPaths([zip.path]), 0);
      expect(attachments.length, 2);
    });

    test('skips directories, empty files and paths that do not exist', () {
      final attachments = ComposerAttachments();
      final dir = Directory('${tmp.path}${Platform.pathSeparator}folder')
        ..createSync();
      final empty = File('${tmp.path}${Platform.pathSeparator}empty.txt')
        ..writeAsBytesSync(const []);

      expect(
        attachments.addPaths([dir.path, empty.path, '/nope/missing.bin']),
        0,
      );
      expect(attachments.isEmpty, isTrue);
    });

    test('removing and restoring keeps the list', () async {
      final names = <String>[];
      final attachments = ComposerAttachments()
        ..uploader = uploaderRecording(names);
      attachments.addPaths([write('a.zip').path, write('b.zip').path]);
      final staged = attachments.files.toList();
      await Future<void>.delayed(const Duration(milliseconds: 60));

      attachments.remove(staged.first);
      expect(attachments.files.map((f) => f.name), ['b.zip']);

      attachments.restore(staged);
      expect(attachments.files.map((f) => f.name), ['a.zip', 'b.zip']);
      expect(attachments.uploading, isFalse);
    });

    test('uploads each file as it is staged, exactly once', () async {
      final names = <String>[];
      final attachments = ComposerAttachments()
        ..uploader = uploaderRecording(names);

      attachments.addPaths([write('a.zip').path, write('b.zip').path]);
      // Nothing is sendable until the bytes are actually up.
      expect(attachments.ready, isFalse);
      await Future<void>.delayed(const Duration(milliseconds: 60));

      expect(names, ['a.zip', 'b.zip']);
      expect(attachments.ready, isTrue);
      expect(
        attachments.uploadedAttachments.map((a) => a.name),
        ['a.zip', 'b.zip'],
      );

      // A failed send hands the files back. Their uploads are still good, so
      // nothing goes up a second time — the bug that put four copies of one
      // deck in the uploads dir.
      final staged = attachments.files.toList();
      attachments.clear();
      attachments.restore(staged);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(names, ['a.zip', 'b.zip']);
    });

    test('a failed upload blocks the send until it is retried', () async {
      final names = <String>[];
      var attempts = 0;
      final attachments = ComposerAttachments()
        ..uploader = uploaderRecording(names, failFor: (_) => ++attempts == 1);

      attachments.addPaths([write('a.zip').path]);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(attachments.hasFailures, isTrue);
      expect(attachments.ready, isFalse);
      expect(attachments.files.single.failed, isTrue);

      attachments.retry(attachments.files.single);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(attachments.ready, isTrue);
      expect(attachments.hasFailures, isFalse);
      expect(names.length, 2);
    });

    test('stages but does not upload without an uploader', () async {
      final attachments = ComposerAttachments();
      attachments.addPaths([write('a.zip').path]);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(attachments.length, 1);
      expect(attachments.ready, isFalse);
      expect(attachments.uploading, isFalse);
    });
  });

  group('the composer', () {
    testWidgets('sends every staged file and clears the strip', (tester) async {
      final uploadedNames = <String>[];
      final streamedBytes = <int>[];
      final attachments = ComposerAttachments()
        ..uploader =
            uploaderRecording(uploadedNames, streamedBytes: streamedBytes);
      attachments.addPaths([write('archive.zip', 64).path, write('s.png').path]);
      List<Attachment>? sentWith;

      await tester.pumpWidget(host(Composer(
        onSend: (text, {attachments = const []}) async {
          sentWith = attachments;
          return true;
        },
        attachments: attachments,
        enabled: true,
      )));

      // Both staged files are visible, and both went up on staging — before
      // anything was sent.
      expect(find.text('archive.zip'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Remove archive.zip')),
          findsOneWidget);
      await settle(tester);
      expect(uploadedNames, ['archive.zip', 's.png']);
      // Both uploads run at once, so the smaller file can finish streaming
      // first; what matters is that each one streamed all of its bytes.
      expect(streamedBytes, unorderedEquals([64, 32]));

      await tester.enterText(find.byType(TextField), 'have a look');
      await tester.pump();
      await settleSend(tester);

      // The send carried what the daemon handed back, and uploaded nothing
      // more.
      expect(uploadedNames, ['archive.zip', 's.png']);
      expect(sentWith?.map((a) => a.name), ['archive.zip', 's.png']);
      expect(sentWith?.last.image, isTrue);
      // The strip is empty again and the draft is gone.
      expect(attachments.isEmpty, isTrue);
      expect(find.text('archive.zip'), findsNothing);
    });

    testWidgets('will not send while a file is still uploading',
        (tester) async {
      final release = Completer<Attachment?>();
      final attachments = ComposerAttachments()
        ..uploader = (bytes, length, filename, contentType, {onProgress}) =>
            release.future;
      attachments.addPaths([write('slow.zip').path]);
      var sends = 0;

      await tester.pumpWidget(host(Composer(
        onSend: (text, {attachments = const []}) async {
          sends += 1;
          return true;
        },
        attachments: attachments,
        enabled: true,
      )));
      await settle(tester);

      // The send slot says it is busy rather than offering a live button.
      expect(attachments.uploading, isTrue);
      expect(find.bySemanticsLabel('Sending, files uploading'), findsOneWidget);
      expect(find.bySemanticsLabel('Send message'), findsNothing);

      release.complete(const Attachment(
        path: '/uploads/slow.zip',
        name: 'slow.zip',
        size: 32,
        mimeType: 'application/zip',
        url: '/media?id=slow.zip',
        image: false,
      ));
      await settle(tester);

      // Upload done → the button is live again and the send goes out.
      expect(find.bySemanticsLabel('Send message'), findsOneWidget);
      await settleSend(tester);
      expect(sends, 1);
    });

    testWidgets('keeps the files when a failed upload blocks the send',
        (tester) async {
      final names = <String>[];
      final attachments = ComposerAttachments()
        ..uploader = uploaderRecording(names, failFor: (_) => true);
      attachments.addPaths([write('archive.zip').path]);
      var sends = 0;

      await tester.pumpWidget(host(Composer(
        onSend: (text, {attachments = const []}) async {
          sends += 1;
          return true;
        },
        attachments: attachments,
        enabled: true,
      )));

      await tester.enterText(find.byType(TextField), 'take this');
      await tester.pump();
      await settle(tester);

      // The tile says it failed, the send is refused, nothing is lost.
      expect(attachments.hasFailures, isTrue);
      expect(find.bySemanticsLabel(RegExp('upload failed')), findsOneWidget);
      expect(sends, 0, reason: 'a failed upload must not send the message');
      expect(attachments.files.map((f) => f.name), ['archive.zip']);
      expect(find.text('take this'), findsOneWidget);
    });

    testWidgets('can send files with no message text', (tester) async {
      final names = <String>[];
      final attachments = ComposerAttachments()
        ..uploader = uploaderRecording(names);
      attachments.addPaths([write('solo.zip').path]);
      String? sentText;
      List<Attachment>? sentWith;

      await tester.pumpWidget(host(Composer(
        onSend: (text, {attachments = const []}) async {
          sentText = text;
          sentWith = attachments;
          return true;
        },
        attachments: attachments,
        enabled: true,
      )));

      // Staging alone arms the send button — no text needed.
      await settle(tester);
      await settleSend(tester);

      expect(sentText, '');
      expect(sentWith?.single.name, 'solo.zip');
    });
  });

  group('rendering a message with attachments', () {
    testWidgets('shows a chip per file, and the image inline', (tester) async {
      final message = ClientMessage(
        id: 'm1',
        chatId: 'c1',
        role: Role.user,
        text: 'the build logs',
        ts: DateTime.now().millisecondsSinceEpoch,
        imagePath: '/media?id=shot',
        attachments: const [
          Attachment(
            path: '/uploads/shot.png',
            name: 'shot.png',
            size: 2048,
            mimeType: 'image/png',
            url: '/media?id=shot',
            image: true,
          ),
          Attachment(
            path: '/uploads/logs.zip',
            name: 'logs.zip',
            size: 1048576,
            mimeType: 'application/zip',
            url: '/media?id=logs',
            image: false,
          ),
        ],
      );

      await tester.pumpWidget(host(MessageBubble(
        message: message,
        botName: 'Talon',
        // The first image renders inline from imageUrl; the rest are chips.
        imageUrl: 'http://host/media?id=shot',
        files: const [
          BubbleFile(
            name: 'logs.zip',
            sizeLabel: '1.0 MB',
            mimeType: 'application/zip',
            url: 'http://host/media?id=logs',
          ),
        ],
      )));
      await tester.pump();

      expect(find.text('logs.zip'), findsOneWidget);
      expect(find.text('1.0 MB'), findsOneWidget);
      expect(find.byIcon(Icons.folder_zip_outlined), findsOneWidget);
      expect(
        find.bySemanticsLabel(RegExp('Attached file logs.zip')),
        findsOneWidget,
      );
      // The inline image is not duplicated as a chip.
      expect(find.text('shot.png'), findsNothing);
    });

    testWidgets('parses attachments off the wire', (tester) async {
      final m = ClientMessage.fromJson({
        'id': '7',
        'chatId': 'c1',
        'role': 'user',
        'text': '',
        'ts': 1767225600000,
        'imagePath': '/media?id=m1',
        'attachments': [
          {
            'path': '/uploads/a.png',
            'name': 'a.png',
            'size': 2048,
            'mimeType': 'image/png',
            'url': '/media?id=m1',
            'image': true,
          },
          {
            'path': '/uploads/b.zip',
            'name': 'b.zip',
            'size': 4096,
            'mimeType': 'application/zip',
            'url': '/media?id=m2',
          },
        ],
      });
      expect(m.attachments, hasLength(2));
      expect(m.attachments.first.image, isTrue);
      // `image` omitted by an older daemon falls back to the MIME type.
      expect(m.attachments.last.image, isFalse);
      expect(m.attachments.last.sizeLabel, '4.0 KB');
      expect(m.attachments.first.toRef(),
          {'url': '/media?id=m1', 'path': '/uploads/a.png'});
      // Survives the offline snapshot round trip.
      final snap = ClientMessage.fromJson(m.toSnapshotJson());
      expect(snap.attachments.map((a) => a.name), ['a.png', 'b.zip']);
    });

    testWidgets('selected text in the user bubble uses a visible highlight',
        (tester) async {
      await tester.pumpWidget(host(MessageBubble(
        message: ClientMessage(
          id: 'm3',
          chatId: 'c1',
          role: Role.user,
          text: 'copy me',
          ts: DateTime.now().millisecondsSinceEpoch,
        ),
        botName: 'Talon',
      )));
      await tester.pump();
      final style = DefaultSelectionStyle.of(
          tester.element(find.text('copy me')));
      // Not the theme default (accent at 40%), which is invisible on the
      // accent bubble.
      expect(style.selectionColor, MessageBubble.userSelectionColor);
      expect(style.selectionColor,
          isNot(Theme.of(tester.element(find.text('copy me')))
              .textSelectionTheme
              .selectionColor));
    });

    testWidgets('a text-only message renders no chips', (tester) async {
      await tester.pumpWidget(host(MessageBubble(
        message: ClientMessage(
          id: 'm2',
          chatId: 'c1',
          role: Role.user,
          text: 'just text',
          ts: DateTime.now().millisecondsSinceEpoch,
        ),
        botName: 'Talon',
      )));
      await tester.pump();
      expect(find.byIcon(Icons.open_in_new_rounded), findsNothing);
    });
  });
}
