import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'mock_bridge.dart';

void main() {
  ConnectionConfig configFor(MockBridge bridge, {String? token}) =>
      ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        token: token,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );

  Future<AppState> stateFor(
    ConnectionConfig config, {
    // These tests document the desktop two-pane semantics (auto-select the
    // most recent chat) unless a test opts into the phone layout — the test
    // binding reports TargetPlatform.android, so the constructor default
    // would otherwise flip them to phone behavior.
    bool narrowLayout = false,
  }) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    await prefs.setConnection(config);
    return AppState(prefs, narrowLayout: narrowLayout);
  }

  group('AppState empty-chat cleanup', () {
    // "New chat" creates a real chat on the daemon the moment it's tapped, so
    // opening one and backing out used to leave an empty row in the list
    // forever. Leaving an untouched chat now deletes it.
    test('an untouched new chat is deleted when you leave it', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge), narrowLayout: true);
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      await state.newChat();
      final fresh = state.selectedChatId!;
      expect(fresh, isNot('c1'));

      // Back to the list without sending anything.
      state.clearSelection();
      await _waitFor(() => bridge.deletedChats.contains(fresh));
      await _waitFor(() => !state.chats.any((c) => c.id == fresh));
      // The chat that has a message is untouched.
      expect(state.chats.any((c) => c.id == 'c1'), isTrue);
    });

    test('a chat that carried a message is never auto-deleted', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge), narrowLayout: true);
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      await state.newChat();
      final fresh = state.selectedChatId!;
      await bridge.emit({
        'kind': 'message',
        'chatId': fresh,
        'message': {
          'id': 'm-fresh',
          'chatId': fresh,
          'role': 'user',
          'text': 'keep me',
          'ts': 40,
        },
      });
      await _waitFor(() => state.messagesFor(fresh).isNotEmpty);

      state.clearSelection();
      // Give the reaper a chance to misbehave before asserting it didn't.
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(bridge.deletedChats, isEmpty);
      expect(state.chats.any((c) => c.id == fresh), isTrue);
    });

    test('creating a second new chat sweeps the first', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge), narrowLayout: true);
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      await state.newChat();
      final first = state.selectedChatId!;
      await state.newChat();
      final second = state.selectedChatId!;

      await _waitFor(() => bridge.deletedChats.contains(first));
      expect(bridge.deletedChats, isNot(contains(second)));
    });
  });

  group('AppState bridge integration', () {
    test('start reaches connected and hello populates chats/status', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);

      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => bridge.streamCount == 1);
      await _waitFor(() => state.models.isNotEmpty);

      expect(state.connError, isNull);
      expect(state.status.botName, 'Talon');
      expect(state.chats.single.id, 'c1');
      expect(state.selectedChatId, 'c1');
      expect(state.messagesFor('c1').single.text, 'Hello');
      expect(state.models.single.id, 'm1');
    });

    test('events mutate messages and live turn state', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => bridge.streamCount == 1);

      await bridge.emit({'kind': 'turn_start', 'chatId': 'c1'});
      await _waitFor(() => state.turnFor('c1').active);
      await bridge
          .emit({'kind': 'reasoning', 'chatId': 'c1', 'text': 'thinking'});
      await bridge.emit({'kind': 'delta', 'chatId': 'c1', 'text': 'partial'});
      await bridge.emit({
        'kind': 'tool',
        'chatId': 'c1',
        'id': 'tool1',
        'name': 'search',
        'phase': 'call',
        'input': {'q': 'talon'},
      });
      await _waitFor(() => state.turnFor('c1').tools.isNotEmpty);
      expect(state.turnFor('c1').reasoning, ['thinking']);
      expect(state.turnFor('c1').draft, 'partial');

      await bridge.emit({
        'kind': 'tool',
        'chatId': 'c1',
        'id': 'tool1',
        'name': 'search',
        'phase': 'result',
      });
      await _waitFor(() => state.turnFor('c1').tools.single.done);

      await bridge.emit({
        'kind': 'message',
        'chatId': 'c1',
        'message': {
          'id': 'm2',
          'chatId': 'c1',
          'role': 'assistant',
          'text': 'done',
          'ts': 30,
        },
      });
      await _waitFor(() => state.messagesFor('c1').length == 2);
      expect(state.messagesFor('c1').last.text, 'done');
      expect(state.messagesFor('c1').last.tools.single.name, 'search');
      // A delivered assistant message folds the streamed state into the
      // bubble but no longer ends the turn — the model may keep working
      // after a mid-turn send. The definitive `turn_end` ends it.
      expect(state.turnFor('c1').active, isTrue);
      expect(state.turnFor('c1').draft, isEmpty);
      expect(state.turnFor('c1').tools, isEmpty);
      await bridge.emit({'kind': 'turn_end', 'chatId': 'c1', 'delivered': 1});
      await _waitFor(() => !state.turnFor('c1').active);
      expect(state.turnFor('c1').continuing, isFalse);

      await bridge.emit({'kind': 'turn_start', 'chatId': 'c1'});
      await bridge.emit({'kind': 'typing', 'chatId': 'c1', 'on': true});
      await _waitFor(() => state.turnFor('c1').typing);
      await bridge.emit({'kind': 'turn_end', 'chatId': 'c1', 'delivered': 1});
      await _waitFor(() => !state.turnFor('c1').typing);
    });

    test('reconnect re-fetches history that advanced while away', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);

      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      expect(state.messagesFor('c1').single.text, 'Hello');

      // History advances while the client is away (a heartbeat/cron reply
      // landed on the server, or a blip dropped live events).
      bridge.messages['c1']!.add({
        'id': 'm9',
        'chatId': 'c1',
        'role': 'assistant',
        'text': 'while away',
        'ts': 99,
      });

      // Reconnecting must re-pull the visible chat's history rather than keep
      // the stale list forever (regression: a viewed chat's _loadedHistory mark
      // used to suppress the reload).
      await state.start();
      await _waitFor(() => state.messagesFor('c1').any((m) => m.id == 'm9'));
      expect(
        state.messagesFor('c1').map((m) => m.id),
        containsAll(<String>['m1', 'm9']),
      );
    });

    test('chat and message maintenance events update stores', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => bridge.streamCount == 1);

      await bridge.emit({
        'kind': 'chat_updated',
        'chat': {
          'id': 'c1',
          'title': 'Renamed',
          'createdAt': 1,
          'lastActive': 5,
          'preview': 'new',
        },
      });
      await _waitFor(() => state.chats.single.title == 'Renamed');

      await bridge.emit({
        'kind': 'message_edited',
        'chatId': 'c1',
        'messageId': 'm1',
        'text': 'edited',
      });
      await _waitFor(() => state.messagesFor('c1').single.text == 'edited');
      await bridge.emit({
        'kind': 'reaction',
        'chatId': 'c1',
        'messageId': 'm1',
        'emoji': '+1',
      });
      await _waitFor(() => state.messagesFor('c1').single.reactions.isNotEmpty);
      await bridge.emit({
        'kind': 'message_deleted',
        'chatId': 'c1',
        'messageId': 'm1',
      });
      await _waitFor(() => state.messagesFor('c1').isEmpty);
      await bridge.emit({'kind': 'chat_deleted', 'chatId': 'c1'});
      await _waitFor(() => state.chats.isEmpty);
    });

    test(
      'malformed frames are ignored without killing the subscription',
      () async {
        final bridge = await MockBridge.start();
        addTearDown(bridge.close);
        final state = await stateFor(configFor(bridge));
        addTearDown(state.dispose);
        await state.start();
        await _waitFor(() => state.conn == ConnState.connected);
        await _waitFor(() => bridge.streamCount == 1);

        await bridge.writeRaw('data: {not json}\n\n');
        await bridge.emit({'kind': 'message'});
        await bridge.emit({'kind': 'turn_start'});
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(state.conn, ConnState.connected);

        await bridge
            .emit({'kind': 'delta', 'chatId': 'c1', 'text': 'still alive'});
        await _waitFor(() => state.turnFor('c1').draft == 'still alive');
      },
    );

    test(
      'wrong token enters unauthorized state and does not reconnect',
      () async {
        final bridge = await MockBridge.start(token: 'secret');
        addTearDown(bridge.close);
        final state = await stateFor(configFor(bridge, token: 'wrong'));
        addTearDown(state.dispose);

        await state.start();
        await _waitFor(() => state.conn == ConnState.error);
        expect(state.connError, contains('Unauthorized'));
        expect(bridge.streamCount, 0);

        await Future<void>.delayed(const Duration(milliseconds: 950));
        expect(state.conn, ConnState.error);
        expect(state.connError, contains('Unauthorized'));
        expect(bridge.streamCount, 0);
      },
    );

    test('reconnect drops selection of a chat deleted while away', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);

      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      expect(state.selectedChatId, 'c1');

      // The chat is deleted server-side while the client is away.
      bridge.chats
        ..clear()
        ..add({
          'id': 'c2',
          'title': 'Fresh',
          'createdAt': 3,
          'lastActive': 4,
          'preview': '',
        });
      bridge.messages
        ..clear()
        ..['c2'] = [];

      await state.start();
      await _waitFor(() => state.selectedChatId == 'c2');
      expect(state.selectedChat, isNotNull);
    });

    test('setModel/setEffort/renameChat apply optimistically', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      final modelDone = state.setModel('c1', 'm2');
      expect(state.chats.single.model, 'm2');
      await modelDone;

      final effortDone = state.setEffort('c1', 'high');
      expect(state.chats.single.effort, 'high');
      await effortDone;

      final renameDone = state.renameChat('c1', 'Renamed locally');
      expect(state.chats.single.title, 'Renamed locally');
      await renameDone;
    });

    test('failed chat command surfaces a system note, not a throw', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      // The mock bridge has no /chats/rename endpoint → the POST 404s. That
      // must land as a visible system note in the chat, not an unhandled
      // async exception out of a UI callback.
      await state.renameChat('c1', 'nope');
      final note = state.messagesFor('c1').last;
      expect(note.role, Role.system);
      expect(note.text, contains('Rename failed'));
    });

    test('updateConfig failure returns null and keeps the last snapshot',
        () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      final before = await state.loadConfig();
      expect(before, isNotNull);
      expect(before!.pulse, isFalse);

      // A failing POST /config must surface as null (the settings screen
      // reverts its optimistic toggle + toasts), never mutate the cached
      // snapshot, and never throw out of a UI callback.
      bridge.configPostStatus = 500;
      final r = await state.updateConfig({'pulse': true});
      expect(r, isNull);
      expect(state.appConfig?.pulse, isFalse);

      bridge.configPostStatus = 200;
      final r2 = await state.updateConfig({'pulse': true});
      expect(r2?.pulse, isTrue);
      expect(state.appConfig?.pulse, isTrue);
    });

    test('mesh pref setters notify immediately (no waiting on the sync)',
        () async {
      // No bridge on purpose: the pref write + first notifyListeners must
      // not depend on any network/mesh round-trip. The toggle repaint rides
      // that FIRST notify — firing it only after the mesh isolate sync
      // (seconds on Android) left switches reading as stuck.
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final state = AppState(prefs, narrowLayout: false);
      addTearDown(state.dispose);

      var notified = 0;
      state.addListener(() => notified++);
      await state.setMeshSharing(true);
      expect(state.prefs.meshSharing, isTrue);
      expect(notified, greaterThanOrEqualTo(1));

      await state.setMeshPeriodic(true);
      expect(state.prefs.meshPeriodic, isTrue);
      await state.setMeshDeviceControl(true);
      expect(state.prefs.meshDeviceControl, isTrue);
    });

    test('missing backend/effort endpoints degrade gracefully', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      // No /backends or /backend on the mock bridge: fetch returns empty and
      // a switch reports failure instead of throwing.
      final (active, backends) = await state.backends('c1');
      expect(active, '');
      expect(backends, isEmpty);
      final r = await state.setBackend('c1', 'other');
      expect(r.ok, isFalse);
      expect(r.error, isNotNull);
    });

    test('loadOlderMessages pages scrollback and reports exhaustion', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      // 250 messages: initial load caps at 200, one older page remains.
      bridge.messages['c1'] = [
        for (var i = 1; i <= 250; i++)
          {
            'id': '$i',
            'chatId': 'c1',
            'role': i.isEven ? 'assistant' : 'user',
            'text': 'msg $i',
            'ts': i,
          },
      ];
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => state.messagesFor('c1').length == 200);
      expect(state.messagesFor('c1').first.text, 'msg 51');
      expect(state.hasMoreHistory('c1'), isTrue);

      final added = await state.loadOlderMessages('c1');
      expect(added, 50);
      expect(state.messagesFor('c1').length, 250);
      expect(state.messagesFor('c1').first.text, 'msg 1');
      // A 50-row page (< page size) marks the scrollback exhausted.
      expect(state.hasMoreHistory('c1'), isFalse);
      expect(await state.loadOlderMessages('c1'), 0);
    });

    test('reconnect after paging back keeps the thread in order', () async {
      // Regression: the reconnect merge appended every in-memory message
      // missing from the 200-row window — including older scrollback paged
      // in earlier — BELOW the newest history, so week-old messages showed
      // up as the latest after a daemon/Docker restart.
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      bridge.messages['c1'] = [
        for (var i = 1; i <= 250; i++)
          {
            'id': '$i',
            'chatId': 'c1',
            'role': i.isEven ? 'assistant' : 'user',
            'text': 'msg $i',
            'ts': i,
          },
      ];
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => state.messagesFor('c1').length == 200);
      expect(await state.loadOlderMessages('c1'), 50);
      expect(state.messagesFor('c1').length, 250);

      // Daemon restarts → the client reconnects and reloads the window.
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => state.messagesFor('c1').length == 200);

      final ts = state.messagesFor('c1').map((m) => m.ts).toList();
      for (var i = 1; i < ts.length; i++) {
        expect(ts[i], greaterThan(ts[i - 1]), reason: 'out of order at $i');
      }
      expect(state.messagesFor('c1').first.text, 'msg 51');
      expect(state.messagesFor('c1').last.text, 'msg 250');
      // Scrolling back up pages the dropped rows in again, in order.
      expect(state.hasMoreHistory('c1'), isTrue);
      expect(await state.loadOlderMessages('c1'), 50);
      expect(state.messagesFor('c1').first.text, 'msg 1');
      expect(state.messagesFor('c1').last.text, 'msg 250');
    });

    test('searchMessages returns daemon hits', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      final hits = await state.searchMessages('Hello');
      expect(hits, hasLength(1));
      expect(hits.single.chatId, 'c1');
      expect(hits.single.chatTitle, 'General');
      expect(hits.single.message.text, 'Hello');
      expect(await state.searchMessages('zzz-no-match'), isEmpty);
    });

    test('history hydrates persisted tool traces and turn stats', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      bridge.messages['c1']!.add({
        'id': 'm2',
        'chatId': 'c1',
        'role': 'assistant',
        'text': 'done',
        'ts': 20,
        'durationMs': 4200,
        'tokensIn': 1200,
        'tokensOut': 340,
        'tools': [
          {
            'id': 't1',
            'name': 'search',
            'input': {'q': 'talon'},
            'durationMs': 800,
          },
          {'id': 't2', 'name': 'bash', 'error': 'exit 1', 'durationMs': 100},
        ],
      });
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.messagesFor('c1').length == 2);

      final m = state.messagesFor('c1').last;
      expect(m.durationMs, 4200);
      expect(m.tokensIn, 1200);
      expect(m.tokensOut, 340);
      expect(m.tools, hasLength(2));
      expect(m.tools.first.done, isTrue);
      expect(m.tools.first.elapsed.inMilliseconds, 800);
      expect(m.tools.last.error, 'exit 1');
      expect(m.hasStats, isTrue);
    });

    test('unread tracks lastActive vs local read marker', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      // c1 is auto-selected on connect → read.
      expect(state.selectedChatId, 'c1');
      await state.selectChat('c1');
      expect(state.hasUnread(state.chats.single), isFalse);

      // A second chat sees newer activity the user hasn't looked at.
      await bridge.emit({
        'kind': 'chat_created',
        'chat': {
          'id': 'c2',
          'title': 'Other',
          'createdAt': 5,
          'lastActive': DateTime.now().millisecondsSinceEpoch,
          'preview': 'ping',
        },
      });
      await _waitFor(() => state.chats.length == 2);
      final other = state.chats.firstWhere((c) => c.id == 'c2');
      expect(state.hasUnread(other), isTrue);

      await state.selectChat('c2');
      expect(state.hasUnread(other), isFalse);
    });

    test('offline snapshot hydrates chats and messages at construction',
        () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      await state.start();
      await _waitFor(() => state.messagesFor('c1').isNotEmpty);
      // Let the debounced snapshot land.
      await Future<void>.delayed(const Duration(milliseconds: 2300));
      final prefs = state.prefs;
      state.dispose();

      // A brand-new AppState (fresh launch) renders from the snapshot
      // without any connection.
      final cold = AppState(prefs, narrowLayout: false);
      addTearDown(cold.dispose);
      expect(cold.chats.single.id, 'c1');
      expect(cold.messagesFor('c1').single.text, 'Hello');
      expect(cold.selectedChatId, 'c1');
    });

    test('exportMarkdown renders the conversation', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.messagesFor('c1').isNotEmpty);

      final md = state.exportMarkdown('c1');
      expect(md, contains('# General'));
      expect(md, contains('**User**'));
      expect(md, contains('Hello'));
    });

    test('applyConfig resets stores before loading the new bridge', () async {
      final first = await MockBridge.start();
      final second = await MockBridge.start();
      addTearDown(first.close);
      addTearDown(second.close);
      second.chats
        ..clear()
        ..add({
          'id': 'c2',
          'title': 'Second',
          'createdAt': 10,
          'lastActive': 10,
          'preview': '',
        });
      second.messages
        ..clear()
        ..['c2'] = [];

      final state = await stateFor(configFor(first));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.messagesFor('c1').isNotEmpty);
      await _waitFor(() => first.streamCount == 1);

      await state.applyConfig(configFor(second));
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => second.streamCount == 1);

      expect(state.chats.single.id, 'c2');
      expect(state.selectedChatId, 'c2');
      expect(state.messagesFor('c1'), isEmpty);
      expect(state.turnFor('c1').draft, '');
    });
  });

  group('narrow (phone) layout selection', () {
    test('connect does not auto-select a chat — the list is the first screen',
        () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge), narrowLayout: true);
      addTearDown(state.dispose);

      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      expect(state.chats, isNotEmpty);
      expect(state.selectedChatId, isNull);
    });

    test('back-to-list survives a reconnect (no re-auto-selection)', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge), narrowLayout: true);
      addTearDown(state.dispose);

      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await state.selectChat('c1');
      expect(state.selectedChatId, 'c1');

      // System back → chat list.
      state.clearSelection();
      expect(state.selectedChatId, isNull);

      // A reconnect (network blip, resume) re-syncs chats; it must not
      // navigate the user back into a conversation they left.
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      expect(state.selectedChatId, isNull);
    });

    test('growing into the wide layout adopts the most recent chat', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge), narrowLayout: true);
      addTearDown(state.dispose);

      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      expect(state.selectedChatId, isNull);

      // Rotate / resize into the two-pane layout: an empty conversation pane
      // is dead weight, so the most recent chat is adopted.
      state.setNarrowLayout(false);
      // Selection applies immediately; the notify is deferred a microtask.
      expect(state.selectedChatId, 'c1');

      // Shrinking back leaves whatever was open alone.
      state.setNarrowLayout(true);
      expect(state.selectedChatId, 'c1');
    });
  });

  group('system notices', () {
    test('stale backend-switch notice does not resurrect on history reload',
        () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => bridge.streamCount == 1);
      await _waitFor(() => state.messagesFor('c1').isNotEmpty);

      // The daemon broadcasts backend-switch notices transiently — they are
      // never persisted into server history.
      await bridge.emit({
        'kind': 'message',
        'chatId': 'c1',
        'message': {
          'id': 'sys-1',
          'chatId': 'c1',
          'role': 'system',
          'text': 'Switched to codex — starting a fresh conversation.',
          'ts': 20,
        },
      });
      await _waitFor(() => state.messagesFor('c1').length == 2);

      // The conversation moves on: a newer real message lands in history.
      bridge.messages['c1']!.add({
        'id': '30',
        'chatId': 'c1',
        'role': 'assistant',
        'text': 'Later reply',
        'ts': 30,
      });

      // Reconnect (app reopened / network blip) → history reloads. The stale
      // notice must NOT be re-pinned below the fresh history.
      await state.start();
      await _waitFor(() => state.messagesFor('c1').any((m) => m.id == '30'));
      final ids = state.messagesFor('c1').map((m) => m.id).toList();
      expect(ids, isNot(contains('sys-1')));
      expect(ids.last, '30');
    });

    test('a notice newer than all history survives a reload', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => bridge.streamCount == 1);
      await _waitFor(() => state.messagesFor('c1').isNotEmpty);

      // Notice arrives AFTER the newest history message — it's live context
      // and must stay through a reconnect's history reload.
      await bridge.emit({
        'kind': 'message',
        'chatId': 'c1',
        'message': {
          'id': 'sys-2',
          'chatId': 'c1',
          'role': 'system',
          'text': 'Switched to codex — starting a fresh conversation.',
          'ts': 99,
        },
      });
      await _waitFor(() => state.messagesFor('c1').length == 2);

      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      // The post-reconnect history reload must keep the live notice.
      await _waitFor(
        () => state.messagesFor('c1').any((m) => m.id == 'sys-2'),
      );
      expect(state.messagesFor('c1').last.id, 'sys-2');
    });

    test('consecutive identical notices collapse into one row', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => state.messagesFor('c1').isNotEmpty);

      await bridge
          .emit({'kind': 'error', 'chatId': 'c1', 'message': 'Rate limited'});
      await bridge
          .emit({'kind': 'error', 'chatId': 'c1', 'message': 'Rate limited'});
      await bridge
          .emit({'kind': 'error', 'chatId': 'c1', 'message': 'Rate limited'});
      await _waitFor(
          () => state.messagesFor('c1').any((m) => m.text == 'Rate limited'));
      // A different notice still appends normally.
      await bridge
          .emit({'kind': 'error', 'chatId': 'c1', 'message': 'Stream closed'});
      await _waitFor(
          () => state.messagesFor('c1').any((m) => m.text == 'Stream closed'));

      final notices =
          state.messagesFor('c1').where((m) => m.text == 'Rate limited');
      expect(notices.length, 1);
    });
  });

  group('send failure', () {
    test('sendMessage reports failure so the composer can restore the draft',
        () async {
      final bridge = await MockBridge.start();
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      expect(await state.sendMessage('hello there'), isTrue);

      // Bridge dies → the send must fail loudly, not vanish.
      await bridge.close();
      expect(await state.sendMessage('goodbye?'), isFalse);
      expect(
        state.messagesFor('c1').any((m) => m.text.startsWith('Failed to send')),
        isTrue,
      );
    });
  });

  group('AppState resume after silence', () {
    test('reopens a stream that has been quiet past the threshold', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      expect(bridge.eventRequests, hasLength(1));

      // Fresh stream: resuming must not churn the connection.
      state.reconnectIfStale();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(bridge.eventRequests, hasLength(1));

      // Resumed "40 s later" with nothing heard since: reopen.
      state.reconnectIfStale(
        now: DateTime.now().add(const Duration(seconds: 40)),
      );
      await _waitFor(() => bridge.eventRequests.length == 2);
      await _waitFor(() => state.conn == ConnState.connected);
    });

    test('resumeUiStream resets backoff and reconnects immediately', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      state.pauseUiStream();
      expect(state.conn, ConnState.idle);
      expect(state.uiStreamPaused, isTrue);

      state.resumeUiStream();
      expect(state.uiStreamPaused, isFalse);
      await _waitFor(() => state.conn == ConnState.connected);
      expect(bridge.eventRequests.length, greaterThanOrEqualTo(2));
    });

    test('reconnectIfStale reconnects immediately if disconnected', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);

      state.pauseUiStream();
      expect(state.conn, ConnState.idle);

      state.reconnectIfStale();
      await _waitFor(() => state.conn == ConnState.connected);
      expect(bridge.eventRequests.length, greaterThanOrEqualTo(2));
    });
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final end = DateTime.now().add(timeout);
  while (!test()) {
    if (DateTime.now().isAfter(end)) {
      fail('Timed out waiting for condition');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
