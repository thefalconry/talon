import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/services/voice.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/state/voice_session.dart';

void main() {
  group('speechify', () {
    test('strips markdown emphasis and headings', () {
      expect(
        speechify('# Hello\n\nThis is **bold** and _italic_ text.'),
        'Hello. This is bold and italic text.',
      );
    });

    test('replaces fenced code blocks with a spoken placeholder', () {
      final out = speechify('Before\n```dart\nprint("hi");\n```\nAfter');
      expect(out, contains('Code block omitted'));
      expect(out, isNot(contains('print')));
    });

    test('keeps inline code content, drops backticks', () {
      expect(speechify('Run `flutter test` now'), 'Run flutter test now.');
    });

    test('collapses links to their label and bare URLs to "link"', () {
      expect(
        speechify('See [the docs](https://example.com/a?b=c)'),
        'See the docs.',
      );
      expect(
        speechify('Go to https://example.com/x now'),
        'Go to link now.',
      );
    });

    test('drops images entirely', () {
      expect(speechify('Look ![alt](https://x/y.png) here'), 'Look here.');
    });

    test('flattens lists and quotes', () {
      expect(
        speechify('> quoted\n\n- one\n- two'),
        'quoted. one\ntwo.'.replaceAll('\n', ' '),
      );
    });

    test('drops emoji instead of letting the engine narrate them', () {
      expect(speechify('Shipped it 🚀🎉 all good ✅'), 'Shipped it all good.');
    });

    test('keeps snake_case readable and normalises arrows and dashes', () {
      expect(
        speechify('Set voice_rate then A -> B — done'),
        'Set voice rate then A to B, done.',
      );
    });

    test('drops table delimiter rows and collapses shouty punctuation', () {
      expect(
        speechify('| a | b |\n|---|---|\n| 1 | 2 |\n\nWow!!!'),
        'a b. 1 2. Wow!',
      );
    });

    test('ends on a terminator so engines do not clip the last word', () {
      expect(speechify('no punctuation here'), 'no punctuation here.');
      expect(speechify('already done.'), 'already done.');
    });
  });

  group('splitForSpeech', () {
    test('keeps a short reply as a single utterance', () {
      expect(splitForSpeech('Short answer.'), ['Short answer.']);
    });

    test('starts with a small chunk so audio begins quickly', () {
      final chunks = splitForSpeech(
        'First sentence here. ${'Another sentence follows. ' * 12}',
      );
      expect(chunks.length, greaterThan(1));
      expect(chunks.first, 'First sentence here.');
      expect(chunks.first.length, lessThan(chunks[1].length));
    });

    test('splits on sentence boundaries and loses nothing', () {
      final source = List.generate(40, (i) => 'Sentence number $i.').join(' ');
      final chunks = splitForSpeech(source);
      expect(chunks.join(' '), source);
      for (final chunk in chunks) {
        expect(chunk.length, lessThanOrEqualTo(kMaxUtteranceChars));
      }
    });

    test('hard-wraps a single sentence longer than the engine limit', () {
      final monster = '${'word ' * 2000}end.';
      final chunks = splitForSpeech(monster);
      expect(chunks.length, greaterThan(1));
      for (final chunk in chunks) {
        expect(chunk.length, lessThanOrEqualTo(kMaxUtteranceChars));
      }
      // The tail used to be truncated away with an ellipsis.
      expect(chunks.last.endsWith('end.'), isTrue);
    });
  });

  group('SttError', () {
    test('no-match and timeout are benign; others are not', () {
      expect(const SttError('s1', 6, 'timeout').benign, isTrue);
      expect(const SttError('s1', 7, 'no match').benign, isTrue);
      expect(const SttError('s1', 3, 'audio').recoverable, isTrue);
      expect(const SttError('s1', 8, 'busy').recoverable, isTrue);
      expect(const SttError('s1', 9, 'perm').recoverable, isFalse);
    });

    test('classifies the complete transient Android error set', () {
      for (final code in [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]) {
        expect(
          SttError('s1', code, 'error').recoverable,
          isTrue,
          reason: 'Android speech error $code should retry',
        );
      }
      for (final code in [9, 12, 13, -1]) {
        expect(
          SttError('s1', code, 'error').recoverable,
          isFalse,
          reason: 'Android speech error $code should be surfaced',
        );
      }
    });
  });

  group('VoiceSession lifecycle', () {
    late Prefs prefs;
    late _VoiceAppState state;
    late _FakeVoiceEngine engine;
    late VoiceSession session;
    late bool cleanedUp;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await Prefs.load();
      state = _VoiceAppState(prefs);
      engine = _FakeVoiceEngine();
      cleanedUp = false;
      session = VoiceSession(
        state,
        handsFree: true,
        engine: engine,
        timing: _testTiming,
      );
    });

    void cleanUp() {
      if (cleanedUp) return;
      cleanedUp = true;
      session.dispose();
      engine.dispose();
      state.dispose();
    }

    void rebuildSession({
      VoiceTiming timing = _testTiming,
      bool handsFree = true,
    }) {
      session.dispose();
      session = VoiceSession(
        state,
        handsFree: handsFree,
        engine: engine,
        timing: timing,
      );
    }

    tearDown(cleanUp);

    test('runs two complete hands-free turns back to back', () async {
      await session.start();
      expect(engine.started, ['stt0']);
      engine.ready('stt0');
      expect(session.phase, VoicePhase.listening);

      engine.finalResult('stt0', 'first question');
      await _flush();
      expect(state.sent, ['first question']);
      state.beginTurn();
      state.deliver('First answer');
      expect(session.phase, VoicePhase.speaking);
      expect(engine.spoken.single.text, 'First answer.');
      state.endTurn();
      engine.ttsDone('utt0');
      expect(session.phase, VoicePhase.recovering);

      await _advance(_testTiming.audioHandoff);
      expect(engine.started, ['stt0', 'stt1']);
      engine.ready('stt1');
      engine.finalResult('stt1', 'second question');
      await _flush();
      expect(state.sent, ['first question', 'second question']);
      state.beginTurn();
      state.deliver('Second answer');
      state.endTurn();
      engine.ttsDone('utt1');
      await _advance(_testTiming.audioHandoff);

      expect(engine.started, ['stt0', 'stt1', 'stt2']);
      expect(session.phase, VoicePhase.arming);
      expect(session.errorText, isNull);
      cleanUp();
    });

    test('ignores a stale recognizer error from the previous turn', () async {
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'hello');
      await _flush();
      state.beginTurn();
      state.deliver('Hi');
      state.endTurn();
      engine.ttsDone('utt0');
      await _advance(_testTiming.audioHandoff);
      engine.ready('stt1');

      engine.sttError('stt0', 3, 'Audio recording error');

      expect(session.phase, VoicePhase.listening);
      expect(session.errorText, isNull);
      expect(engine.started.last, 'stt1');
      cleanUp();
    });

    test('treats repeated silence as recovery, never a hard error', () async {
      await session.start();
      for (var i = 0; i < 6; i++) {
        final id = 'stt$i';
        engine.ready(id);
        engine.rms(id, 1);
        expect(session.level, greaterThan(0));
        engine.sttError(id, 6, 'No speech heard');
        expect(session.phase, VoicePhase.recovering);
        expect(session.errorText, isNull);
        expect(session.level, 0);
        final delay = _testTiming
            .silenceBackoff[i.clamp(0, _testTiming.silenceBackoff.length - 1)];
        await _advance(delay);
      }

      expect(engine.started.length, 7);
      expect(session.phase, VoicePhase.arming);
      cleanUp();
    });

    test('coalesces concurrent listen starts', () async {
      final pending = Completer<bool>();
      engine.nextStart = pending.future;

      final first = session.listen();
      final second = session.listen();
      expect(engine.started, ['stt0']);

      pending.complete(true);
      await Future.wait([first, second]);
      expect(engine.started, ['stt0']);
      expect(session.phase, VoicePhase.arming);
      cleanUp();
    });

    test('correlates TTS completion IDs across a reply queue', () async {
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'tell me two things');
      await _flush();
      state.beginTurn();
      state.deliver('One');
      state.deliver('Two');

      expect(engine.spoken.map((item) => item.id), ['utt0']);
      engine.ttsDone('not-current');
      expect(engine.spoken.map((item) => item.id), ['utt0']);
      engine.ttsDone('utt0');
      expect(engine.spoken.map((item) => item.id), ['utt0', 'utt1']);
      engine.ttsDone('utt0');
      expect(session.phase, VoicePhase.speaking);
      state.endTurn();
      engine.ttsDone('utt1');
      expect(session.phase, VoicePhase.recovering);
      cleanUp();
    });

    test('ready watchdog cancels and replaces a stuck recognizer', () async {
      rebuildSession(timing: _watchdogTiming);

      await session.start();
      await _until(
        () => engine.started.length == 2,
        reason: 'the ready watchdog to replace the stuck recognizer',
      );

      expect(engine.cancelled, contains('stt0'));
      expect(engine.started, ['stt0', 'stt1']);
      expect(session.phase, VoicePhase.arming);
      expect(session.diagnostics.watchdogTimeouts, 1);
      expect(session.diagnostics.recognizerRecoveries, 1);
    });

    test('missing final result becomes a silence retry, not an error',
        () async {
      await session.start();
      engine.ready('stt0');
      engine.end('stt0');
      expect(session.phase, VoicePhase.finalizing);

      await _until(
        () => engine.started.length == 2,
        reason: 'the silence retry to restart the recognizer',
      );

      expect(engine.cancelled, contains('stt0'));
      expect(engine.started, ['stt0', 'stt1']);
      expect(session.errorText, isNull);
      expect(session.diagnostics.watchdogTimeouts, 1);
      expect(session.diagnostics.silenceRetries, 1);
    });

    test('bounds recognizer recovery and a manual tap gets a fresh budget',
        () async {
      await session.start();
      engine.ready('stt0');
      engine.sttError('stt0', 3, 'Audio recording error');
      await _advance(_testTiming.errorBackoff[0]);
      engine.ready('stt1');
      engine.sttError('stt1', 8, 'Recognizer busy');
      await _advance(_testTiming.errorBackoff[1]);
      engine.ready('stt2');
      engine.sttError('stt2', 11, 'Service disconnected');

      expect(session.phase, VoicePhase.error);
      expect(session.diagnostics.recognizerRecoveries, 3);
      expect(session.diagnostics.fatalErrors, 1);

      await session.onOrbTap();
      expect(engine.started.last, 'stt3');
      expect(session.errorText, isNull);
      engine.ready('stt3');
      engine.sttError('stt3', 3, 'Audio recording error');
      expect(session.phase, VoicePhase.recovering);
    });

    test('mute cancels a pending silence retry', () async {
      await session.start();
      engine.ready('stt0');
      engine.sttError('stt0', 6, 'No speech heard');
      expect(session.phase, VoicePhase.recovering);

      await session.toggleMute();
      expect(session.muted, isTrue);
      expect(session.phase, VoicePhase.idle);
      await _advance(const Duration(milliseconds: 10));
      expect(engine.started, ['stt0']);

      await session.toggleMute();
      expect(session.muted, isFalse);
      expect(engine.started, ['stt0', 'stt1']);
    });

    test('barge-in ignores the interrupted utterance callback', () async {
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'interrupt the answer');
      await _flush();
      state.beginTurn();
      state.deliver('A long answer');
      expect(session.phase, VoicePhase.speaking);

      await session.onOrbTap();
      expect(engine.stopSpeakingCalls, 1);
      expect(session.phase, VoicePhase.recovering);
      engine.ttsDone('utt0');
      expect(session.phase, VoicePhase.recovering);
      expect(session.diagnostics.staleCallbacks, 1);

      await _advance(_testTiming.audioHandoff);
      expect(engine.started.last, 'stt1');
    });

    test('barge-in holds the bot caption until new speech is transcribed',
        () async {
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'original question');
      await _flush();
      state.beginTurn();
      state.deliver('Interrupted answer stays visible');
      expect(session.assistantCaption, 'Interrupted answer stays visible');

      await session.onOrbTap();
      expect(session.phase, VoicePhase.recovering);
      expect(session.lastUserText, 'original question');
      expect(session.assistantCaption, 'Interrupted answer stays visible');

      await _advance(_testTiming.audioHandoff);
      engine.ready('stt1');
      expect(session.assistantCaption, 'Interrupted answer stays visible');

      engine.partialResult('stt1', 'new question');
      expect(session.partial, 'new question');
      expect(session.assistantCaption, isEmpty);
    });

    test('silence after barge-in does not discard the bot caption', () async {
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'original question');
      await _flush();
      state.beginTurn();
      state.deliver('Keep this through silence');

      await session.onOrbTap();
      await _advance(_testTiming.audioHandoff);
      engine.ready('stt1');
      engine.sttError('stt1', 6, 'No speech heard');
      expect(session.phase, VoicePhase.recovering);
      expect(session.assistantCaption, 'Keep this through silence');

      await _advance(_testTiming.silenceBackoff.first);
      engine.ready('stt2');
      engine.finalResult('stt2', 'replacement question');
      await _flush();
      expect(session.lastUserText, 'replacement question');
      expect(session.assistantCaption, isEmpty);
    });

    test('TTS refusal completes cleanly and hands the mic back', () async {
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'hello');
      await _flush();
      state.beginTurn();
      engine.nextSpeakAccepted = false;
      state.deliver('Reply');
      state.endTurn();
      await _flush();

      expect(session.phase, VoicePhase.recovering);
      expect(session.errorText, isNull);
      await _advance(_testTiming.audioHandoff);
      expect(engine.started.last, 'stt1');
    });

    test('TTS watchdog releases a wedged utterance', () async {
      rebuildSession(timing: _watchdogTiming);
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'hello');
      await _flush();
      state.beginTurn();
      state.deliver('Reply that never completes');
      state.endTurn();

      await _until(
        () => engine.started.length == 2,
        reason: 'the TTS watchdog to hand the microphone back',
      );

      expect(engine.stopSpeakingCalls, greaterThanOrEqualTo(1));
      expect(session.diagnostics.watchdogTimeouts, 1);
      expect(engine.started.last, 'stt1');
      expect(session.errorText, isNull);
    });

    test('forwards the persisted voice and rate to every utterance', () async {
      await prefs.setVoiceName('com.example.voice.en_us');
      await prefs.setVoiceRate(1.35);
      await prefs.setVoicePitch(1.1);
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'hello');
      await _flush();
      state.beginTurn();
      state.deliver('Configured reply');

      expect(engine.spoken.single.voiceName, 'com.example.voice.en_us');
      expect(engine.spoken.single.rate, 1.35);
      expect(engine.spoken.single.pitch, 1.1);
    });

    test('pipelines the chunks of one long reply back-to-back', () async {
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'tell me a long story');
      await _flush();
      state.beginTurn();
      state.deliver(List.generate(12, (i) => 'Sentence number $i.').join(' '));

      // The follow-up chunk is queued while the first is still audible, so
      // Android plays them with no gap — but it is queued, never flushed.
      expect(engine.spoken.length, greaterThanOrEqualTo(2));
      expect(engine.spoken.first.flush, isTrue);
      expect(engine.spoken[1].flush, isFalse);
      expect(engine.spoken.first.text.length,
          lessThan(engine.spoken[1].text.length));

      final chunks = engine.spoken.length;
      engine.ttsDone(engine.spoken.first.id);
      // Completing the audible chunk promotes the queued one instead of
      // speaking it a second time.
      expect(
        engine.spoken.where((s) => s.id == engine.spoken[1].id).length,
        1,
      );
      expect(engine.spoken.length, greaterThanOrEqualTo(chunks));
      expect(session.phase, VoicePhase.speaking);
      cleanUp();
    });

    test('denied availability and permission fail before opening the mic',
        () async {
      engine.available = false;
      await session.start();
      expect(session.phase, VoicePhase.error);
      expect(engine.started, isEmpty);
      expect(session.diagnostics.fatalErrors, 1);

      rebuildSession();
      engine.available = true;
      engine.permission = false;
      await session.start();
      expect(session.phase, VoicePhase.error);
      expect(engine.started, isEmpty);
      expect(session.errorText, contains('microphone access'));
    });

    test('a delayed start cannot resurrect a muted recognizer', () async {
      final pending = Completer<bool>();
      engine.nextStart = pending.future;
      final starting = session.listen();
      expect(session.phase, VoicePhase.arming);

      await session.toggleMute();
      pending.complete(true);
      await starting;
      engine.ready('stt0');

      expect(session.phase, VoicePhase.idle);
      expect(session.muted, isTrue);
      expect(engine.cancelled, contains('stt0'));
      expect(session.diagnostics.staleCallbacks, 1);
    });

    test('send failure is terminal and never starts speech output', () async {
      state.sendAccepted = false;
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'will fail');
      await _flush();

      expect(session.phase, VoicePhase.error);
      expect(session.errorText, contains('Could not send'));
      expect(engine.spoken, isEmpty);
    });

    test('diagnostics contain counters but no conversation content', () async {
      await session.start();
      engine.ready('stt0');
      engine.finalResult('stt0', 'private user words');
      await _flush();
      state.beginTurn();
      state.deliver('private assistant words');

      final diagnostics = session.diagnostics.toString();
      expect(diagnostics, contains('sttStarts=1'));
      expect(diagnostics, contains('utterances=1'));
      expect(diagnostics, isNot(contains('private user words')));
      expect(diagnostics, isNot(contains('private assistant words')));
    });

    test('survives a 20-turn soak with silence and stale callbacks', () async {
      await session.start();
      var sttSequence = 0;
      var utteranceSequence = 0;
      var expectedSilences = 0;

      for (var turn = 0; turn < 20; turn++) {
        var sttId = 'stt$sttSequence';
        engine.ready(sttId);

        // Every fourth turn starts with a completely quiet capture.
        if (turn % 4 == 0) {
          engine.sttError(sttId, 6, 'No speech heard');
          expectedSilences++;
          await _advance(
            _testTiming.silenceBackoff[(expectedSilences - 1)
                .clamp(0, _testTiming.silenceBackoff.length - 1)],
          );
          sttId = 'stt${++sttSequence}';
          engine.ready(sttId);
        }

        // A delayed callback from the prior native generation must be inert.
        if (sttSequence > 0) {
          engine.sttError('stt${sttSequence - 1}', 3, 'stale audio error');
        }

        engine.finalResult(sttId, 'question $turn');
        await _flush();
        state.beginTurn();
        state.deliver('answer $turn part one');
        if (turn.isEven) state.deliver('answer $turn part two');
        state.endTurn();

        final utterancesThisTurn = turn.isEven ? 2 : 1;
        for (var part = 0; part < utterancesThisTurn; part++) {
          engine.ttsDone('utt${utteranceSequence++}');
        }
        await _advance(_testTiming.audioHandoff);
        sttSequence++;
      }

      expect(state.sent, hasLength(20));
      expect(session.diagnostics.completedTurns, 20);
      expect(session.diagnostics.silenceRetries, expectedSilences);
      expect(session.diagnostics.staleCallbacks, greaterThanOrEqualTo(19));
      expect(session.diagnostics.fatalErrors, 0);
      expect(session.errorText, isNull);
      expect(session.phase, VoicePhase.arming);
    });
  });
}

const _testTiming = VoiceTiming(
  readyTimeout: Duration(seconds: 5),
  finalResultTimeout: Duration(milliseconds: 20),
  turnTimeout: Duration(seconds: 5),
  ttsTimeout: Duration(seconds: 5),
  audioHandoff: Duration(milliseconds: 5),
  silenceBackoff: [
    Duration(milliseconds: 1),
    Duration(milliseconds: 2),
    Duration(milliseconds: 3),
  ],
  errorBackoff: [
    Duration(milliseconds: 1),
    Duration(milliseconds: 2),
  ],
);

const _watchdogTiming = VoiceTiming(
  readyTimeout: Duration(milliseconds: 5),
  finalResultTimeout: Duration(milliseconds: 5),
  turnTimeout: Duration(milliseconds: 5),
  ttsTimeout: Duration(milliseconds: 5),
  audioHandoff: Duration(milliseconds: 2),
  silenceBackoff: [Duration(milliseconds: 1)],
  errorBackoff: [Duration(milliseconds: 1), Duration(milliseconds: 2)],
);

Future<void> _advance(Duration duration) =>
    Future<void>.delayed(duration + const Duration(milliseconds: 4));

/// Waits until [ready] holds instead of sleeping for a fixed margin.
///
/// The session drives itself with *chained* timers (a watchdog fires, and only
/// then schedules the backoff timer). A `Future.delayed` in the test races
/// that chain: both are real timers, both fire late under load, and the test's
/// single timer has fewer chances to be late than the session's two. Waiting
/// on the observable effect removes the race; the timeout only bounds how long
/// we are willing to wait for a *correct* implementation.
Future<void> _until(
  bool Function() ready, {
  String reason = 'condition',
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!ready()) {
    if (!DateTime.now().isBefore(deadline)) {
      fail('timed out after $timeout waiting for $reason');
    }
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

Future<void> _flush() => Future<void>.delayed(Duration.zero);

class _VoiceAppState extends AppState {
  _VoiceAppState(super.prefs) : super(narrowLayout: true) {
    selectedChatId = 'c1';
  }

  final messages = <ClientMessage>[];
  final turn = TurnState();
  final sent = <String>[];
  int _messageSequence = 0;
  bool sendAccepted = true;

  @override
  List<ClientMessage> messagesFor(String chatId) => messages;

  @override
  TurnState turnFor(String chatId) => turn;

  @override
  Future<bool> sendMessage(
    String text, {
    List<Attachment> attachments = const [],
  }) async {
    sent.add(text);
    return sendAccepted;
  }

  void beginTurn() {
    turn.reset();
    notifyListeners();
  }

  void deliver(String text) {
    messages.add(
      ClientMessage(
        id: 'm${_messageSequence++}',
        chatId: 'c1',
        role: Role.assistant,
        text: text,
        ts: _messageSequence,
      ),
    );
    notifyListeners();
  }

  void endTurn() {
    turn.active = false;
    turn.typing = false;
    notifyListeners();
  }
}

class _Spoken {
  final String id;
  final String text;
  final double rate;
  final String? voiceName;
  final double pitch;
  final bool flush;

  const _Spoken(
    this.id,
    this.text,
    this.rate,
    this.voiceName, {
    this.pitch = 1.0,
    this.flush = true,
  });
}

class _FakeVoiceEngine implements VoiceEngine {
  final partials = StreamController<SttTextEvent>.broadcast(sync: true);
  final finals = StreamController<SttTextEvent>.broadcast(sync: true);
  final levels = StreamController<SttLevelEvent>.broadcast(sync: true);
  final readyEvents = StreamController<String>.broadcast(sync: true);
  final endEvents = StreamController<String>.broadcast(sync: true);
  final sttErrors = StreamController<SttError>.broadcast(sync: true);
  final ttsStarts = StreamController<TtsEvent>.broadcast(sync: true);
  final ttsDones = StreamController<TtsEvent>.broadcast(sync: true);
  final ttsErrors = StreamController<TtsEvent>.broadcast(sync: true);
  final ttsStops = StreamController<TtsEvent>.broadcast(sync: true);

  final started = <String>[];
  final cancelled = <String>[];
  final stopped = <String>[];
  final spoken = <_Spoken>[];
  Future<bool>? nextStart;
  bool available = true;
  bool permission = true;
  bool nextSpeakAccepted = true;
  int stopSpeakingCalls = 0;

  @override
  Stream<SttTextEvent> get onPartial => partials.stream;
  @override
  Stream<SttTextEvent> get onFinal => finals.stream;
  @override
  Stream<SttLevelEvent> get onRms => levels.stream;
  @override
  Stream<String> get onSttReady => readyEvents.stream;
  @override
  Stream<String> get onSttEnd => endEvents.stream;
  @override
  Stream<SttError> get onSttError => sttErrors.stream;
  @override
  Stream<TtsEvent> get onTtsStart => ttsStarts.stream;
  @override
  Stream<TtsEvent> get onTtsDone => ttsDones.stream;
  @override
  Stream<TtsEvent> get onTtsError => ttsErrors.stream;
  @override
  Stream<TtsEvent> get onTtsStopped => ttsStops.stream;

  @override
  Future<bool> isSttAvailable() async => available;

  @override
  Future<bool> requestMicPermission() async => permission;

  @override
  Future<bool> startListening(String sessionId) {
    started.add(sessionId);
    final result = nextStart;
    nextStart = null;
    return result ?? Future.value(true);
  }

  @override
  Future<void> stopListening(String sessionId) async {
    stopped.add(sessionId);
  }

  @override
  Future<void> cancelListening(String sessionId) async {
    cancelled.add(sessionId);
  }

  @override
  Future<bool> speak(
    String text, {
    required String id,
    required double rate,
    double pitch = 1.0,
    String? voiceName,
    bool flush = true,
  }) async {
    spoken.add(_Spoken(id, text, rate, voiceName, pitch: pitch, flush: flush));
    ttsStarts.add(TtsEvent(id));
    final accepted = nextSpeakAccepted;
    nextSpeakAccepted = true;
    return accepted;
  }

  @override
  Future<void> stopSpeaking() async {
    stopSpeakingCalls++;
  }

  void ready(String id) => readyEvents.add(id);
  void end(String id) => endEvents.add(id);
  void rms(String id, double level) => levels.add(SttLevelEvent(id, level));
  void partialResult(String id, String text) =>
      partials.add(SttTextEvent(id, text));
  void finalResult(String id, String text) =>
      finals.add(SttTextEvent(id, text));
  void sttError(String id, int code, String message) =>
      sttErrors.add(SttError(id, code, message));
  void ttsDone(String id) => ttsDones.add(TtsEvent(id));

  void dispose() {
    partials.close();
    finals.close();
    levels.close();
    readyEvents.close();
    endEvents.close();
    sttErrors.close();
    ttsStarts.close();
    ttsDones.close();
    ttsErrors.close();
    ttsStops.close();
  }
}
