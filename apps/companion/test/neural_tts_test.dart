import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/model_manager.dart';
import 'package:talon_companion/src/services/neural_tts.dart';

class _Backend implements NeuralTtsBackend {
  final failures = StreamController<String>.broadcast(sync: true);
  final loads = <String>[];
  bool supported = true;
  Future<bool> Function() load = () async => true;
  int unloads = 0;

  @override
  Future<bool> isNeuralTtsSupported() async => supported;

  @override
  Future<bool> loadNeuralTts(String modelDir, {int threads = 0}) {
    loads.add(modelDir);
    return load();
  }

  @override
  Future<void> unloadNeuralTts() async {
    unloads++;
  }

  @override
  Stream<String> get onNeuralTtsFailed => failures.stream;
}

void main() {
  late _Backend backend;
  var enabled = true;
  String? installed = '/m';
  String? voice;

  NeuralTtsRouter router() => NeuralTtsRouter(
        backend: backend,
        enabled: () => enabled,
        installedModelDir: () async => installed,
        voiceName: () => voice,
      );

  setUp(() {
    backend = _Backend();
    enabled = true;
    installed = '/m';
    voice = null;
  });

  group('NeuralTtsRouter engine selection', () {
    test('routes to the neural voice once loaded, default speaker af_heart',
        () async {
      final r = router();
      expect(r.route, TtsRoute.system, reason: 'not loaded yet');
      await r.prepare();
      expect(r.state, NeuralLoadState.ready);
      expect(r.route, TtsRoute.neural);
      expect(r.speaker, 3);
      expect(backend.loads, ['/m']);
    });

    test('uses Android TTS while the model is downloading', () async {
      installed = null;
      final r = router();
      await r.prepare();
      expect(r.state, NeuralLoadState.idle);
      expect(r.speaker, isNull);
      expect(backend.loads, isEmpty);

      // Installed later: the next prepare picks it up.
      installed = '/m';
      await r.prepare();
      expect(r.route, TtsRoute.neural);
    });

    test('uses Android TTS after a failed load, and does not retry', () async {
      backend.load = () async => false;
      final r = router();
      await r.prepare();
      await r.prepare();
      expect(r.state, NeuralLoadState.failed);
      expect(r.route, TtsRoute.system);
      expect(backend.loads, hasLength(1));
    });

    test('a load that throws is a failure, not a crash', () async {
      backend.load = () async => throw StateError('native boom');
      final r = router();
      await r.prepare();
      expect(r.state, NeuralLoadState.failed);
      expect(r.speaker, isNull);
    });

    test('uses Android TTS while disabled, even when loaded', () async {
      final r = router();
      await r.prepare();
      expect(r.route, TtsRoute.neural);
      enabled = false;
      expect(r.route, TtsRoute.system);
      expect(r.speaker, isNull);
    });

    test('never loads when disabled', () async {
      enabled = false;
      await router().prepare();
      expect(backend.loads, isEmpty);
    });

    test('uses Android TTS on devices without the native engine', () async {
      backend.supported = false;
      final r = router();
      await r.prepare();
      expect(r.state, NeuralLoadState.failed);
      expect(backend.loads, isEmpty);
    });

    test('a runtime synthesis failure switches to Android TTS', () async {
      final r = router();
      await r.prepare();
      backend.failures.add('onnx error');
      expect(r.route, TtsRoute.system);
      expect(r.lastError, contains('onnx error'));
    });

    test('concurrent prepares load once', () async {
      final gate = Completer<bool>();
      backend.load = () => gate.future;
      final r = router();
      final a = r.prepare();
      final b = r.prepare();
      expect(r.state, isNot(NeuralLoadState.ready));
      gate.complete(true);
      await Future.wait([a, b]);
      expect(backend.loads, hasLength(1));
      expect(r.state, NeuralLoadState.ready);
    });

    test('dispose unloads a loaded model and stops routing to it', () async {
      final r = router();
      await r.prepare();
      await r.dispose();
      expect(backend.unloads, 1);
      expect(r.route, TtsRoute.system);
    });

    test('dispose without a load does not touch the native engine', () async {
      installed = null;
      final r = router();
      await r.prepare();
      await r.dispose();
      expect(backend.unloads, 0);
    });

    test('forPrefs refuses a model that is mid-install', () async {
      final tmp = await Directory.systemTemp.createTemp('router');
      addTearDown(() => tmp.delete(recursive: true));
      final models = ModelManager(root: () async => tmp);
      final r = NeuralTtsRouter.forPrefs(
        backend: backend,
        enabled: () => true,
        voiceName: () => null,
        models: models,
      );
      await r.prepare();
      expect(backend.loads, isEmpty, reason: 'nothing installed');
    });
  });

  group('Kokoro voices', () {
    test('unknown or unset names fall back to the default voice', () {
      expect(kokoroVoiceNamed(null).name, kDefaultKokoroVoice);
      expect(kokoroVoiceNamed('nope').name, kDefaultKokoroVoice);
      expect(kokoroVoiceNamed('bf_emma').id, 21);
    });

    test('speaker ids and names are unique and English-only', () {
      expect(kokoroVoices.map((v) => v.id).toSet(), hasLength(kokoroVoices.length));
      expect(kokoroVoices.map((v) => v.name).toSet(), hasLength(kokoroVoices.length));
      for (final v in kokoroVoices) {
        expect(v.id, inInclusiveRange(0, 27));
        expect(v.name, matches(RegExp(r'^[ab][fm]_')));
      }
    });

    test('the pinned model spec is complete', () {
      expect(kokoroModel.sha256, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(kokoroModel.url.scheme, 'https');
      expect(kokoroModel.requiredFiles, contains('model.int8.onnx'));
    });
  });
}
