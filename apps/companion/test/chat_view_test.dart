import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/brand.dart';
import 'package:talon_companion/src/ui/chat_view.dart';

/// ChatView rendering contracts: day dividers appear where the calendar day
/// changes (and only there), giving scrollback temporal landmarks.
void main() {
  Future<AppState> seededState(
      Map<String, List<ClientMessage>> messages) async {
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: false);
    state.debugSeed(
      chats: [
        ClientChat(
          id: 'c1',
          title: 'General',
          createdAt: 1,
          lastActive: 2,
          preview: 'hi',
        ),
      ],
      messages: messages,
      select: 'c1',
      connState: ConnState.connected,
    );
    return state;
  }

  Widget host(AppState state) => MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: Scaffold(body: ChatView(state: state, showBack: false)),
      );

  ClientMessage msg(String id, Role role, String text, DateTime at) =>
      ClientMessage(
        id: id,
        chatId: 'c1',
        role: role,
        text: text,
        ts: at.millisecondsSinceEpoch,
      );

  testWidgets('messages from different days get day dividers', (tester) async {
    await tester.binding.setSurfaceSize(const Size(900, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final now = DateTime.now();
    final state = await seededState({
      'c1': [
        msg('1', Role.user, 'old message',
            now.subtract(const Duration(days: 3))),
        msg('2', Role.assistant, 'old reply',
            now.subtract(const Duration(days: 3))),
        msg('3', Role.user, 'yesterday message',
            now.subtract(const Duration(days: 1))),
        msg('4', Role.user, 'today message', now),
      ],
    });
    addTearDown(state.dispose);

    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Yesterday'), findsOneWidget);
    // Two same-day messages share ONE divider: 4 messages, 3 distinct days.
    final now2 = DateTime.now();
    // The 3-days-ago marker renders as "D Month" (year only when different).
    expect(
      find.textContaining(RegExp(r'^\d{1,2} [A-Z]')),
      now2.day == now.day ? findsOneWidget : findsWidgets,
    );
    expect(find.text('today message'), findsOneWidget);

    // Flush AppState's debounced snapshot-save timer before teardown.
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('same-day conversation renders a single divider', (tester) async {
    await tester.binding.setSurfaceSize(const Size(900, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final now = DateTime.now();
    final state = await seededState({
      'c1': [
        msg('1', Role.user, 'one', now.subtract(const Duration(minutes: 5))),
        msg('2', Role.assistant, 'two', now),
      ],
    });
    addTearDown(state.dispose);

    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Yesterday'), findsNothing);

    // Flush AppState's debounced snapshot-save timer before teardown.
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('opens to the bottom even with a tall last message',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final now = DateTime.now();
    final tallBody = List.generate(
            80,
            (i) =>
                'Line $i: A moderately long sentence explaining something detail oriented.')
        .join('\n\n');
    final state = await seededState({
      'c1': [
        msg('1', Role.user, 'hello', now.subtract(const Duration(minutes: 5))),
        msg('2', Role.assistant, tallBody, now),
      ],
    });
    addTearDown(state.dispose);

    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    final listViewFinder = find.byType(ListView);
    expect(listViewFinder, findsOneWidget);
    final listView = tester.widget<ListView>(listViewFinder);
    final controller = listView.controller;
    expect(controller, isNotNull);
    expect(controller!.hasClients, isTrue);
    final pos = controller.position;
    expect(pos.pixels, equals(pos.maxScrollExtent));
    expect(pos.maxScrollExtent, greaterThan(0));

    // Flush AppState's debounced snapshot-save timer before teardown.
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets(
      'mid-turn messages and the live turn read as one run with one footer',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(900, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final now = DateTime.now();
    final state = await seededState({
      'c1': [
        msg('1', Role.user, 'check the servers',
            now.subtract(const Duration(minutes: 3))),
        msg('2', Role.assistant, 'On it.',
            now.subtract(const Duration(minutes: 2))),
        msg('3', Role.assistant, 'First one is fine.',
            now.subtract(const Duration(minutes: 1))),
        msg('4', Role.assistant, 'Checking the second.', now),
      ],
    });
    addTearDown(state.dispose);
    final turn = state.turnFor('c1')
      ..active = true
      ..continuing = true;

    await tester.pumpWidget(host(state));
    await tester.pump(const Duration(milliseconds: 500));

    // One avatar for the whole run — the live turn doesn't open a second
    // "Talon · Working" card — and no per-message Copy while it continues.
    expect(find.byType(BrandMark), findsOneWidget);
    expect(find.text('Copy'), findsNothing);
    expect(find.byKey(const Key('working-row')), findsOneWidget);

    // Turn ends: the working row goes, and the run's last row gets the
    // single footer.
    turn
      ..active = false
      ..continuing = false;
    state.debugSeed(connState: ConnState.connected);
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.byKey(const Key('working-row')), findsNothing);
    expect(find.text('Copy'), findsOneWidget);
    expect(find.byType(BrandMark), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('anchors to bottom on chat switch and server connect',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(900, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final now = DateTime.now();
    final msgs1 = [
      for (var i = 0; i < 30; i++)
        msg('$i', Role.user, 'Message $i', now.add(Duration(minutes: i))),
    ];
    final msgs2 = [
      for (var i = 0; i < 40; i++)
        ClientMessage(
          id: 'c2_$i',
          chatId: 'c2',
          role: Role.user,
          text: 'Other $i',
          ts: now.add(Duration(minutes: i)).millisecondsSinceEpoch,
        ),
    ];

    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: false);
    state.debugSeed(
      chats: [
        ClientChat(
          id: 'c1',
          title: 'First',
          createdAt: 1,
          lastActive: 2,
          preview: 'hi',
        ),
        ClientChat(
          id: 'c2',
          title: 'Second',
          createdAt: 1,
          lastActive: 2,
          preview: 'hi',
        ),
      ],
      messages: {'c1': msgs1, 'c2': msgs2},
      select: 'c1',
      connState: ConnState.connecting,
    );
    addTearDown(state.dispose);

    await tester.pumpWidget(host(state));
    await tester.pump(const Duration(seconds: 3));

    // Verify latest message in c1 is visible
    expect(find.text('Message 29'), findsOneWidget);

    // Switch to c2: must land on latest message in c2
    await state.selectChat('c2');
    await tester.pumpWidget(host(state));
    await tester.pump(const Duration(seconds: 3));

    expect(find.text('Other 39'), findsOneWidget);

    // Simulate server connecting while viewing c2
    state.debugSeed(connState: ConnState.connected);
    await tester.pumpWidget(host(state));
    await tester.pump(const Duration(seconds: 3));

    expect(find.text('Other 39'), findsOneWidget);
  });
}
