/// Voice mode preferences + the Android digital-assistant role. Android
/// only — `VoiceService.supported` gates the card at the call site. Owns the
/// voice list, the assistant-role probe (refreshed when the app resumes from
/// the system picker), and the preview playback, which stops when the card
/// leaves the tree.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../services/haptics.dart';
import '../../services/voice.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import 'neural_voice_section.dart';
import 'settings_widgets.dart';

class VoiceCard extends StatefulWidget {
  final AppState state;
  const VoiceCard({super.key, required this.state});

  @override
  State<VoiceCard> createState() => _VoiceCardState();
}

class _VoiceCardState extends State<VoiceCard> with WidgetsBindingObserver {
  /// Whether Talon currently holds Android's digital-assistant role
  /// (null = unknown/loading). Android only.
  bool? _assistantDefault;
  List<SpeechVoice> _voices = const [];
  bool _voicesLoading = false;
  int _voicePreviewSeq = 0;

  @override
  void initState() {
    super.initState();
    // Observe lifecycle so returning from the system settings picker
    // refreshes the "default assistant" status row immediately.
    WidgetsBinding.instance.addObserver(this);
    _refreshAssistantStatus();
    _loadVoices();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // A settings preview must never keep speaking after its card is gone.
    unawaited(VoiceService.instance.stopSpeaking());
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refreshAssistantStatus();
  }

  Future<void> _refreshAssistantStatus() async {
    if (!VoiceService.supported) return;
    final v = await VoiceService.instance.isDefaultAssistant();
    if (mounted) setState(() => _assistantDefault = v);
  }

  Future<void> _loadVoices() async {
    if (!VoiceService.supported || _voicesLoading) return;
    setState(() => _voicesLoading = true);
    final voices = await VoiceService.instance.listVoices();
    if (!mounted) return;
    setState(() {
      _voices = voices;
      _voicesLoading = false;
    });
  }

  Future<void> _previewVoice(String? voiceName) async {
    final service = VoiceService.instance;
    final id = 'voice-preview-${_voicePreviewSeq++}';
    final complete = Completer<void>();
    final subscriptions = <StreamSubscription<TtsEvent>>[];

    void finish(TtsEvent event) {
      if (event.id == id && !complete.isCompleted) complete.complete();
    }

    subscriptions.addAll([
      service.onTtsDone.listen(finish),
      service.onTtsError.listen(finish),
      service.onTtsStopped.listen(finish),
    ]);
    try {
      await service.stopSpeaking();
      final accepted = await service.speak(
        'Hi, I’m Talon. This is how I’ll sound in voice mode.',
        id: id,
        rate: widget.state.prefs.voiceRate,
        pitch: widget.state.prefs.voicePitch,
        voiceName: voiceName,
      );
      if (accepted) {
        await complete.future.timeout(
          const Duration(seconds: 12),
          onTimeout: () {},
        );
      }
    } finally {
      for (final subscription in subscriptions) {
        await subscription.cancel();
      }
    }
  }

  Future<void> _openVoicePicker() async {
    if (_voicesLoading) return;
    if (_voices.isEmpty) await _loadVoices();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      barrierColor: Colors.black.withValues(alpha: 0.58),
      builder: (_) => _VoicePickerSheet(
        voices: _voices,
        selectedName: widget.state.prefs.voiceName,
        onSelected: (name) async {
          await widget.state.prefs.setVoiceName(name);
          if (mounted) setState(() {});
        },
        onPreview: _previewVoice,
      ),
    );
    if (mounted) setState(() {});
  }

  /// Voice mode preferences + the Android digital-assistant role. Android
  /// only — VoiceService.supported gates the card at the call site.
  @override
  Widget build(BuildContext context) {
    final prefs = widget.state.prefs;
    final isDefault = _assistantDefault;
    final selected =
        _voices.where((voice) => voice.name == prefs.voiceName).firstOrNull;
    return SettingsSection(
      title: 'Voice',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Default-assistant status + the jump into system settings. The
          // role can only be granted there, so this row is a signpost.
          Row(
            children: [
              AnimatedSwitcher(
                duration: TalonMotion.base,
                child: Icon(
                  key: ValueKey(isDefault),
                  isDefault == true
                      ? Icons.verified_rounded
                      : Icons.assistant_outlined,
                  size: 20,
                  color:
                      isDefault == true ? TalonColors.ok : TalonColors.textDim,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Default assistant',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      isDefault == null
                          ? 'Checking…'
                          : isDefault
                              ? 'Talon answers the assistant gesture'
                              : 'Let the assistant gesture open Talon voice '
                                  'mode',
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.35,
                        color: TalonColors.textFaint,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              TextButton(
                onPressed: () async {
                  final ok =
                      await VoiceService.instance.openAssistantSettings();
                  if (!ok && context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Could not open system settings'),
                      ),
                    );
                  }
                },
                child: Text(isDefault == true ? 'Change' : 'Set up'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Semantics(
            button: true,
            enabled: !_voicesLoading,
            child: InkWell(
              borderRadius: BorderRadius.circular(18),
              onTap: _voicesLoading ? null : _openVoicePicker,
              child: AnimatedContainer(
                duration: TalonMotion.base,
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      TalonColors.accent.withValues(alpha: 0.14),
                      TalonColors.accent2.withValues(alpha: 0.07),
                    ],
                  ),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(
                    color: TalonColors.accent.withValues(alpha: 0.26),
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: TalonColors.accent.withValues(alpha: 0.16),
                      ),
                      child: AnimatedSwitcher(
                        duration: TalonMotion.fast,
                        child: Icon(
                          _voicesLoading
                              ? Icons.hourglass_top_rounded
                              : Icons.graphic_eq_rounded,
                          key: ValueKey(_voicesLoading),
                          color: TalonColors.accent,
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            selected == null
                                ? 'Best available voice'
                                : _voiceDisplayName(selected),
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            selected == null
                                ? (_voicesLoading
                                    ? 'Finding voices on this device…'
                                    : 'Highest-quality voice for your language, '
                                        'picked automatically')
                                : _voiceDescription(selected),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 12,
                              color: TalonColors.textFaint,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Icon(
                      Icons.chevron_right_rounded,
                      color: TalonColors.textDim,
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          NeuralVoiceSection(prefs: prefs),
          const SizedBox(height: 4),
          settingsSwitchRow(
            'Hands-free conversation',
            'Keep listening after each reply — talk back and forth without '
                'touching the screen',
            prefs.voiceHandsFree,
            (v) {
              Haptics.selection();
              prefs.setVoiceHandsFree(v);
              setState(() {});
            },
          ),
          settingsSwitchRow(
            'Captions',
            'Show the live transcript in voice mode (toggleable in-session '
                'too)',
            prefs.voiceCaptions,
            (v) {
              Haptics.selection();
              prefs.setVoiceCaptions(v);
              setState(() {});
            },
          ),
          const SizedBox(height: 4),
          // Speech-rate slider: how fast Talon reads replies aloud.
          Row(
            children: [
              Expanded(
                child: Text(
                  'Speech rate',
                  style: TextStyle(fontSize: 13, color: TalonColors.textDim),
                ),
              ),
              Text(
                '${prefs.voiceRate.toStringAsFixed(1)}×',
                style: TalonType.mono.copyWith(
                  fontSize: 12,
                  color: TalonColors.textDim,
                ),
              ),
              const SizedBox(width: 4),
              IconButton(
                tooltip: 'Preview voice and speed',
                visualDensity: VisualDensity.compact,
                onPressed: () => _previewVoice(prefs.voiceName),
                icon: const Icon(Icons.play_circle_outline_rounded, size: 21),
              ),
            ],
          ),
          Slider(
            value: prefs.voiceRate,
            min: 0.6,
            max: 1.6,
            divisions: 10,
            onChanged: (v) {
              prefs.setVoiceRate(v);
              setState(() {});
            },
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Row(
              children: [
                Text(
                  'Relaxed',
                  style:
                      TextStyle(fontSize: 10.5, color: TalonColors.textFaint),
                ),
                const Spacer(),
                Text(
                  'Expressive',
                  style:
                      TextStyle(fontSize: 10.5, color: TalonColors.textFaint),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          // Pitch: a narrow ±20% band. Wider than that and every engine starts
          // sounding like a cartoon rather than a different speaker.
          Row(
            children: [
              Expanded(
                child: Text(
                  'Pitch',
                  style: TextStyle(fontSize: 13, color: TalonColors.textDim),
                ),
              ),
              Text(
                '${prefs.voicePitch.toStringAsFixed(2)}×',
                style: TalonType.mono.copyWith(
                  fontSize: 12,
                  color: TalonColors.textDim,
                ),
              ),
            ],
          ),
          Slider(
            value: prefs.voicePitch,
            min: 0.8,
            max: 1.2,
            divisions: 8,
            onChanged: (v) {
              prefs.setVoicePitch(v);
              setState(() {});
            },
          ),
        ],
      ),
    );
  }
}

String _voiceDisplayName(SpeechVoice voice) {
  final locale = _spokenLocale(voice.locale);
  if (voice.networkRequired && voice.quality >= 400) return '$locale · Natural';
  if (voice.quality >= 400) return '$locale · Enhanced';
  if (voice.networkRequired) return '$locale · Online';
  return '$locale · On-device';
}

String _voiceDescription(SpeechVoice voice) {
  final source = voice.networkRequired ? 'Uses network' : 'Available offline';
  return '${voice.qualityLabel} · $source';
}

String _spokenLocale(String tag) {
  final normalized = tag.replaceAll('_', '-');
  final parts = normalized.split('-');
  const languages = {
    'ar': 'Arabic',
    'de': 'German',
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'hi': 'Hindi',
    'it': 'Italian',
    'ja': 'Japanese',
    'ko': 'Korean',
    'nl': 'Dutch',
    'pl': 'Polish',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'sv': 'Swedish',
    'tr': 'Turkish',
    'zh': 'Chinese',
  };
  const regions = {
    'AU': 'Australia',
    'CA': 'Canada',
    'GB': 'UK',
    'IE': 'Ireland',
    'IN': 'India',
    'NZ': 'New Zealand',
    'US': 'US',
  };
  final language =
      languages[parts.first.toLowerCase()] ?? parts.first.toUpperCase();
  if (parts.length < 2) return language;
  final region = regions[parts[1].toUpperCase()] ?? parts[1].toUpperCase();
  return '$language ($region)';
}

/// Immersive voice browser used by Settings. Preview state stays local to the
/// sheet so the play affordance animates immediately without rebuilding the
/// entire settings route.
class _VoicePickerSheet extends StatefulWidget {
  final List<SpeechVoice> voices;
  final String? selectedName;
  final Future<void> Function(String? name) onSelected;
  final Future<void> Function(String? name) onPreview;

  const _VoicePickerSheet({
    required this.voices,
    required this.selectedName,
    required this.onSelected,
    required this.onPreview,
  });

  @override
  State<_VoicePickerSheet> createState() => _VoicePickerSheetState();
}

class _VoicePickerSheetState extends State<_VoicePickerSheet> {
  String? _selectedName;
  String? _previewingKey;

  @override
  void initState() {
    super.initState();
    _selectedName = widget.selectedName;
  }

  Future<void> _select(String? name) async {
    Haptics.selection();
    setState(() => _selectedName = name);
    await widget.onSelected(name);
  }

  Future<void> _preview(String? name) async {
    final key = name ?? '__system__';
    if (_previewingKey != null) return;
    Haptics.selection();
    setState(() => _previewingKey = key);
    await widget.onPreview(name);
    if (mounted) setState(() => _previewingKey = null);
  }

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.sizeOf(context).height * 0.82;
    return Container(
      height: height,
      decoration: BoxDecoration(
        color: TalonColors.void1,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(30)),
        border: Border.all(color: TalonColors.glassStroke),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.28),
            blurRadius: 32,
            offset: const Offset(0, -8),
          ),
        ],
      ),
      child: Column(
        children: [
          const SizedBox(height: 10),
          Container(
            width: 42,
            height: 4,
            decoration: BoxDecoration(
              color: TalonColors.textFaint.withValues(alpha: 0.45),
              borderRadius: BorderRadius.circular(99),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 18, 12, 14),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: LinearGradient(
                      colors: [TalonColors.accent, TalonColors.accent2],
                    ),
                  ),
                  child: const Icon(
                    Icons.multitrack_audio_rounded,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(width: 13),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Choose Talon’s voice',
                        style: TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      SizedBox(height: 2),
                      Text(
                        'Preview the voices installed on this device',
                        style: TextStyle(fontSize: 12.5),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Close',
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 2, 16, 24),
              children: [
                _choice(
                  name: null,
                  icon: Icons.auto_awesome_rounded,
                  title: 'System voice',
                  subtitle: 'Follow the Android default voice',
                  network: false,
                ),
                for (final voice in widget.voices)
                  _choice(
                    name: voice.name,
                    icon: voice.networkRequired
                        ? Icons.cloud_outlined
                        : Icons.offline_bolt_outlined,
                    title: _voiceDisplayName(voice),
                    subtitle: '${_voiceDescription(voice)}\n${voice.name}',
                    network: voice.networkRequired,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _choice({
    required String? name,
    required IconData icon,
    required String title,
    required String subtitle,
    required bool network,
  }) {
    final selected = _selectedName == name;
    final previewing = _previewingKey == (name ?? '__system__');
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AnimatedContainer(
        duration: TalonMotion.base,
        curve: Curves.easeOutCubic,
        decoration: BoxDecoration(
          color: selected
              ? TalonColors.accent.withValues(alpha: 0.13)
              : TalonColors.surface,
          borderRadius: BorderRadius.circular(19),
          border: Border.all(
            color: selected
                ? TalonColors.accent.withValues(alpha: 0.62)
                : TalonColors.glassStroke,
            width: selected ? 1.4 : 1,
          ),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(19),
          onTap: () => _select(name),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
            child: Row(
              children: [
                AnimatedContainer(
                  duration: TalonMotion.fast,
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: selected
                        ? TalonColors.accent.withValues(alpha: 0.2)
                        : TalonColors.glassFill,
                  ),
                  child: Icon(
                    selected ? Icons.graphic_eq_rounded : icon,
                    color: selected ? TalonColors.accent : TalonColors.textDim,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          if (network) ...[
                            const SizedBox(width: 7),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 7,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color:
                                    TalonColors.accent2.withValues(alpha: 0.12),
                                borderRadius: BorderRadius.circular(99),
                              ),
                              child: Text(
                                'ONLINE',
                                style: TextStyle(
                                  fontSize: 8.5,
                                  letterSpacing: 0.5,
                                  fontWeight: FontWeight.w800,
                                  color: TalonColors.accent2,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5,
                          height: 1.35,
                          color: TalonColors.textFaint,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  tooltip: 'Preview',
                  onPressed:
                      _previewingKey == null ? () => _preview(name) : null,
                  icon: AnimatedSwitcher(
                    duration: TalonMotion.fast,
                    child: previewing
                        ? SizedBox.square(
                            key: const ValueKey('playing'),
                            dimension: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: TalonColors.accent,
                            ),
                          )
                        : Icon(
                            Icons.play_arrow_rounded,
                            key: const ValueKey('play'),
                            color: TalonColors.textDim,
                          ),
                  ),
                ),
                AnimatedSwitcher(
                  duration: TalonMotion.fast,
                  child: selected
                      ? Icon(
                          Icons.check_circle_rounded,
                          key: const ValueKey('selected'),
                          color: TalonColors.accent,
                          size: 21,
                        )
                      : const SizedBox(
                          key: ValueKey('unselected'),
                          width: 21,
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
