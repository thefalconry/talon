import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/tool_format.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/state/voice_session.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/voice_mode_screen.dart';

import 'fake_voice_engine.dart';

/// Voice mode narrated tool calls by interpolating the raw tool id into its
/// status line, so a plugin call read as `mcp__email-tools__search_emails` on
/// screen. It now renders a human phrase in a live activity card.
void main() {
  group('tool name humanising', () {
    test('MCP ids become a phrase and a server', () {
      expect(toolPhrase('mcp__email-tools__search_emails'), 'Search emails');
      expect(toolServer('mcp__email-tools__search_emails'), 'email');
      expect(toolPhrase('mcp__polymarket-tools__place_order'), 'Place order');
      expect(toolPhrase('mcp__ssh-tools__execute-command'), 'Execute command');
      expect(toolServer('Bash'), isNull);
    });

    test('built-ins get hand-written phrases, unknowns get sentence case', () {
      expect(toolPhrase('Bash'), 'Run a command');
      expect(toolPhrase('WebSearch'), 'Search the web');
      expect(toolPhrase('TodoWrite'), 'Update the plan');
      expect(toolPhrase('getWeather'), 'Get weather');
    });

    test('the chat timeline keeps its tabular form', () {
      // Two surfaces, two registers: the timeline is a table, voice is a
      // sentence. This is the contract that lets both share one helper file.
      expect(toolDisplayName('mcp__email-tools__search_emails'),
          'email · search_emails');
    });
  });

  testWidgets('voice mode shows a live card, never the raw tool id',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: true);
    addTearDown(state.dispose);
    state.debugSeed(
      chats: [
        ClientChat(
            id: 'c1', title: 'Inbox', createdAt: 1, lastActive: 2, preview: ''),
      ],
      select: 'c1',
      connState: ConnState.connected,
    );
    final engine = SilentVoiceEngine();
    addTearDown(engine.close);
    final session = VoiceSession(state, handsFree: true, engine: engine);
    addTearDown(session.dispose);

    final turn = state.turnFor('c1');
    turn.active = true;
    turn.tools.add(ToolActivity(
      id: 't1',
      name: 'mcp__email-tools__search_emails',
      startedAt: DateTime.now(),
    ));
    session.debugSetPhase(VoicePhase.thinking);

    await tester.pumpWidget(MaterialApp(
      theme: buildTalonTheme(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: VoiceModeScreen(state: state, session: session),
    ));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Search emails'), findsOneWidget);
    expect(find.textContaining('mcp__'), findsNothing);
    // The status line stops naming the tool; the card owns that now.
    expect(find.text('Working…'), findsOneWidget);
    // Server + elapsed live on the card's second line.
    expect(find.textContaining('email · '), findsOneWidget);

    // A failed call re-tints and says so, still in human words.
    turn.tools.first
      ..done = true
      ..error = 'imap timeout'
      ..finishedAt = DateTime.now();
    session.debugSetPhase(VoicePhase.thinking);
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Search emails failed'), findsOneWidget);

    // And it folds away entirely once the reply starts.
    session.debugSetPhase(VoicePhase.speaking);
    // Two frames: one to start the switcher's exit, one past its end (the orb
    // animates forever, so pumpAndSettle would never return here).
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Search emails failed'), findsNothing);

    // Let AppState's debounced snapshot timer fire before teardown.
    await tester.pump(const Duration(seconds: 3));
  });
}
