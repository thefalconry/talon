import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart'
    show ChangeNotifier, visibleForTesting;

import '../models/bridge_models.dart';
import '../services/log.dart';
import '../models/tool_format.dart';
import '../services/neural_tts.dart';
import '../services/voice.dart';
import 'app_state.dart';

/// Where the voice conversation currently is.
enum VoicePhase {
  /// Mic idle — tap the orb to talk.
  idle,

  /// Android accepted a new recognition generation; waiting for the mic.
  arming,

  /// Capturing the user's speech (partials streaming in).
  listening,

  /// Speech ended; waiting briefly for the recognizer's final transcript.
  finalizing,

  /// Utterance sent; the agent is working (reasoning / calling tools).
  thinking,

  /// Reading the agent's reply aloud.
  speaking,

  /// A quiet, recoverable handoff or silence retry is in progress.
  recovering,

  /// Something unrecoverable broke — tap the orb to retry.
  error,
}

/// Timing policy kept injectable so the async state machine can be stress
/// tested without sleeping for production-length watchdogs.
class VoiceTiming {
  final Duration readyTimeout;
  final Duration finalResultTimeout;
  final Duration turnTimeout;
  final Duration ttsTimeout;
  final Duration audioHandoff;
  final List<Duration> silenceBackoff;
  final List<Duration> errorBackoff;

  const VoiceTiming({
    this.readyTimeout = const Duration(seconds: 5),
    this.finalResultTimeout = const Duration(seconds: 4),
    this.turnTimeout = const Duration(seconds: 45),
    this.ttsTimeout = const Duration(seconds: 90),
    this.audioHandoff = const Duration(milliseconds: 280),
    this.silenceBackoff = const [
      Duration(milliseconds: 250),
      Duration(milliseconds: 400),
      Duration(milliseconds: 750),
      Duration(milliseconds: 1250),
      Duration(seconds: 2),
    ],
    this.errorBackoff = const [
      Duration(milliseconds: 350),
      Duration(milliseconds: 750),
      Duration(milliseconds: 1500),
      Duration(seconds: 3),
    ],
  });
}

/// Privacy-safe counters for a voice session.
///
/// No transcript or assistant content is retained. The snapshot is suitable
/// for support diagnostics and soak tests where callback races are otherwise
/// extremely difficult to distinguish from microphone or network failures.
class VoiceDiagnostics {
  final String session;
  final VoicePhase phase;
  final int recognitionStarts;
  final int silenceRetries;
  final int recognizerRecoveries;
  final int staleCallbacks;
  final int utterancesStarted;
  final int completedTurns;
  final int watchdogTimeouts;
  final int fatalErrors;

  const VoiceDiagnostics({
    required this.session,
    required this.phase,
    required this.recognitionStarts,
    required this.silenceRetries,
    required this.recognizerRecoveries,
    required this.staleCallbacks,
    required this.utterancesStarted,
    required this.completedTurns,
    required this.watchdogTimeouts,
    required this.fatalErrors,
  });

  @override
  String toString() =>
      'session=$session phase=${phase.name} sttStarts=$recognitionStarts '
      'silenceRetries=$silenceRetries recoveries=$recognizerRecoveries '
      'staleCallbacks=$staleCallbacks utterances=$utterancesStarted '
      'turns=$completedTurns watchdogs=$watchdogTimeouts '
      'fatalErrors=$fatalErrors';
}

/// The voice-mode conversation loop.
///
/// Native callbacks are asynchronous and can legally arrive after a stop,
/// timeout, or barge-in. Every STT generation and TTS utterance therefore has
/// an ID; callbacks only mutate state when their ID still owns the session.
class VoiceSession extends ChangeNotifier {
  static int _diagnosticSequence = 0;

  final AppState state;
  final VoiceEngine engine;
  final VoiceTiming timing;

  /// Chooses between the on-device neural voice and Android TTS per
  /// utterance. Tests inject one; with an injected [engine] and no router the
  /// session speaks with the system voice only.
  final NeuralTtsRouter neuralTts;
  late final String diagnosticId = 'voice-${_diagnosticSequence++}';

  /// Keep listening after each reply (conversation style) vs tap-to-talk.
  bool handsFree;

  VoiceSession(
    this.state, {
    required this.handsFree,
    VoiceEngine? engine,
    NeuralTtsRouter? neuralTts,
    this.timing = const VoiceTiming(),
  })  : engine = engine ?? VoiceService.instance,
        neuralTts = neuralTts ??
            (engine == null
                ? NeuralTtsRouter.forPrefs(
                    backend: VoiceService.instance,
                    enabled: () => state.prefs.neuralVoiceEnabled,
                    voiceName: () => state.prefs.neuralVoiceName,
                  )
                : NeuralTtsRouter(
                    backend: const NoNeuralTts(),
                    enabled: () => false,
                    installedModelDir: () async => null,
                    voiceName: () => null,
                  )) {
    state.addListener(_onAppState);
    _subs.addAll([
      this.engine.onSttReady.listen(_onSttReady),
      this.engine.onPartial.listen(_onPartial),
      this.engine.onFinal.listen(_onFinal),
      this.engine.onRms.listen(_onRms),
      this.engine.onSttEnd.listen(_onSttEnd),
      this.engine.onSttError.listen(_onSttError),
      this.engine.onTtsDone.listen(_onTtsDone),
      this.engine.onTtsError.listen(_onTtsError),
      this.engine.onTtsStopped.listen(_onTtsStopped),
    ]);
    AppLog.info('voice', '[$diagnosticId] session created');
  }

  final _subs = <StreamSubscription<dynamic>>[];

  VoicePhase _phase = VoicePhase.idle;
  VoicePhase get phase => _phase;
  String? errorText;

  /// Friendly status while [phase] is [VoicePhase.recovering].
  String recoveryText = 'Getting the microphone ready…';

  /// Live partial transcript while listening.
  String partial = '';

  /// The last utterance actually sent.
  String lastUserText = '';

  /// Smoothed mic level 0..1 (drives the orb pulse).
  double level = 0;

  /// Mic muted: no auto-relisten, orb rests. Speech keeps playing.
  bool muted = false;

  /// The chat this session is talking in (bound at first send).
  String? _chatId;
  String? get chatId => _chatId ?? state.selectedChatId;

  // Recognition lifecycle.
  String? _sttSessionId;
  int _sttSequence = 0;
  bool _listenStarting = false;
  int _listenEpoch = 0;
  int _silenceCount = 0;
  int _recoverableErrors = 0;
  Timer? _readyTimer;
  Timer? _resultTimer;
  Timer? _relistenTimer;

  // Reply tracking for the in-flight turn.
  final Set<String> _seenMessageIds = {};
  final Queue<_SpeechChunk> _speakQueue = Queue();
  _SpeechChunk? _current;

  /// The chunk already handed to the engine behind [_current] so playback runs
  /// back-to-back with no seam. Only ever a continuation of the same message.
  _SpeechChunk? _prefetched;
  String? _heldAssistantCaption;
  String? _currentTtsId;
  int _messageSeq = 0;
  bool _turnSeen = false;
  int _turnEpoch = 0;
  int _utteranceSeq = 0;
  Timer? _stallTimer;
  Timer? _ttsTimer;
  bool _disposed = false;
  int _recognitionStarts = 0;
  int _silenceRetries = 0;
  int _recognizerRecoveries = 0;
  int _staleCallbacks = 0;
  int _utterancesStarted = 0;
  int _completedTurns = 0;
  int _watchdogTimeouts = 0;
  int _fatalErrors = 0;
  final Stopwatch _phaseClock = Stopwatch()..start();

  VoiceDiagnostics get diagnostics => VoiceDiagnostics(
        session: diagnosticId,
        phase: phase,
        recognitionStarts: _recognitionStarts,
        silenceRetries: _silenceRetries,
        recognizerRecoveries: _recognizerRecoveries,
        staleCallbacks: _staleCallbacks,
        utterancesStarted: _utterancesStarted,
        completedTurns: _completedTurns,
        watchdogTimeouts: _watchdogTimeouts,
        fatalErrors: _fatalErrors,
      );

  /// What the captions panel should show for the assistant right now.
  String get assistantCaption {
    final cur = _current;
    if (cur != null) return cur.display;
    final held = _heldAssistantCaption;
    if (held != null) return held;
    final id = chatId;
    if (id == null) return '';
    return state.turnFor(id).draft;
  }

  List<ToolActivity> get tools {
    final id = chatId;
    if (id == null) return const [];
    return state.turnFor(id).tools;
  }

  /// The tool the turn is on right now — the last one still running, or the
  /// most recent one it finished, so a fast call doesn't flash out of the UI
  /// the instant it lands. Null before the turn touches a tool at all.
  ToolActivity? get activeTool {
    final all = tools;
    if (all.isEmpty) return null;
    for (final tool in all.reversed) {
      if (!tool.done) return tool;
    }
    return all.last;
  }

  /// Human phrase for the running tool — "Search emails", not
  /// `mcp__email-tools__search_emails`. Null when nothing is running.
  ///
  /// The screen renders the full [activeTool] card; this stays as the
  /// one-line form for anything that can only carry a string (a future
  /// notification, an Android auto surface, a spoken status).
  String? get toolLabel {
    final tool = activeTool;
    return tool == null || tool.done ? null : toolPhrase(tool.name);
  }

  /// Test/gallery seam: pin the phase (and optionally the captions) without
  /// driving the whole async state machine through a real engine.
  @visibleForTesting
  void debugSetPhase(VoicePhase phase, {String? userText, String? partial}) {
    _phase = phase;
    if (userText != null) lastUserText = userText;
    if (partial != null) this.partial = partial;
    notifyListeners();
  }

  // ── Session control ───────────────────────────────────────────────────────

  Future<void> start() async {
    // Load the neural voice once per session, in parallel with arming the
    // mic; replies use Android TTS until (and unless) it is ready.
    unawaited(neuralTts.prepare());
    final epoch = _listenEpoch;
    final available = await engine.isSttAvailable();
    if (!_isCurrentEpoch(epoch)) return;
    if (!available) {
      _fail('Speech recognition is not available on this device.');
      return;
    }
    final permitted = await engine.requestMicPermission();
    if (!_isCurrentEpoch(epoch)) return;
    if (!permitted) {
      _fail('Talon needs microphone access for voice mode.');
      return;
    }
    await listen();
  }

  /// Begin capturing speech. Repeated calls coalesce into the in-flight start.
  Future<void> listen() => _beginListening();

  Future<void> _beginListening() async {
    if (_disposed || muted || _listenStarting) return;
    if (phase == VoicePhase.thinking || phase == VoicePhase.speaking) return;
    if (phase == VoicePhase.error) {
      // A tap/unmute from the error screen is an explicit fresh attempt.
      _recoverableErrors = 0;
      _silenceCount = 0;
    }

    _relistenTimer?.cancel();
    _readyTimer?.cancel();
    _resultTimer?.cancel();

    final oldId = _sttSessionId;
    if (oldId != null) {
      _sttSessionId = null; // Invalidate callbacks before native cancellation.
      unawaited(engine.cancelListening(oldId));
    }

    final epoch = ++_listenEpoch;
    final sessionId = 'stt${_sttSequence++}';
    _sttSessionId = sessionId;
    _listenStarting = true;
    partial = '';
    errorText = null;
    _recognitionStarts++;
    _transition(VoicePhase.arming, 'recognizer start $sessionId');
    _notify();

    AppLog.debug('voice', '[$diagnosticId] stt start $sessionId');
    var accepted = false;
    try {
      accepted = await engine.startListening(sessionId);
    } catch (error) {
      AppLog.warn(
        'voice',
        '[$diagnosticId] recognizer start threw',
        error,
      );
    }
    if (!_ownsStt(sessionId, epoch)) return;
    _listenStarting = false;
    if (!accepted) {
      _sttSessionId = null;
      _recoverFromRecognizer('The microphone is reconnecting…');
      return;
    }

    _readyTimer = Timer(timing.readyTimeout, () {
      if (!_ownsStt(sessionId, epoch) || phase != VoicePhase.arming) return;
      _watchdogTimeouts++;
      AppLog.warn(
        'voice',
        '[$diagnosticId] stt ready timeout',
        sessionId,
      );
      _sttSessionId = null;
      unawaited(engine.cancelListening(sessionId));
      _recoverFromRecognizer('The microphone took too long — trying again…');
    });
  }

  Future<void> onOrbTap() async {
    switch (phase) {
      case VoicePhase.arming:
      case VoicePhase.listening:
        final id = _sttSessionId;
        if (id == null) return;
        _transition(VoicePhase.finalizing, 'manual end of speech');
        _notify();
        await engine.stopListening(id);
      case VoicePhase.finalizing:
        // Already waiting for the terminal transcript.
        break;
      case VoicePhase.speaking:
        // Barge-in: invalidate the old utterance before stop() can callback.
        final interruptedCaption = _current?.display.trim();
        if (interruptedCaption != null && interruptedCaption.isNotEmpty) {
          // Keep the reply visible while audio hands back to the mic. It is
          // retired only when the recognizer produces a new user caption.
          _heldAssistantCaption = interruptedCaption;
        }
        _speakQueue.clear();
        _current = null;
        _prefetched = null;
        _currentTtsId = null;
        _ttsTimer?.cancel();
        await engine.stopSpeaking();
        _scheduleListening(
          timing.audioHandoff,
          'Listening for you…',
        );
      case VoicePhase.idle:
      case VoicePhase.recovering:
      case VoicePhase.error:
        await _beginListening();
      case VoicePhase.thinking:
        break;
    }
  }

  Future<void> toggleMute() async {
    muted = !muted;
    if (muted) {
      _relistenTimer?.cancel();
      final id = _invalidateStt();
      if (id != null) await engine.cancelListening(id);
      if (phase != VoicePhase.speaking && phase != VoicePhase.thinking) {
        partial = '';
        _transition(VoicePhase.idle, 'microphone muted');
      }
    } else if (phase == VoicePhase.idle ||
        phase == VoicePhase.error ||
        phase == VoicePhase.recovering) {
      await _beginListening();
      return;
    }
    _notify();
  }

  // ── Speech events ─────────────────────────────────────────────────────────

  void _onSttReady(String sessionId) {
    if (!_acceptSttCallback(sessionId, 'ready')) return;
    _readyTimer?.cancel();
    _transition(VoicePhase.listening, 'recognizer ready $sessionId');
    AppLog.debug('voice', '[$diagnosticId] stt ready $sessionId');
    _notify();
  }

  void _onPartial(SttTextEvent event) {
    if (!_acceptSttCallback(event.sessionId, 'partial')) return;
    _readyTimer?.cancel();
    _transition(VoicePhase.listening, 'speech partial');
    partial = event.text;
    if (event.text.trim().isNotEmpty) _heldAssistantCaption = null;
    _silenceCount = 0;
    _recoverableErrors = 0;
    _notify();
  }

  void _onRms(SttLevelEvent event) {
    if (!_acceptSttCallback(event.sessionId, 'level', log: false)) return;
    level = level * 0.55 + event.level * 0.45;
    if (phase == VoicePhase.listening) _notify();
  }

  void _onSttEnd(String sessionId) {
    if (!_acceptSttCallback(sessionId, 'end')) return;
    _readyTimer?.cancel();
    _transition(VoicePhase.finalizing, 'recognizer end of speech');
    _notify();
    _resultTimer?.cancel();
    _resultTimer = Timer(timing.finalResultTimeout, () {
      if (!_ownsSttId(sessionId)) return;
      _watchdogTimeouts++;
      AppLog.warn(
        'voice',
        '[$diagnosticId] stt final-result timeout',
        sessionId,
      );
      _sttSessionId = null;
      unawaited(engine.cancelListening(sessionId));
      _afterEmptyCapture();
    });
  }

  Future<void> _onFinal(SttTextEvent event) async {
    if (!_acceptSttCallback(event.sessionId, 'final')) return;
    _sttSessionId = null;
    _listenStarting = false;
    _readyTimer?.cancel();
    _resultTimer?.cancel();

    final trimmed = event.text.trim();
    if (trimmed.isEmpty) {
      _afterEmptyCapture();
      return;
    }

    _heldAssistantCaption = null;
    _silenceCount = 0;
    _recoverableErrors = 0;
    partial = '';
    lastUserText = trimmed;
    _transition(VoicePhase.thinking, 'user turn captured');
    _turnSeen = false;
    _speakQueue.clear();
    _current = null;
    _prefetched = null;
    _currentTtsId = null;
    _ttsTimer?.cancel();
    final turnEpoch = ++_turnEpoch;
    _notify();

    if (state.selectedChatId == null) {
      await state.newChat();
      if (!_ownsTurn(turnEpoch)) return;
    }
    final id = state.selectedChatId;
    if (id == null) {
      _fail('Not connected to Talon yet.');
      return;
    }
    _chatId = id;
    _seenMessageIds
      ..clear()
      ..addAll(state.messagesFor(id).map((message) => message.id));

    // Picks up a model that finished downloading after the session opened.
    unawaited(neuralTts.prepare());
    final sent = await state.sendMessage(trimmed);
    if (!_ownsTurn(turnEpoch)) return;
    if (!sent) {
      _fail('Could not send the message — check the connection.');
      return;
    }

    _stallTimer?.cancel();
    _stallTimer = Timer(timing.turnTimeout, () {
      if (!_ownsTurn(turnEpoch) || phase != VoicePhase.thinking) return;
      if (!_turnSeen && _speakQueue.isEmpty && _current == null) {
        _watchdogTimeouts++;
        _fail('No reply from Talon.');
      }
    });
  }

  void _onSttError(SttError error) {
    if (!_acceptSttCallback(error.sessionId, 'error')) return;
    _sttSessionId = null;
    _listenStarting = false;
    _readyTimer?.cancel();
    _resultTimer?.cancel();

    if (error.benign) {
      AppLog.debug(
        'voice',
        '[$diagnosticId] routine silence ${error.sessionId}',
      );
      _afterEmptyCapture();
      return;
    }

    AppLog.warn('voice', '[$diagnosticId] stt error', error);
    if (error.recoverable) {
      _recoverFromRecognizer('Reconnecting the microphone…');
      return;
    }
    _fail(error.message);
  }

  void _afterEmptyCapture() {
    partial = '';
    // Do not carry the last recognizer generation's noise floor into the next
    // listening animation. The recovery phase owns the visual handoff.
    level = 0;
    if (handsFree && !muted) {
      final index = _silenceCount.clamp(0, timing.silenceBackoff.length - 1);
      _silenceCount++;
      _silenceRetries++;
      _scheduleListening(
        timing.silenceBackoff[index],
        _silenceCount <= 2
            ? 'Listening when you’re ready…'
            : 'Still here — speak whenever you’re ready',
      );
    } else {
      _transition(VoicePhase.idle, 'empty capture');
      _notify();
    }
  }

  void _recoverFromRecognizer(String message) {
    if (_disposed || muted) return;
    _recognizerRecoveries++;
    if (_recoverableErrors >= timing.errorBackoff.length) {
      _fail('The microphone keeps disconnecting. Tap the orb to try again.');
      return;
    }
    final delay = timing.errorBackoff[_recoverableErrors++];
    _scheduleListening(delay, message);
  }

  void _scheduleListening(Duration delay, String message) {
    if (_disposed || muted) return;
    recoveryText = message;
    _transition(VoicePhase.recovering, message);
    _notify();
    _relistenTimer?.cancel();
    _relistenTimer = Timer(delay, () {
      if (!_disposed && !muted && phase == VoicePhase.recovering) {
        unawaited(_beginListening());
      }
    });
  }

  // ── Turn tracking / speech output ─────────────────────────────────────────

  /// The chat turn currently followed for streamed-token updates.
  TurnState? _turn;

  void _onAppState() {
    if (_disposed) return;
    final id = chatId;
    if (id == null) return;
    final turn = state.turnFor(id);
    // Streamed tokens notify the turn, not AppState (#1059) — follow the
    // current chat's turn too so live captions keep up with the draft.
    if (!identical(turn, _turn)) {
      _turn?.removeListener(_onAppState);
      _turn = turn..addListener(_onAppState);
    }
    if (phase != VoicePhase.thinking && phase != VoicePhase.speaking) return;

    if (turn.active) _turnSeen = true;
    for (final message in state.messagesFor(id)) {
      if (message.role != Role.assistant) continue;
      if (!_seenMessageIds.add(message.id)) continue;
      final speech = speechify(message.text);
      if (speech.isEmpty) continue;
      // Long replies are spoken as sentence-sized chunks: the first one is
      // short so audio starts promptly, and nothing is lost to the engine's
      // input limit the way a single truncated utterance used to be.
      final chunks = splitForSpeech(speech);
      final seq = _messageSeq++;
      for (var i = 0; i < chunks.length; i++) {
        _speakQueue.add(
          _SpeechChunk(
            messageSeq: seq,
            display: message.text,
            speech: chunks[i],
            startsMessage: i == 0,
          ),
        );
      }
    }

    if (phase == VoicePhase.thinking) {
      if (_speakQueue.isNotEmpty) {
        _speakNext();
      } else if (_turnSeen && !turn.active && _current == null) {
        _stallTimer?.cancel();
        _afterReplyFinished();
      } else {
        _notify();
      }
    }
  }

  void _speakNext() {
    if (_disposed) return;
    final promoted = _prefetched;
    final next =
        promoted ?? (_speakQueue.isEmpty ? null : _speakQueue.removeFirst());
    if (next == null) return;
    _prefetched = null;
    // A promoted chunk is already sitting in the engine's queue; re-speaking
    // it would double the audio.
    final alreadyQueued = promoted != null;
    final utteranceId = next.id ?? 'utt${_utteranceSeq++}';
    next.id = utteranceId;
    _current = next;
    _currentTtsId = utteranceId;
    _stallTimer?.cancel();
    _utterancesStarted++;
    _transition(VoicePhase.speaking, 'tts start $utteranceId');
    _notify();

    _ttsTimer?.cancel();
    _ttsTimer = Timer(timing.ttsTimeout, () {
      if (_currentTtsId != utteranceId) return;
      _watchdogTimeouts++;
      AppLog.warn(
        'voice',
        '[$diagnosticId] tts completion timeout',
        utteranceId,
      );
      _currentTtsId = null;
      _current = null;
      _prefetched = null;
      unawaited(engine.stopSpeaking());
      _afterUtteranceFinished();
    });

    if (!alreadyQueued) {
      unawaited(
        _requestSpeech(next.speech, utteranceId, flush: next.startsMessage),
      );
    }
    _prefetchNext();
  }

  /// Queue the following chunk of the *same* message while the current one is
  /// still playing. Android plays queued utterances back-to-back, so a reply
  /// split across chunks sounds like one continuous sentence run instead of a
  /// stutter at every boundary. Chunks of a different message are left alone —
  /// the small pause between separate replies is wanted.
  void _prefetchNext() {
    if (_disposed || _prefetched != null) return;
    final current = _current;
    if (current == null || _speakQueue.isEmpty) return;
    if (_speakQueue.first.messageSeq != current.messageSeq) return;
    final next = _speakQueue.removeFirst();
    final utteranceId = 'utt${_utteranceSeq++}';
    next.id = utteranceId;
    _prefetched = next;
    unawaited(_requestSpeech(next.speech, utteranceId, flush: false));
  }

  Future<void> _requestSpeech(
    String text,
    String utteranceId, {
    bool flush = true,
  }) async {
    var accepted = false;
    final speaker = neuralTts.speaker;
    try {
      accepted = await engine.speak(
        text,
        id: utteranceId,
        rate: state.prefs.voiceRate,
        pitch: state.prefs.voicePitch,
        voiceName: state.prefs.voiceName,
        flush: flush,
        neuralSpeaker: speaker,
      );
    } catch (error) {
      AppLog.warn('voice', '[$diagnosticId] tts request threw', error);
    }
    if (!accepted && speaker != null && !_disposed) {
      // The neural voice refused it: stop using it this session and say the
      // same utterance with Android TTS instead of dropping it.
      neuralTts.markFailed('speak refused');
      try {
        accepted = await engine.speak(
          text,
          id: utteranceId,
          rate: state.prefs.voiceRate,
          pitch: state.prefs.voicePitch,
          voiceName: state.prefs.voiceName,
          flush: flush,
        );
      } catch (error) {
        AppLog.warn('voice', '[$diagnosticId] tts fallback threw', error);
      }
    }
    if (accepted) return;
    AppLog.warn(
      'voice',
      '[$diagnosticId] tts request refused',
      utteranceId,
    );
    if (_prefetched?.id == utteranceId) {
      // Put it back at the head: the current utterance will retry it.
      _speakQueue.addFirst(_prefetched!);
      _prefetched = null;
      return;
    }
    if (_currentTtsId == utteranceId) _finishUtterance(utteranceId);
  }

  void _onTtsDone(TtsEvent event) => _finishUtterance(event.id);

  void _onTtsError(TtsEvent event) {
    if (_dropPrefetched(event.id, 'error')) return;
    if (!_acceptTtsCallback(event.id, 'error')) return;
    AppLog.warn(
      'voice',
      '[$diagnosticId] tts error ${event.errorCode ?? 'unknown'}',
      event.message,
    );
    _finishUtterance(event.id);
  }

  void _onTtsStopped(TtsEvent event) {
    if (_dropPrefetched(event.id, 'stop')) return;
    if (_acceptTtsCallback(event.id, 'stop')) {
      _finishUtterance(event.id);
    }
  }

  /// A terminal callback for the pipelined chunk (it failed or was flushed
  /// before it ever became audible) retires just that chunk.
  bool _dropPrefetched(String utteranceId, String event) {
    final queued = _prefetched;
    if (queued == null || queued.id != utteranceId) return false;
    AppLog.debug(
      'voice',
      '[$diagnosticId] dropped prefetched utterance $utteranceId ($event)',
    );
    _prefetched = null;
    return true;
  }

  void _finishUtterance(String utteranceId) {
    if (!_acceptTtsCallback(utteranceId, 'done')) return;
    _ttsTimer?.cancel();
    _currentTtsId = null;
    _current = null;
    _afterUtteranceFinished();
  }

  void _afterUtteranceFinished() {
    if (_prefetched != null || _speakQueue.isNotEmpty) {
      _speakNext();
      return;
    }
    final id = chatId;
    final turnActive = id != null && state.turnFor(id).active;
    if (turnActive) {
      _transition(VoicePhase.thinking, 'waiting for remaining reply');
      _notify();
    } else {
      _afterReplyFinished();
    }
  }

  void _afterReplyFinished() {
    _stallTimer?.cancel();
    _completedTurns++;
    if (handsFree && !muted) {
      _silenceCount = 0;
      _recoverableErrors = 0;
      _scheduleListening(timing.audioHandoff, 'Your turn…');
    } else {
      _transition(VoicePhase.idle, 'reply complete');
      _notify();
    }
  }

  // ── Guards / cleanup ──────────────────────────────────────────────────────

  bool _ownsSttId(String sessionId) => !_disposed && _sttSessionId == sessionId;

  bool _acceptSttCallback(
    String sessionId,
    String event, {
    bool log = true,
  }) {
    if (_ownsSttId(sessionId)) return true;
    if (_disposed) return false;
    _staleCallbacks++;
    if (log) {
      AppLog.debug(
        'voice',
        '[$diagnosticId] ignored stale stt.$event for $sessionId',
      );
    }
    return false;
  }

  bool _acceptTtsCallback(String utteranceId, String event) {
    if (!_disposed && _currentTtsId == utteranceId) return true;
    if (_disposed) return false;
    _staleCallbacks++;
    AppLog.debug(
      'voice',
      '[$diagnosticId] ignored stale tts.$event for $utteranceId',
    );
    return false;
  }

  bool _ownsStt(String sessionId, int epoch) =>
      _ownsSttId(sessionId) && _listenEpoch == epoch;

  bool _isCurrentEpoch(int epoch) => !_disposed && _listenEpoch == epoch;

  bool _ownsTurn(int epoch) => !_disposed && _turnEpoch == epoch;

  String? _invalidateStt() {
    _listenEpoch++;
    _listenStarting = false;
    _readyTimer?.cancel();
    _resultTimer?.cancel();
    final id = _sttSessionId;
    _sttSessionId = null;
    return id;
  }

  void _transition(VoicePhase next, String reason) {
    if (_phase == next) return;
    final elapsedMs = _phaseClock.elapsedMilliseconds;
    AppLog.debug(
      'voice',
      '[$diagnosticId] ${_phase.name} -> ${next.name} '
          'after ${elapsedMs}ms ($reason)',
    );
    _phase = next;
    _phaseClock
      ..reset()
      ..start();
  }

  void _fail(String message) {
    if (_disposed) return;
    _relistenTimer?.cancel();
    _readyTimer?.cancel();
    _resultTimer?.cancel();
    _stallTimer?.cancel();
    _ttsTimer?.cancel();
    _fatalErrors++;
    errorText = message;
    _transition(VoicePhase.error, message);
    AppLog.error('voice', '[$diagnosticId] session failure: $message');
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    AppLog.info('voice', '[$diagnosticId] session disposed: $diagnostics');
    _disposed = true;
    _turnEpoch++;
    _relistenTimer?.cancel();
    _readyTimer?.cancel();
    _resultTimer?.cancel();
    _stallTimer?.cancel();
    _ttsTimer?.cancel();
    final sttId = _invalidateStt();
    for (final subscription in _subs) {
      unawaited(subscription.cancel());
    }
    state.removeListener(_onAppState);
    _turn?.removeListener(_onAppState);
    _turn = null;
    if (sttId != null) unawaited(engine.cancelListening(sttId));
    unawaited(engine.stopSpeaking());
    unawaited(neuralTts.dispose());
    super.dispose();
  }
}

/// One utterance-sized piece of an assistant reply.
///
/// [messageSeq] identifies the message the chunk came from so the session can
/// pipeline chunks of the same reply (gapless) while still leaving a beat
/// between separate replies. [id] is assigned when the chunk is handed to the
/// engine and is what correlates the native callbacks.
class _SpeechChunk {
  final int messageSeq;
  final String display;
  final String speech;
  final bool startsMessage;
  String? id;

  _SpeechChunk({
    required this.messageSeq,
    required this.display,
    required this.speech,
    required this.startsMessage,
  });
}
