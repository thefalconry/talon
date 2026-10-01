/// Settings → Voice: the on-device neural voice (Kokoro). Android only.
///
/// Turning it on starts the one-time model download (progress, cancel,
/// resume, retry); once installed the user picks a Kokoro speaker, previews
/// it, or deletes the model. Voice mode keeps using Android TTS until the
/// model is installed and loads cleanly.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../services/haptics.dart';
import '../../services/model_manager.dart';
import '../../services/neural_tts.dart';
import '../../services/prefs.dart';
import '../../services/voice.dart';
import '../../theme.dart';
import 'settings_widgets.dart';

class NeuralVoiceSection extends StatefulWidget {
  final Prefs prefs;
  final ModelManager models;
  final VoiceService voice;

  NeuralVoiceSection({
    super.key,
    required this.prefs,
    ModelManager? models,
    VoiceService? voice,
  })  : models = models ?? ModelManager.instance,
        voice = voice ?? VoiceService.instance;

  @override
  State<NeuralVoiceSection> createState() => _NeuralVoiceSectionState();
}

class _NeuralVoiceSectionState extends State<NeuralVoiceSection> {
  bool? _supported;
  bool _loadedForPreview = false;
  int _previewSeq = 0;

  ModelManager get _models => widget.models;

  @override
  void initState() {
    super.initState();
    unawaited(_init());
  }

  Future<void> _init() async {
    final supported = await widget.voice.isNeuralTtsSupported();
    if (!mounted) return;
    setState(() => _supported = supported);
    if (!supported) return;
    await _models.refresh(kokoroModel);
    // Enabled but not installed (app restarted mid-download, or an earlier
    // attempt failed): carry on where it left off.
    if (mounted &&
        widget.prefs.neuralVoiceEnabled &&
        !_models.status(kokoroModel).installed &&
        _models.status(kokoroModel).phase != ModelPhase.failed) {
      unawaited(_models.install(kokoroModel));
    }
  }

  @override
  void dispose() {
    if (_loadedForPreview) unawaited(widget.voice.unloadNeuralTts());
    super.dispose();
  }

  Future<void> _setEnabled(bool on) async {
    Haptics.selection();
    await widget.prefs.setNeuralVoiceEnabled(on);
    if (on) {
      unawaited(_models.install(kokoroModel));
    } else {
      _models.cancel(kokoroModel);
    }
    if (mounted) setState(() {});
  }

  Future<void> _delete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete the neural voice?'),
        content: Text(
          'Frees ${_mb(kokoroInstalledBytes)} MB. Voice mode goes back to the '
          'Android voice; turning the neural voice on again re-downloads it.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Keep'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    if (_loadedForPreview) {
      _loadedForPreview = false;
      await widget.voice.unloadNeuralTts();
    }
    await widget.prefs.setNeuralVoiceEnabled(false);
    await _models.delete(kokoroModel);
    if (mounted) setState(() {});
  }

  Future<void> _preview(KokoroVoice voice) async {
    final dir = await _models.installedPath(kokoroModel);
    if (dir == null) return;
    if (!_loadedForPreview) {
      final ok = await widget.voice.loadNeuralTts(dir);
      if (!ok) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('The neural voice failed to load')),
          );
        }
        return;
      }
      _loadedForPreview = true;
    }
    final id = 'neural-preview-${_previewSeq++}';
    final done = Completer<void>();
    void finish(TtsEvent event) {
      if (event.id == id && !done.isCompleted) done.complete();
    }

    final subs = [
      widget.voice.onTtsDone.listen(finish),
      widget.voice.onTtsError.listen(finish),
      widget.voice.onTtsStopped.listen(finish),
    ];
    try {
      final accepted = await widget.voice.speak(
        'Hi, I’m Talon. This is how I’ll sound in voice mode.',
        id: id,
        rate: widget.prefs.voiceRate,
        neuralSpeaker: voice.id,
      );
      if (accepted) {
        await done.future.timeout(const Duration(seconds: 15), onTimeout: () {});
      }
    } finally {
      for (final sub in subs) {
        await sub.cancel();
      }
    }
  }

  Future<void> _pickVoice() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _KokoroVoiceSheet(
        selected: kokoroVoiceNamed(widget.prefs.neuralVoiceName).name,
        onSelected: (voice) async {
          await widget.prefs.setNeuralVoiceName(voice.name);
          if (mounted) setState(() {});
        },
        onPreview: _preview,
      ),
    );
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    if (_supported != true) return const SizedBox.shrink();
    return ListenableBuilder(
      listenable: _models,
      builder: (context, _) {
        final enabled = widget.prefs.neuralVoiceEnabled;
        final status = _models.status(kokoroModel);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            settingsSwitchRow(
              'Neural voice (Kokoro)',
              'Natural-sounding speech generated on this phone. One-time '
                  '${_mb(kokoroModel.sizeBytes)} MB download; the Android '
                  'voice is used until it is ready.',
              enabled,
              _setEnabled,
            ),
            if (enabled || status.installed || status.busy)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _statusBlock(status, enabled),
              ),
          ],
        );
      },
    );
  }

  Widget _statusBlock(ModelStatus status, bool enabled) {
    final faint = TextStyle(fontSize: 12, color: TalonColors.textFaint);
    if (status.installed) {
      final voice = kokoroVoiceNamed(widget.prefs.neuralVoiceName);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            contentPadding: EdgeInsets.zero,
            enabled: enabled,
            leading: Icon(Icons.record_voice_over_rounded,
                color: TalonColors.accent),
            title: Text('${voice.label} · ${voice.description}'),
            subtitle: Text(voice.name, style: faint),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  tooltip: 'Preview neural voice',
                  onPressed: enabled ? () => _preview(voice) : null,
                  icon: const Icon(Icons.play_circle_outline_rounded),
                ),
                const Icon(Icons.chevron_right_rounded),
              ],
            ),
            onTap: enabled ? _pickVoice : null,
          ),
          Row(
            children: [
              Expanded(
                child: Text(
                  'Installed · ${_mb(kokoroInstalledBytes)} MB on this device',
                  style: faint,
                ),
              ),
              TextButton(onPressed: _delete, child: const Text('Delete')),
            ],
          ),
        ],
      );
    }
    if (status.busy) {
      final label = switch (status.phase) {
        ModelPhase.verifying => 'Verifying download…',
        ModelPhase.extracting => 'Unpacking the voice (this takes a minute)…',
        _ => 'Downloading · ${_mb(status.receivedBytes)} of '
            '${_mb(status.totalBytes)} MB',
      };
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          LinearProgressIndicator(
            value: status.phase == ModelPhase.downloading
                ? status.progress
                : null,
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(child: Text(label, style: faint)),
              if (status.phase == ModelPhase.downloading)
                TextButton(
                  onPressed: () => _models.cancel(kokoroModel),
                  child: const Text('Pause'),
                ),
            ],
          ),
        ],
      );
    }
    final failed = status.phase == ModelPhase.failed;
    final resumable = status.receivedBytes > 0;
    return Row(
      children: [
        Expanded(
          child: Text(
            failed
                ? 'Download failed: ${status.error ?? 'unknown error'}'
                : resumable
                    ? 'Paused at ${_mb(status.receivedBytes)} of '
                        '${_mb(kokoroModel.sizeBytes)} MB'
                    : 'Not downloaded yet',
            style: faint.copyWith(color: failed ? TalonColors.bad : null),
          ),
        ),
        TextButton(
          onPressed: enabled ? () => _models.install(kokoroModel) : null,
          child: Text(failed ? 'Retry' : (resumable ? 'Resume' : 'Download')),
        ),
      ],
    );
  }
}

String _mb(int bytes) => (bytes / (1024 * 1024)).toStringAsFixed(0);

class _KokoroVoiceSheet extends StatefulWidget {
  final String selected;
  final Future<void> Function(KokoroVoice voice) onSelected;
  final Future<void> Function(KokoroVoice voice) onPreview;

  const _KokoroVoiceSheet({
    required this.selected,
    required this.onSelected,
    required this.onPreview,
  });

  @override
  State<_KokoroVoiceSheet> createState() => _KokoroVoiceSheetState();
}

class _KokoroVoiceSheetState extends State<_KokoroVoiceSheet> {
  late String _selected = widget.selected;
  String? _previewing;

  Future<void> _preview(KokoroVoice voice) async {
    if (_previewing != null) return;
    Haptics.selection();
    setState(() => _previewing = voice.name);
    try {
      await widget.onPreview(voice);
    } finally {
      if (mounted) setState(() => _previewing = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.8,
      builder: (context, controller) => Column(
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 18, 20, 8),
            child: Text(
              'Choose the neural voice',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
            ),
          ),
          Expanded(
            child: ListView(
              controller: controller,
              children: [
                for (final voice in kokoroVoices)
                  ListTile(
                    selected: voice.name == _selected,
                    leading: Icon(
                      voice.name == _selected
                          ? Icons.check_circle_rounded
                          : Icons.person_outline_rounded,
                    ),
                    title: Text(voice.label),
                    subtitle: Text(voice.description),
                    trailing: IconButton(
                      tooltip: 'Preview ${voice.label}',
                      onPressed:
                          _previewing == null ? () => _preview(voice) : null,
                      icon: _previewing == voice.name
                          ? const SizedBox.square(
                              dimension: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.play_arrow_rounded),
                    ),
                    onTap: () async {
                      Haptics.selection();
                      setState(() => _selected = voice.name);
                      await widget.onSelected(voice);
                    },
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
