import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/message_bubble.dart';
import 'package:talon_companion/src/ui/motion.dart';
import 'package:talon_companion/src/ui/tool_timeline.dart';

/// Runtime smoke tests: pump the redesigned widgets and assert they build and
/// surface their key content, catching layout/assertion errors the analyzer
/// can't. Animations are disabled so the pumps settle deterministically.
Widget _host(Widget child) => MediaQuery(
      data: const MediaQueryData(disableAnimations: true),
      child: MaterialApp(
        theme: buildTalonTheme(),
        home: Scaffold(
          body: SingleChildScrollView(child: child),
        ),
      ),
    );

ToolActivity _tool({
  required String id,
  required String name,
  bool done = true,
  String? error,
  Map<String, dynamic>? input,
}) =>
    ToolActivity(
      id: id,
      name: name,
      done: done,
      error: error,
      input: input,
      startedAt: DateTime(2020),
      finishedAt: DateTime(2020, 1, 1, 0, 0, 2),
    );

void main() {
  testWidgets('ToolTimeline renders a step per tool with de-noised names',
      (tester) async {
    await tester.pumpWidget(_host(ToolTimeline(tools: [
      _tool(id: 't1', name: 'Bash', input: {'command': 'ls -la'}),
      _tool(
        id: 't2',
        name: 'mcp__email-tools__search_emails',
        input: {'query': 'invoices'},
      ),
    ])));
    await tester.pumpAndSettle();

    expect(find.text('Bash'), findsOneWidget);
    // MCP name is de-noised: server · tool.
    expect(find.text('email · search_emails'), findsOneWidget);
  });

  testWidgets('a failed tool step auto-expands to show its error',
      (tester) async {
    await tester.pumpWidget(_host(ToolTimeline(tools: [
      _tool(
        id: 't1',
        name: 'run_tests',
        done: true,
        error: 'exit code 1: 2 failing',
        input: {'path': 'test/'},
      ),
    ])));
    await tester.pumpAndSettle();

    expect(find.text('Failed'), findsOneWidget);
    // Error detail is visible without any tap because failures open on arrival.
    expect(find.textContaining('exit code 1'), findsOneWidget);
  });

  testWidgets('ToolTrace summarizes a finished turn by what it did',
      (tester) async {
    await tester.pumpWidget(_host(ToolTrace(tools: [
      _tool(id: 't1', name: 'Bash'),
      _tool(id: 't2', name: 'Bash'),
      _tool(id: 't3', name: 'Read'),
    ])));
    await tester.pumpAndSettle();

    // Claude-desktop-style label: bucketed by kind, in order of appearance.
    expect(find.textContaining('Ran 2 commands, read a file'), findsOneWidget);
    // Collapsed by default: the underlying timeline is not shown yet.
    expect(find.byType(ToolTimeline), findsNothing);
  });

  testWidgets('tapping a tool group expands the full timeline', (tester) async {
    await tester.pumpWidget(_host(ToolTrace(tools: [
      _tool(id: 't1', name: 'Bash', input: {'command': 'ls'}),
      _tool(id: 't2', name: 'Read', input: {'path': 'a.txt'}),
    ])));
    await tester.pumpAndSettle();
    expect(find.byType(ToolTimeline), findsNothing);

    await tester.tap(find.byKey(const Key('tool-group-toggle')));
    await tester.pumpAndSettle();

    expect(find.byType(ToolTimeline), findsOneWidget);
    expect(find.text('Bash'), findsOneWidget);
  });

  testWidgets('a group with a failed step opens itself', (tester) async {
    await tester.pumpWidget(_host(ToolTrace(tools: [
      _tool(id: 't1', name: 'Bash', done: true),
      _tool(
        id: 't2',
        name: 'run_tests',
        done: true,
        error: 'exit code 1',
        input: {'path': 'test/'},
      ),
    ])));
    await tester.pumpAndSettle();

    // No tap needed: the timeline is already visible and the error shows.
    expect(find.byType(ToolTimeline), findsOneWidget);
    expect(find.textContaining('exit code 1'), findsOneWidget);
    expect(find.textContaining('1 failed'), findsOneWidget);
  });

  testWidgets('assistant bubble shows the reply and a token/duration footer',
      (tester) async {
    final msg = ClientMessage(
      id: 'm1',
      chatId: 'c1',
      role: Role.assistant,
      text: 'Here is your answer.',
      ts: 0,
      durationMs: 4200,
      tokensIn: 1500,
      tokensOut: 320,
      tools: [
        _tool(id: 't1', name: 'Bash', input: {'command': 'ls'}),
      ],
    );
    await tester.pumpWidget(_host(
      MessageBubble(message: msg, botName: 'Talon'),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Talon'), findsOneWidget);
    expect(find.byKey(const Key('assistant-message-card')), findsOneWidget);
    expect(find.text('Copy'), findsOneWidget);
    // Compact stats: 1.5k in · 320 out · 4.2s
    expect(find.textContaining('1.5k in'), findsOneWidget);
    expect(find.textContaining('4.2s'), findsOneWidget);

    // Anatomy: only the reply lives inside the bubble. The name header, the
    // tool trace, and the copy/token/duration footer sit outside on the
    // canvas.
    final card = find.byKey(const Key('assistant-message-card'));
    expect(
        find.descendant(of: card, matching: find.text('Talon')), findsNothing);
    expect(
        find.descendant(of: card, matching: find.text('Copy')), findsNothing);
    expect(find.descendant(of: card, matching: find.textContaining('1.5k in')),
        findsNothing);
    expect(find.descendant(of: card, matching: find.byType(ToolTrace)),
        findsNothing);
    expect(find.byType(ToolTrace), findsOneWidget);
  });

  testWidgets('user bubble surfaces its timestamp on touch layouts',
      (tester) async {
    final msg = ClientMessage(
      id: 'm2',
      chatId: 'c1',
      role: Role.user,
      text: 'A quick follow-up',
      ts: DateTime(2026, 7, 15, 19, 10).millisecondsSinceEpoch,
    );
    await tester.pumpWidget(_host(
      MessageBubble(message: msg, botName: 'Talon'),
    ));
    await tester.pumpAndSettle();

    expect(find.text('A quick follow-up'), findsOneWidget);
    expect(find.byKey(const Key('user-message-time')), findsOneWidget);
    // The bubble stays pinned to the right edge of the row — regression for
    // the shrink-wrapped column sitting at the start of its flex slot.
    final bubbleRect =
        tester.getRect(find.byKey(const Key('user-message-bubble')));
    final rowWidth = tester.getSize(find.byType(Scaffold)).width;
    expect(bubbleRect.right, greaterThan(rowWidth - 8));
    // The timestamp sits under the bubble on the canvas, not inside it.
    expect(
      find.descendant(
        of: find.byKey(const Key('user-message-bubble')),
        matching: find.byKey(const Key('user-message-time')),
      ),
      findsNothing,
    );
  });

  testWidgets('grouped rows drop the repeated header / defer the clock',
      (tester) async {
    ClientMessage msg(String id, Role role, String text) => ClientMessage(
          id: id,
          chatId: 'c1',
          role: role,
          text: text,
          ts: DateTime(2026, 7, 16, 9, 30).millisecondsSinceEpoch,
        );
    await tester.pumpWidget(_host(Column(children: [
      // Assistant run: second row is grouped → header suppressed.
      MessageBubble(
          message: msg('a1', Role.assistant, 'First'), botName: 'Talon'),
      MessageBubble(
          message: msg('a2', Role.assistant, 'Second'),
          botName: 'Talon',
          showHeader: false),
      // User run: first row grouped-with-next → clock deferred to the last.
      MessageBubble(
          message: msg('u1', Role.user, 'One'),
          botName: 'Talon',
          showTime: false),
      MessageBubble(message: msg('u2', Role.user, 'Two'), botName: 'Talon'),
    ])));
    await tester.pumpAndSettle();

    expect(find.text('Talon'), findsOneWidget);
    expect(find.byKey(const Key('user-message-time')), findsOneWidget);
  });

  testWidgets('EntranceFx plays through even when enabled flips to false',
      (tester) async {
    // Reproduces the streaming-rebuild bug: a parent rebuild flips the "fresh"
    // gate to false a few frames in. EntranceFx must keep rendering its child
    // (never throw / drop it) rather than tearing the animation down.
    var enabled = true;
    late StateSetter setOuter;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: StatefulBuilder(builder: (context, setState) {
          setOuter = setState;
          return EntranceFx(
            enabled: enabled,
            child: const Text('hello', key: Key('fx-child')),
          );
        }),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.byKey(const Key('fx-child')), findsOneWidget);

    // Simulate the streaming rebuild that flips the gate mid-entrance.
    setOuter(() => enabled = false);
    await tester.pump();
    expect(find.byKey(const Key('fx-child')), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('fx-child')), findsOneWidget);
  });

  testWidgets('reduceMotion reflects MediaQuery.disableAnimations',
      (tester) async {
    late bool observed;
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(disableAnimations: true),
      child: Builder(builder: (context) {
        observed = reduceMotion(context);
        return const SizedBox();
      }),
    ));
    expect(observed, isTrue);
  });
}
