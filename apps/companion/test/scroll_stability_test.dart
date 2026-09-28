import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/code_block.dart';
import 'package:talon_companion/src/ui/highlight_cache.dart';
import 'package:talon_companion/src/ui/image_bounds.dart';
import 'package:talon_companion/src/ui/message_bubble.dart';

/// #1062 — the Linux "crashes while scrolling" causes: unbounded image
/// decodes, synchronous highlighting in build, nested selection systems, and
/// unbounded in-memory history.
Widget _host(Widget child) => MaterialApp(
      theme: buildTalonTheme(),
      builder: (context, c) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: c!,
      ),
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );

ClientMessage _msg(String id, Role role, String text, {int ts = 1}) =>
    ClientMessage(id: id, chatId: 'c1', role: role, text: text, ts: ts);

void main() {
  setUp(HighlightCache.debugClear);

  group('highlighting', () {
    test('runs reproduce the source and carry highlight classes', () {
      const code = 'void main() {\n  final x = 1;\n}';
      final runs = highlightRuns((code: code, language: 'dart'));
      expect(runs.map((r) => r.$1).join(), code);
      expect(runs.any((r) => r.$2.contains('keyword')), isTrue);
    });

    test('an unknown language is one plain run, not an exception', () {
      final runs = highlightRuns((code: 'x', language: 'no-such-lang'));
      expect(runs, hasLength(1));
      expect(runs.single.$1, 'x');
      expect(runs.single.$2, isEmpty);
    });

    test('results are cached and the cache is bounded', () {
      final a = HighlightCache.highlightSync('int a = 1;', 'dart');
      expect(identical(HighlightCache.highlightSync('int a = 1;', 'dart'), a),
          isTrue);
      for (var i = 0; i < 100; i++) {
        HighlightCache.highlightSync('int v$i = $i;', 'dart');
      }
      expect(HighlightCache.debugSize, lessThanOrEqualTo(64));
    });

    test('very large blocks are not eligible for colour', () {
      expect(HighlightCache.eligible('x' * 100), isTrue);
      expect(HighlightCache.eligible('x' * (HighlightCache.asyncLimit + 1)),
          isFalse);
      expect(
          HighlightCache.eligible('\n' * HighlightCache.asyncLineLimit), isFalse);
    });

    test('large blocks highlight in a background isolate', () async {
      final code = List.filled(400, 'final value = compute(1);').join('\n');
      expect(code.length, greaterThan(HighlightCache.syncLimit));
      final runs = await HighlightCache.highlightAsync(code, 'dart');
      expect(runs.map((r) => r.$1).join(), code);
      expect(HighlightCache.lookup(code, 'dart'), same(runs));
    });
  });

  group('CodeBlock', () {
    testWidgets('small blocks paint highlighted on the first frame',
        (tester) async {
      await tester.pumpWidget(_host(
        const CodeBlock(code: 'void main() {}', language: 'dart'),
      ));
      final rich = tester
          .widgetList<Text>(find.byType(Text))
          .where((t) => t.textSpan != null)
          .toList();
      expect(rich, isNotEmpty);
      expect((rich.single.textSpan! as TextSpan).children, isNotEmpty);
    });

    testWidgets('carries no SelectionArea of its own', (tester) async {
      await tester.pumpWidget(_host(
        const CodeBlock(code: 'a\nb', language: 'dart'),
      ));
      expect(find.byType(SelectionArea), findsNothing);
    });

    testWidgets('caps what it lays out, not what it copies', (tester) async {
      final code = List.generate(
          CodeBlock.maxDisplayLines + 250, (i) => 'line $i').join('\n');
      await tester.pumpWidget(_host(CodeBlock(code: code)));
      expect(find.textContaining('250 more lines not shown'), findsOneWidget);
      expect(find.textContaining('line ${CodeBlock.maxDisplayLines - 1}'),
          findsOneWidget);
      expect(find.textContaining('line ${CodeBlock.maxDisplayLines}\n'),
          findsNothing);
    });
  });

  group('selection', () {
    testWidgets('an assistant reply is one selection system', (tester) async {
      await tester.pumpWidget(_host(MessageBubble(
        botName: 'Talon',
        message: _msg('1', Role.assistant,
            'Here:\n\n```dart\nvoid main() {}\n```\n\nand more text.'),
      )));
      expect(find.byType(SelectionArea), findsOneWidget);
      expect(find.byType(SelectableText), findsNothing);
      expect(find.byType(CodeBlock), findsOneWidget);
    });

    testWidgets('a user bubble has no SelectableText', (tester) async {
      await tester.pumpWidget(_host(MessageBubble(
        botName: 'Talon',
        message: _msg('2', Role.user, 'hello there'),
      )));
      expect(find.byType(SelectableText), findsNothing);
      expect(find.text('hello there'), findsOneWidget);
    });
  });

  group('image decode bounds', () {
    test('thumbnails decode at their box size in physical pixels', () {
      final p = boundedNetworkImage('https://x/y.png',
          maxWidth: 340, maxHeight: 420, devicePixelRatio: 2) as ResizeImage;
      expect(p.width, 680);
      expect(p.height, 840);
      expect(p.policy, ResizeImagePolicy.fit);
      expect(p.allowUpscaling, isFalse);
    });

    test('no decode ever exceeds the texture-safe edge', () {
      final p = boundedNetworkImage('https://x/y.png',
          maxWidth: 4000, maxHeight: 4000, devicePixelRatio: 3) as ResizeImage;
      expect(p.width, kMaxDecodeDimension);
      expect(p.height, kMaxDecodeDimension);
      final full = fullScreenNetworkImage('https://x/y.png') as ResizeImage;
      expect(full.width, kMaxDecodeDimension);
      expect(full.height, kMaxDecodeDimension);
      expect(full.policy, ResizeImagePolicy.fit);
    });

    test('the auth header reaches the network request', () {
      const auth = {'Authorization': 'Bearer t'};
      final p = boundedNetworkImage('https://x/y.png',
          headers: auth,
          maxWidth: 10,
          maxHeight: 10,
          devicePixelRatio: 1) as ResizeImage;
      expect((p.imageProvider as NetworkImage).headers, auth);
      final full = fullScreenNetworkImage('https://x/y.png', headers: auth)
          as ResizeImage;
      expect((full.imageProvider as NetworkImage).headers, auth);
    });
  });

  test('switching away trims a chat to its newest page', () async {
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: false);
    addTearDown(state.dispose);
    final long = [
      for (var i = 0; i < 500; i++) _msg('$i', Role.user, 'm$i', ts: i + 1),
    ];
    state.debugSeed(
      chats: [
        ClientChat(
            id: 'c1', title: 'A', createdAt: 1, lastActive: 2, preview: ''),
        ClientChat(
            id: 'c2', title: 'B', createdAt: 1, lastActive: 1, preview: ''),
      ],
      messages: {
        'c1': long,
        'c2': [_msg('x', Role.user, 'hi')],
      },
      select: 'c1',
    );
    expect(state.hasMoreHistory('c1'), isFalse);

    await state.selectChat('c2');

    final kept = state.messagesFor('c1');
    expect(kept.length, lessThan(500));
    expect(kept.last.id, '499', reason: 'the newest messages stay');
    expect(state.hasMoreHistory('c1'), isTrue,
        reason: 'scrolling up must be able to re-fetch what was dropped');
    // The chat on screen is never trimmed.
    expect(state.messagesFor('c2'), hasLength(1));
  });
}
