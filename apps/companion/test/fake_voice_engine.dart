import 'dart:async';

import 'package:talon_companion/src/services/voice.dart';

/// A silent [VoiceEngine]: every stream exists but never emits, and every
/// call resolves without touching a microphone or a speaker.
///
/// Enough to build a [VoiceSession] in a widget test or the screenshot
/// gallery, where the screen only needs a session object to render against —
/// the state-machine soak tests in voice_test.dart drive their own richer
/// fake.
class SilentVoiceEngine implements VoiceEngine {
  final _partial = StreamController<SttTextEvent>.broadcast();
  final _finalText = StreamController<SttTextEvent>.broadcast();
  final _rms = StreamController<SttLevelEvent>.broadcast();
  final _ready = StreamController<String>.broadcast();
  final _end = StreamController<String>.broadcast();
  final _sttError = StreamController<SttError>.broadcast();
  final _ttsStart = StreamController<TtsEvent>.broadcast();
  final _ttsDone = StreamController<TtsEvent>.broadcast();
  final _ttsError = StreamController<TtsEvent>.broadcast();
  final _ttsStopped = StreamController<TtsEvent>.broadcast();

  @override
  Stream<SttTextEvent> get onPartial => _partial.stream;
  @override
  Stream<SttTextEvent> get onFinal => _finalText.stream;
  @override
  Stream<SttLevelEvent> get onRms => _rms.stream;
  @override
  Stream<String> get onSttReady => _ready.stream;
  @override
  Stream<String> get onSttEnd => _end.stream;
  @override
  Stream<SttError> get onSttError => _sttError.stream;
  @override
  Stream<TtsEvent> get onTtsStart => _ttsStart.stream;
  @override
  Stream<TtsEvent> get onTtsDone => _ttsDone.stream;
  @override
  Stream<TtsEvent> get onTtsError => _ttsError.stream;
  @override
  Stream<TtsEvent> get onTtsStopped => _ttsStopped.stream;

  @override
  Future<bool> isSttAvailable() async => true;
  @override
  Future<bool> requestMicPermission() async => true;
  @override
  Future<bool> startListening(String sessionId) async => true;
  @override
  Future<void> stopListening(String sessionId) async {}
  @override
  Future<void> cancelListening(String sessionId) async {}
  @override
  Future<bool> speak(
    String text, {
    required String id,
    required double rate,
    double pitch = 1.0,
    String? voiceName,
    bool flush = true,
    int? neuralSpeaker,
  }) async =>
      true;
  @override
  Future<void> stopSpeaking() async {}

  /// Close every controller — call from a test tearDown.
  Future<void> close() async {
    await Future.wait([
      _partial.close(),
      _finalText.close(),
      _rms.close(),
      _ready.close(),
      _end.close(),
      _sttError.close(),
      _ttsStart.close(),
      _ttsDone.close(),
      _ttsError.close(),
      _ttsStopped.close(),
    ]);
  }
}
