import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/code_block.dart';
import 'package:talon_companion/src/ui/markdown.dart';

Widget _host(Widget child) => MaterialApp(
      theme: buildTalonTheme(),
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );

String _lines(int n) => [for (var i = 0; i < n; i++) 'line $i'].join('\n');

void main() {
  testWidgets('a long finished code block opens folded and expands',
      (tester) async {
    await tester.pumpWidget(_host(CodeBlock(code: _lines(40), language: '')));
    await tester.pump();

    expect(find.text('Show all 40 lines'), findsOneWidget);
    await tester.tap(find.byKey(const Key('code-block-expand')));
    await tester.pump();
    expect(find.text('Show less'), findsOneWidget);
  });

  testWidgets('short and streaming code blocks never fold', (tester) async {
    await tester.pumpWidget(_host(Column(children: [
      CodeBlock(code: _lines(CodeBlock.collapseAbove), language: ''),
      CodeBlock(code: _lines(80), language: '', live: true),
    ])));
    await tester.pump();

    expect(find.byKey(const Key('code-block-expand')), findsNothing);
  });

  testWidgets('tables keep their column widths and scroll sideways',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(360, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_host(MarkdownBody(
      data: '| Port | Purpose | Config key |\n'
          '|---|---|---|\n'
          '| 19880 | HTTPS bridge (chat, SSE, media) | `native.port` |\n'
          '| 19881 | Local discovery beacon | `native.discoveryPort` |\n',
      styleSheet: talonMarkdownStyle(),
    )));
    await tester.pump();

    final scroller = find.ancestor(
      of: find.byType(Table),
      matching: find.byWidgetPredicate((w) =>
          w is SingleChildScrollView && w.scrollDirection == Axis.horizontal),
    );
    expect(scroller, findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  test('the streaming caret rides the end of the text', () {
    expect(withInlineCaret('the slot is usually'),
        'the slot is usually$kStreamingCaret');
    // Inside an open fence or code span the sentinel would print.
    expect(withInlineCaret('```ts\nconst a = 1;'), isNull);
    expect(withInlineCaret('run `npm i'), isNull);
    // A closed fence is ordinary text again.
    expect(withInlineCaret('```\nx\n```\nDone'),
        '```\nx\n```\nDone$kStreamingCaret');
  });

  testWidgets('the caret renders inline, inside the paragraph',
      (tester) async {
    await tester.pumpWidget(_host(MarkdownBody(
      data: withInlineCaret('1. **Saturday** — dinner at 7:30')!,
      builders: {
        'caret': StreamingCaretBuilder(
            const SizedBox(key: Key('caret'), width: 7, height: 15)),
      },
      inlineSyntaxes: [StreamingCaretSyntax()],
      styleSheet: talonMarkdownStyle(),
    )));
    await tester.pump();

    final caret = find.byKey(const Key('caret'));
    expect(caret, findsOneWidget);
    // Merged into the list item's RichText, not laid out as a sibling.
    expect(find.ancestor(of: caret, matching: find.byType(RichText)),
        findsWidgets);
    expect(find.textContaining(kStreamingCaret), findsNothing);
  });

  testWidgets('InlineMarkdownText unescapes quotes and HTML entities without leaking &quot;',
      (tester) async {
    await tester.pumpWidget(_host(const InlineMarkdownText(
      data: 'He said &quot;hello world&quot; and "direct quote"',
    )));
    await tester.pump();
    expect(find.textContaining('&quot;'), findsNothing);
    expect(find.textContaining('He said "hello world" and "direct quote"'),
        findsOneWidget);
  });
}
