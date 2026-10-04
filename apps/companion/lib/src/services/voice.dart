import 'dart:async';

import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:flutter/services.dart';

import 'log.dart';
import 'neural_tts.dart';

/// A transcript event tied to one native recognition generation.
class SttTextEvent {
  final String sessionId;
  final String text;

  const SttTextEvent(this.sessionId, this.text);
}

/// A microphone-level event tied to one native recognition generation.
class SttLevelEvent {
  final String sessionId;
  final double level;

  const SttLevelEvent(this.sessionId, this.level);
}

/// A speech-to-text error surfaced by the native recognizer.
class SttError {
  final String sessionId;
  final int code;
  final String message;

  const SttError(this.sessionId, this.code, this.message);

  /// Codes that mean "nothing was heard" — routine in a hands-free loop.
  /// 6 = ERROR_SPEECH_TIMEOUT, 7 = ERROR_NO_MATCH.
  bool get benign => code == 6 || code == 7;

  /// Conditions that are commonly transient during an Android audio handoff.
  ///
  /// Permission and unsupported-language failures intentionally stay fatal.
  bool get recoverable =>
      benign ||
      code == 1 || // network timeout
      code == 2 || // network
      code == 3 || // audio recorder temporarily unavailable
      code == 4 || // recognition server
      code == 5 || // client lifecycle race
      code == 8 || // recognizer busy
      code == 10 || // service throttled
      code == 11; // server disconnected

  @override
  String toString() => 'SttError($sessionId, $code, $message)';
}

/// One TTS lifecycle event. IDs let callers ignore delayed callbacks from a
/// flushed, interrupted, or timed-out utterance.
class TtsEvent {
  final String id;
  final int? errorCode;
  final String? message;
  final bool interrupted;

  const TtsEvent(
    this.id, {
    this.errorCode,
    this.message,
    this.interrupted = false,
  });
}

/// One voice exposed by the active Android text-to-speech engine.
class SpeechVoice {
  final String name;
  final String locale;
  final int quality;
  final int latency;
  final bool networkRequired;
  final bool isDefault;

  const SpeechVoice({
    required this.name,
    required this.locale,
    required this.quality,
    required this.latency,
    required this.networkRequired,
    required this.isDefault,
  });

  factory SpeechVoice.fromMap(Map<Object?, Object?> map) => SpeechVoice(
        name: map['name'] as String? ?? '',
        locale: map['locale'] as String? ?? '',
        quality: (map['quality'] as num?)?.toInt() ?? 300,
        latency: (map['latency'] as num?)?.toInt() ?? 300,
        networkRequired: map['networkRequired'] == true,
        isDefault: map['isDefault'] == true,
      );

  String get qualityLabel {
    if (quality >= 500) return 'Very high quality';
    if (quality >= 400) return 'High quality';
    if (quality <= 200) return 'Compact';
    return 'Standard quality';
  }
}

/// Testable contract used by [VoiceSession]. The production implementation is
/// [VoiceService]; tests use a deterministic in-memory engine so callback
/// ordering and stale-event races can be exercised without a platform channel.
abstract class VoiceEngine {
  Stream<SttTextEvent> get onPartial;
  Stream<SttTextEvent> get onFinal;
  Stream<SttLevelEvent> get onRms;
  Stream<String> get onSttReady;
  Stream<String> get onSttEnd;
  Stream<SttError> get onSttError;
  Stream<TtsEvent> get onTtsStart;
  Stream<TtsEvent> get onTtsDone;
  Stream<TtsEvent> get onTtsError;
  Stream<TtsEvent> get onTtsStopped;

  Future<bool> isSttAvailable();
  Future<bool> requestMicPermission();
  Future<bool> startListening(String sessionId);
  Future<void> stopListening(String sessionId);
  Future<void> cancelListening(String sessionId);

  /// Queue [text] as utterance [id]. With a [neuralSpeaker] the on-device
  /// neural voice speaks it (when one is loaded — native falls back to
  /// Android TTS otherwise); without one, Android TTS with [voiceName].
  Future<bool> speak(
    String text, {
    required String id,
    required double rate,
    double pitch = 1.0,
    String? voiceName,
    bool flush = true,
    int? neuralSpeaker,
  });
  Future<void> stopSpeaking();
}

/// Dart half of the `talon/voice` Android platform channel.
class VoiceService implements VoiceEngine, NeuralTtsBackend {
  VoiceService._() {
    if (supported) _channel.setMethodCallHandler(_onCall);
  }

  static final VoiceService instance = VoiceService._();

  static const _channel = MethodChannel('talon/voice');

  /// Whether this build can have voice at all (the native bridge only exists
  /// in the Android embedding).
  static bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  final _partial = StreamController<SttTextEvent>.broadcast();
  final _finals = StreamController<SttTextEvent>.broadcast();
  final _rms = StreamController<SttLevelEvent>.broadcast();
  final _sttReady = StreamController<String>.broadcast();
  final _sttErrors = StreamController<SttError>.broadcast();
  final _sttEnd = StreamController<String>.broadcast();
  final _ttsStart = StreamController<TtsEvent>.broadcast();
  final _ttsDone = StreamController<TtsEvent>.broadcast();
  final _ttsError = StreamController<TtsEvent>.broadcast();
  final _ttsStopped = StreamController<TtsEvent>.broadcast();
  final _assist = StreamController<void>.broadcast();
  final _neuralFailed = StreamController<String>.broadcast();

  @override
  Stream<SttTextEvent> get onPartial => _partial.stream;
  @override
  Stream<SttTextEvent> get onFinal => _finals.stream;
  @override
  Stream<SttLevelEvent> get onRms => _rms.stream;
  @override
  Stream<String> get onSttReady => _sttReady.stream;
  @override
  Stream<SttError> get onSttError => _sttErrors.stream;
  @override
  Stream<String> get onSttEnd => _sttEnd.stream;
  @override
  Stream<TtsEvent> get onTtsStart => _ttsStart.stream;
  @override
  Stream<TtsEvent> get onTtsDone => _ttsDone.stream;
  @override
  Stream<TtsEvent> get onTtsError => _ttsError.stream;
  @override
  Stream<TtsEvent> get onTtsStopped => _ttsStopped.stream;

  Stream<void> get onAssistLaunch => _assist.stream;

  @override
  Stream<String> get onNeuralTtsFailed => _neuralFailed.stream;

  Future<dynamic> _onCall(MethodCall call) async {
    final args = call.arguments;
    String argString(String key) =>
        args is Map ? (args[key] as String? ?? '') : '';
    int? argInt(String key) =>
        args is Map && args[key] is num ? (args[key] as num).toInt() : null;
    final sessionId = argString('sessionId');
    final utteranceId = argString('id');
    switch (call.method) {
      case 'stt.ready':
        _sttReady.add(sessionId);
      case 'stt.partial':
        _partial.add(SttTextEvent(sessionId, argString('text')));
      case 'stt.final':
        _finals.add(SttTextEvent(sessionId, argString('text')));
      case 'stt.rms':
        final level = args is Map ? args['level'] : null;
        if (level is num) {
          _rms.add(
            SttLevelEvent(
              sessionId,
              level.toDouble().clamp(0.0, 1.0),
            ),
          );
        }
      case 'stt.end':
        _sttEnd.add(sessionId);
      case 'stt.error':
        _sttErrors.add(
          SttError(
            sessionId,
            argInt('code') ?? -1,
            argString('message').isEmpty
                ? 'Speech recognition error'
                : argString('message'),
          ),
        );
      case 'tts.start':
        _ttsStart.add(TtsEvent(utteranceId));
      case 'tts.done':
        _ttsDone.add(TtsEvent(utteranceId));
      case 'tts.error':
        _ttsError.add(
          TtsEvent(
            utteranceId,
            errorCode: argInt('code'),
            message: argString('message'),
          ),
        );
      case 'tts.stop':
        _ttsStopped.add(
          TtsEvent(
            utteranceId,
            interrupted: args is Map && args['interrupted'] == true,
          ),
        );
      case 'tts.neuralFailed':
        _neuralFailed.add(argString('message'));
      case 'assist.launch':
        _assist.add(null);
    }
    return null;
  }

  Future<T> _invoke<T>(String method, T fallback, [dynamic args]) async {
    if (!supported) return fallback;
    try {
      final result = await _channel.invokeMethod<T>(method, args);
      return result ?? fallback;
    } on MissingPluginException {
      return fallback;
    } on PlatformException catch (error) {
      AppLog.warn('voice', '$method failed: ${error.code}', error.message);
      return fallback;
    } catch (error) {
      AppLog.warn('voice', '$method failed unexpectedly', error);
      return fallback;
    }
  }

  @override
  Future<bool> isSttAvailable() => _invoke('isSttAvailable', false);

  Future<bool> hasMicPermission() => _invoke('hasMicPermission', false);

  @override
  Future<bool> requestMicPermission() => _invoke('requestMicPermission', false);

  @override
  Future<bool> startListening(String sessionId) =>
      _invoke('startListening', false, {'sessionId': sessionId});

  @override
  Future<void> stopListening(String sessionId) async {
    await _invoke<bool>('stopListening', false, {'sessionId': sessionId});
  }

  @override
  Future<void> cancelListening(String sessionId) async {
    await _invoke<bool>('cancelListening', false, {'sessionId': sessionId});
  }

  @override
  Future<bool> speak(
    String text, {
    required String id,
    required double rate,
    double pitch = 1.0,
    String? voiceName,
    bool flush = true,
    int? neuralSpeaker,
  }) =>
      _invoke('speak', false, {
        'text': text,
        'id': id,
        'rate': rate,
        'pitch': pitch,
        'voice': voiceName,
        'flush': flush,
        if (neuralSpeaker != null) 'neuralSpeaker': neuralSpeaker,
      });

  @override
  Future<bool> isNeuralTtsSupported() => _invoke('neuralSupported', false);

  @override
  Future<bool> loadNeuralTts(String modelDir, {int threads = 0}) =>
      _invoke('neuralLoad', false, {'modelDir': modelDir, 'threads': threads});

  @override
  Future<void> unloadNeuralTts() async {
    await _invoke<bool>('neuralUnload', false);
  }

  @override
  Future<void> stopSpeaking() async {
    await _invoke<bool>('stopSpeaking', false);
  }

  /// Installed voices exposed by the currently selected Android TTS engine.
  Future<List<SpeechVoice>> listVoices() async {
    final raw = await _invoke<dynamic>('listVoices', const <dynamic>[]);
    if (raw is! List) return const [];
    final voices = <SpeechVoice>[];
    for (final item in raw) {
      if (item is Map) {
        final voice = SpeechVoice.fromMap(item);
        if (voice.name.isNotEmpty) voices.add(voice);
      }
    }
    voices.sort((a, b) {
      if (a.isDefault != b.isDefault) return a.isDefault ? -1 : 1;
      final locale = a.locale.compareTo(b.locale);
      if (locale != 0) return locale;
      if (a.quality != b.quality) return b.quality.compareTo(a.quality);
      if (a.networkRequired != b.networkRequired) {
        return a.networkRequired ? -1 : 1;
      }
      return a.name.compareTo(b.name);
    });
    return voices;
  }

  Future<bool> isDefaultAssistant() => _invoke('isDefaultAssistant', false);

  Future<bool> openAssistantSettings() =>
      _invoke('openAssistantSettings', false);

  Future<bool> consumeAssistLaunch() => _invoke('consumeAssistLaunch', false);
}

/// Hard ceiling for a single utterance. Android's
/// `TextToSpeech.getMaxSpeechInputLength()` is 4000 characters on every
/// current release; [splitForSpeech] keeps every chunk well under it so a long
/// reply is spoken in full instead of being truncated.
const int kMaxUtteranceChars = 3200;

/// Emoji, pictographs, dingbats and their variation selectors. Engines either
/// announce these by name ("smiling face with sunglasses") or stumble over
/// them mid-sentence — both sound broken, so they are dropped.
final RegExp _emoji = RegExp(
  '[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}'
  '\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}]',
  unicode: true,
);

/// Convert assistant markdown into something that sounds natural when read
/// aloud: code blocks are summarized, link syntax collapses to its label,
/// URLs, emoji and formatting glyphs disappear, and what is left keeps the
/// punctuation an engine needs for sane prosody.
String speechify(String markdown) {
  var s = markdown;
  // Fenced code blocks → a spoken placeholder (reading code aloud is noise).
  s = s.replaceAll(RegExp(r'```[\s\S]*?```'), ' Code block omitted. ');
  // Inline code keeps its content, loses the backticks.
  s = s.replaceAllMapped(RegExp(r'`([^`]*)`'), (m) => m[1] ?? '');
  // Images vanish; links keep their label.
  s = s.replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), '');
  s = s.replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]*\)'), (m) => m[1] ?? '');
  // Bare URLs → "link".
  s = s.replaceAll(RegExp(r'https?://\S+'), 'link');
  // Table delimiter rows (|---|:--:|) are pure syntax — never speak them.
  s = s.replaceAll(
    RegExp(
      r'^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$',
      multiLine: true,
    ),
    '',
  );
  // Headings / quotes.
  s = s.replaceAll(RegExp(r'^#{1,6}\s*', multiLine: true), '');
  s = s.replaceAll(RegExp(r'^>\s?', multiLine: true), '');
  // Task-list checkboxes before the plain bullet strip below.
  s = s.replaceAll(
    RegExp(r'^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+', multiLine: true),
    '',
  );
  // ([ \t]*, not \s*: \s would swallow the preceding blank line's newline and
  // break paragraph-break detection below.)
  s = s.replaceAll(
    RegExp(r'^[ \t]*[-*+•‣·][ \t]+', multiLine: true),
    '',
  );
  s = s.replaceAll(_emoji, ' ');
  // Arrows and dashes are punctuation for the ear, not symbols to announce.
  s = s.replaceAll(RegExp(r'\s*(->|=>|→|⇒)\s*'), ' to ');
  s = s.replaceAll(RegExp(r'\s*[—–]\s*'), ', ');
  // Emphasis / table glyphs. Underscore becomes a space so snake_case reads as
  // two words instead of one run-on token.
  s = s.replaceAll('_', ' ');
  s = s.replaceAll(RegExp(r'[*~#|]'), '');
  // Entities that survive markdown rendering.
  s = s
      .replaceAll('&amp;', ' and ')
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll(RegExp(r'&[lg]t;'), ' ');
  // Repeated terminal punctuation makes engines pause oddly ("wow!!!").
  s = s.replaceAllMapped(RegExp(r'([!?.])\1{1,}'), (m) => m[1] ?? '');
  // Empty brackets left behind by the stripping above.
  s = s.replaceAll(RegExp(r'\(\s*\)|\[\s*\]'), '');
  // Collapse whitespace runs left behind by the stripping.
  s = s.replaceAll(RegExp(r'[ \t]+'), ' ');
  s = s.replaceAll(RegExp(r'\n{2,}'), '. ').replaceAll('\n', ' ');
  s = s.replaceAllMapped(RegExp(r'\s+([,.;:!?])'), (m) => m[1] ?? '');
  s = s.replaceAll(RegExp(r'\s{2,}'), ' ').trim();
  // A trailing terminator stops engines clipping the final word.
  if (s.isNotEmpty && RegExp(r'[\w"’)]$').hasMatch(s)) s = '$s.';
  return s;
}

/// Split a speech-ready string into utterance-sized chunks on sentence
/// boundaries.
///
/// Three reasons this exists rather than handing the whole reply to the engine:
///   * long replies used to be truncated at the engine's input limit — the tail
///     was simply never spoken;
///   * the first chunk is deliberately short, so audio starts a beat after the
///     reply lands instead of after the whole paragraph is synthesized;
///   * a chunk boundary is a clean place to barge in.
/// Chunks are queued back-to-back natively, so playback stays gapless.
List<String> splitForSpeech(
  String speech, {
  int firstTarget = 16,
  int target = 340,
  int maxChars = kMaxUtteranceChars,
}) {
  final text = speech.trim();
  if (text.isEmpty) return const [];

  final pieces = <String>[];
  for (final sentence in text.split(RegExp(r'(?<=[.!?…])\s+'))) {
    final trimmed = sentence.trim();
    if (trimmed.isEmpty) continue;
    pieces.addAll(_hardWrap(trimmed, maxChars));
  }

  final chunks = <String>[];
  final buffer = StringBuffer();
  var limit = firstTarget;
  for (final piece in pieces) {
    if (buffer.isEmpty) {
      buffer.write(piece);
    } else if (buffer.length + 1 + piece.length <= maxChars) {
      buffer
        ..write(' ')
        ..write(piece);
    } else {
      chunks.add(buffer.toString());
      buffer
        ..clear()
        ..write(piece);
      limit = target;
    }
    if (buffer.length >= limit) {
      chunks.add(buffer.toString());
      buffer.clear();
      limit = target;
    }
  }
  if (buffer.isNotEmpty) chunks.add(buffer.toString());
  return chunks;
}

/// Break a single over-long sentence at commas, then at word boundaries, so no
/// chunk can exceed the engine's input limit.
List<String> _hardWrap(String sentence, int maxChars) {
  if (sentence.length <= maxChars) return [sentence];
  final out = <String>[];
  var rest = sentence;
  while (rest.length > maxChars) {
    final window = rest.substring(0, maxChars);
    var cut = window.lastIndexOf(RegExp(r'[,;:]\s'));
    if (cut < maxChars ~/ 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxChars - 1;
    out.add(rest.substring(0, cut + 1).trim());
    rest = rest.substring(cut + 1).trim();
  }
  if (rest.isNotEmpty) out.add(rest);
  return out;
}
