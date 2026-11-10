import 'dart:async';

import 'package:flutter/foundation.dart';

import 'log.dart';
import 'model_manager.dart';

/// The Kokoro voice model: int8 multi-language v1.0 as packaged by
/// sherpa-onnx (model, 53 speaker embeddings, lexicons, espeak-ng-data).
/// Apache-2.0. Pinned to the exact release asset; see NOTICE for licensing.
final ModelSpec kokoroModel = ModelSpec(
  id: 'kokoro-int8-multi-lang-v1_0',
  label: 'Kokoro voice',
  url: Uri.parse(
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/'
    'kokoro-int8-multi-lang-v1_0.tar.bz2',
  ),
  sha256: '4c3052abaa60943a341f193888cf6abd68787dae6ab8ae5c925a706caa247e4e',
  sizeBytes: 132303094,
  packaging: ModelPackaging.tarBz2,
  archiveRoot: 'kokoro-int8-multi-lang-v1_0',
  // Keep in sync with KokoroTts.REQUIRED_FILES on the Kotlin side.
  requiredFiles: const [
    'model.int8.onnx',
    'voices.bin',
    'tokens.txt',
    'lexicon-us-en.txt',
    'lexicon-zh.txt',
    'espeak-ng-data/phontab',
  ],
);

/// Installed footprint once unpacked (for the settings copy).
const int kokoroInstalledBytes = 189882497;

/// One Kokoro speaker. [id] is the speaker index inside voices.bin.
@immutable
class KokoroVoice {
  final String name;
  final int id;
  final String label;
  final String accent;
  final bool female;

  const KokoroVoice(this.name, this.id, this.label, this.accent, this.female);

  String get description =>
      '$accent English · ${female ? 'Female' : 'Male'}';
}

/// English speakers of kokoro-multi-lang-v1_0 (IDs 0–27 of 53). The other
/// speakers need languages this build does not phonemize well, so they are
/// not offered. Mapping from the sherpa-onnx model documentation.
const List<KokoroVoice> kokoroVoices = [
  KokoroVoice('af_heart', 3, 'Heart', 'American', true),
  KokoroVoice('af_bella', 2, 'Bella', 'American', true),
  KokoroVoice('af_nicole', 6, 'Nicole', 'American', true),
  KokoroVoice('af_aoede', 1, 'Aoede', 'American', true),
  KokoroVoice('af_kore', 5, 'Kore', 'American', true),
  KokoroVoice('af_sarah', 9, 'Sarah', 'American', true),
  KokoroVoice('af_nova', 7, 'Nova', 'American', true),
  KokoroVoice('af_sky', 10, 'Sky', 'American', true),
  KokoroVoice('af_alloy', 0, 'Alloy', 'American', true),
  KokoroVoice('af_jessica', 4, 'Jessica', 'American', true),
  KokoroVoice('af_river', 8, 'River', 'American', true),
  KokoroVoice('am_michael', 16, 'Michael', 'American', false),
  KokoroVoice('am_fenrir', 14, 'Fenrir', 'American', false),
  KokoroVoice('am_puck', 18, 'Puck', 'American', false),
  KokoroVoice('am_echo', 12, 'Echo', 'American', false),
  KokoroVoice('am_eric', 13, 'Eric', 'American', false),
  KokoroVoice('am_liam', 15, 'Liam', 'American', false),
  KokoroVoice('am_onyx', 17, 'Onyx', 'American', false),
  KokoroVoice('am_adam', 11, 'Adam', 'American', false),
  KokoroVoice('am_santa', 19, 'Santa', 'American', false),
  KokoroVoice('bf_emma', 21, 'Emma', 'British', true),
  KokoroVoice('bf_isabella', 22, 'Isabella', 'British', true),
  KokoroVoice('bf_alice', 20, 'Alice', 'British', true),
  KokoroVoice('bf_lily', 23, 'Lily', 'British', true),
  KokoroVoice('bm_george', 26, 'George', 'British', false),
  KokoroVoice('bm_fable', 25, 'Fable', 'British', false),
  KokoroVoice('bm_lewis', 27, 'Lewis', 'British', false),
  KokoroVoice('bm_daniel', 24, 'Daniel', 'British', false),
];

/// Kokoro's best-rated English voice.
const String kDefaultKokoroVoice = 'af_heart';

KokoroVoice kokoroVoiceNamed(String? name) =>
    kokoroVoices.where((v) => v.name == name).firstOrNull ??
    kokoroVoices.firstWhere((v) => v.name == kDefaultKokoroVoice);

/// Native side of the neural voice (implemented by the Android voice bridge).
abstract class NeuralTtsBackend {
  /// Whether this device can run the neural engine at all.
  Future<bool> isNeuralTtsSupported();

  /// Load the model in [modelDir] once; true when ready. Idempotent.
  Future<bool> loadNeuralTts(String modelDir, {int threads = 0});

  Future<void> unloadNeuralTts();

  /// Neural synthesis failed at runtime (native already re-routed the speech
  /// it was holding to Android TTS).
  Stream<String> get onNeuralTtsFailed;
}

/// Which engine speaks the next utterance.
enum TtsRoute { system, neural }

enum NeuralLoadState { idle, loading, ready, failed }

/// Picks the engine for each utterance: the neural voice when it is enabled,
/// installed and loaded, Android TTS in every other case — while the model is
/// still downloading, after a load or synthesis failure, and when the user
/// has it switched off.
class NeuralTtsRouter {
  NeuralTtsRouter({
    required this.backend,
    required bool Function() enabled,
    required Future<String?> Function() installedModelDir,
    required String? Function() voiceName,
  })  : _enabled = enabled,
        _installedModelDir = installedModelDir,
        _voiceName = voiceName {
    _failures = backend.onNeuralTtsFailed.listen((message) {
      markFailed('synthesis failed: $message');
    });
  }

  /// The production router: the app's model manager + the voice bridge.
  factory NeuralTtsRouter.forPrefs({
    required NeuralTtsBackend backend,
    required bool Function() enabled,
    required String? Function() voiceName,
    ModelManager? models,
  }) {
    final manager = models ?? ModelManager.instance;
    return NeuralTtsRouter(
      backend: backend,
      enabled: enabled,
      voiceName: voiceName,
      installedModelDir: () async {
        // Never load from a model that is mid-install.
        if (manager.status(kokoroModel).busy) return null;
        return manager.installedPath(kokoroModel);
      },
    );
  }

  final NeuralTtsBackend backend;
  final bool Function() _enabled;
  final Future<String?> Function() _installedModelDir;
  final String? Function() _voiceName;
  late final StreamSubscription<String> _failures;

  NeuralLoadState _state = NeuralLoadState.idle;
  NeuralLoadState get state => _state;
  String? lastError;
  Future<void>? _preparing;
  bool _disposed = false;

  /// Load the model if the neural voice is enabled and installed. Safe to
  /// call repeatedly; never throws. Android TTS keeps speaking meanwhile.
  Future<void> prepare() => _preparing ??= _prepare().whenComplete(() {
        _preparing = null;
      });

  Future<void> _prepare() async {
    if (_disposed || !_enabled()) return;
    if (_state == NeuralLoadState.ready || _state == NeuralLoadState.failed) {
      return;
    }
    try {
      if (!await backend.isNeuralTtsSupported()) {
        _fail('not supported on this device');
        return;
      }
      final dir = await _installedModelDir();
      if (dir == null || _disposed) return; // Not installed (yet).
      _state = NeuralLoadState.loading;
      final ok = await backend.loadNeuralTts(dir);
      if (_disposed) return;
      if (ok) {
        _state = NeuralLoadState.ready;
        AppLog.info('voice', 'neural voice ready');
      } else {
        _fail('model failed to load');
      }
    } catch (error) {
      _fail('model failed to load: $error');
    }
  }

  void _fail(String reason) {
    _state = NeuralLoadState.failed;
    lastError = reason;
    AppLog.warn('voice', 'neural voice unavailable, using Android TTS', reason);
  }

  /// Route for the next utterance.
  TtsRoute get route =>
      !_disposed && _enabled() && _state == NeuralLoadState.ready
          ? TtsRoute.neural
          : TtsRoute.system;

  /// Speaker index to send with the next utterance, or null for Android TTS.
  int? get speaker =>
      route == TtsRoute.neural ? kokoroVoiceNamed(_voiceName()).id : null;

  /// Stop using the neural voice for the rest of this session.
  void markFailed(String reason) {
    if (_state == NeuralLoadState.failed) return;
    _fail(reason);
  }

  /// Free the model (voice mode closed).
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _failures.cancel();
    final wasLoaded =
        _state == NeuralLoadState.ready || _state == NeuralLoadState.loading;
    _state = NeuralLoadState.idle;
    if (wasLoaded) {
      try {
        await backend.unloadNeuralTts();
      } catch (error) {
        AppLog.warn('voice', 'neural voice unload failed', error);
      }
    }
  }
}

/// A backend that has no neural engine (tests, non-Android).
class NoNeuralTts implements NeuralTtsBackend {
  const NoNeuralTts();
  @override
  Future<bool> isNeuralTtsSupported() async => false;
  @override
  Future<bool> loadNeuralTts(String modelDir, {int threads = 0}) async => false;
  @override
  Future<void> unloadNeuralTts() async {}
  @override
  Stream<String> get onNeuralTtsFailed => const Stream.empty();
}
