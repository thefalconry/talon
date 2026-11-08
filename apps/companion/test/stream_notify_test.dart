import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/state/frame_coalescer.dart';

import 'mock_bridge.dart';

/// #1059: streamed tokens notify the turn, not the app. Plain tests only:
/// no testWidgets in this file, so no TestWidgetsFlutterBinding — real HTTP
/// to the mock bridge works, and FrameCoalescer takes its no-binding
/// (microtask) path.
void main() {
  group('FrameCoalescer', () {
    test('merges a burst into one delivery (no binding: microtask)',
        () async {
      var delivered = 0;
      final c = FrameCoalescer(() => delivered++);
      c.request();
      c.request();
      c.request();
      expect(delivered, 0);
      await Future<void>.delayed(Duration.zero);
      expect(delivered, 1);
      c.request();
      c.cancel();
      await Future<void>.delayed(Duration.zero);
      expect(delivered, 1, reason: 'a cancelled request never delivers');
    });
  });

  group('TurnState draft', () {
    test('appends are buffered and joined on read', () {
      final t = TurnState();
      expect(t.hasDraft, isFalse);
      t.appendDraft('Hel');
      t.appendDraft('lo');
      expect(t.hasDraft, isTrue);
      expect(t.draft, 'Hello');
      t.appendDraft(', world');
      expect(t.draft, 'Hello, world');
      t.appendDraft('!');
      t.draft = '';
      expect(t.draft, isEmpty);
      expect(t.hasDraft, isFalse);
    });
  });

  test('tokens notify the turn, not the whole app', () async {
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    await prefs.setConnection(ConnectionConfig(
      host: bridge.host,
      port: bridge.port,
      manageLocalDaemon: false,
      localAutoDiscover: false,
    ));
    final state = AppState(prefs, narrowLayout: false);
    addTearDown(state.dispose);
    await state.start();
    await _waitFor(() => state.conn == ConnState.connected);
    await _waitFor(() => bridge.streamCount == 1);

    await bridge.emit({'kind': 'turn_start', 'chatId': 'c1'});
    await _waitFor(() => state.turnFor('c1').active);

    var appNotifies = 0;
    var turnNotifies = 0;
    state.addListener(() => appNotifies++);
    state.turnFor('c1').addListener(() => turnNotifies++);

    // First text of the reply changes the chat's shape → an app notify.
    await bridge.emit({'kind': 'delta', 'chatId': 'c1', 'text': 'a'});
    await _waitFor(() => state.turnFor('c1').draft == 'a');
    expect(appNotifies, greaterThanOrEqualTo(1));

    // The next 40 tokens: before, 40 app-wide notifies (40 whole-tree
    // rebuilds). Now the app hears nothing; the turn hears ≤1 per frame.
    // (Tolerant bound: unrelated background notifies — mesh presence —
    // may land in the window.)
    final before = appNotifies;
    for (var i = 0; i < 40; i++) {
      await bridge.emit({'kind': 'delta', 'chatId': 'c1', 'text': 'b'});
    }
    await _waitFor(() => state.turnFor('c1').draft.length == 41);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(appNotifies - before, lessThan(4));
    expect(turnNotifies, inInclusiveRange(1, 40));

    await bridge.emit({'kind': 'turn_end', 'chatId': 'c1'});
    await _waitFor(() => !state.turnFor('c1').active);
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final end = DateTime.now().add(timeout);
  while (!test()) {
    if (DateTime.now().isAfter(end)) fail('Timed out waiting for condition');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
