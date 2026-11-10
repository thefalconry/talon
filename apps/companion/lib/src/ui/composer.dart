import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../models/bridge_models.dart';
import '../services/haptics.dart';
import '../state/composer_attachments.dart';
import '../theme.dart';
import 'effects.dart';

/// The message input. Enter sends; Shift+Enter inserts a newline. Grows with
/// content up to a cap, then scrolls. Any number of files of any type can be
/// attached — picked with the paperclip, or dropped onto the chat on desktop
/// — and each uploads the moment it is staged. The send button stays greyed
/// until every one of them is on the daemon, so a message can never go out
/// ahead of its files.
class Composer extends StatefulWidget {
  /// Sends the message; resolves false when the daemon rejected it (dead
  /// bridge, network error) so the draft can be handed back to the user.
  final Future<bool> Function(String text, {List<Attachment> attachments})
      onSend;

  /// Files staged for the next send. Owned by the chat view so the desktop
  /// drop target can stage into the same list this renders.
  final ComposerAttachments attachments;

  final bool enabled;

  /// True while a turn is running for this chat. When set (and the input is
  /// empty) the send button morphs into a stop button — the ChatGPT/Claude
  /// pattern. Typing still turns it back into send so a follow-up can queue.
  final bool running;

  /// Interrupt the running turn. Null when the backend can't interrupt.
  final Future<void> Function()? onStop;

  /// Open full-screen voice mode. Null where voice isn't available (desktop,
  /// no recognizer) — the mic button simply doesn't exist then. Shown in the
  /// send slot while the input is empty, WhatsApp-style.
  final VoidCallback? onVoice;

  /// Optional externally owned text controller and focus node, so the chat
  /// view can put text in the field (Reply quotes a message into it). The
  /// composer creates and disposes its own when these are null.
  final TextEditingController? controller;
  final FocusNode? focusNode;

  const Composer({
    super.key,
    required this.onSend,
    required this.attachments,
    required this.enabled,
    this.running = false,
    this.onStop,
    this.onVoice,
    this.controller,
    this.focusNode,
  });

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  late final TextEditingController _controller =
      widget.controller ?? TextEditingController();
  late final FocusNode _focus = widget.focusNode ?? FocusNode();
  bool _canSend = false;
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_recomputeCanSend);
    widget.attachments.addListener(_onAttachmentsChanged);
    // Files can already be staged at mount — dropped onto the pane while the
    // composer was rebuilding, or handed back by a failed send.
    _canSend = widget.attachments.isNotEmpty;
    _focus.addListener(_onFocus);
  }

  void _onFocus() {
    if (mounted && _focused != _focus.hasFocus) {
      setState(() => _focused = _focus.hasFocus);
    }
  }

  @override
  void didUpdateWidget(Composer old) {
    super.didUpdateWidget(old);
    if (old.attachments != widget.attachments) {
      old.attachments.removeListener(_onAttachmentsChanged);
      widget.attachments.addListener(_onAttachmentsChanged);
      _recomputeCanSend();
    }
  }

  @override
  void dispose() {
    widget.attachments.removeListener(_onAttachmentsChanged);
    _controller.removeListener(_recomputeCanSend);
    _focus.removeListener(_onFocus);
    if (widget.controller == null) _controller.dispose();
    if (widget.focusNode == null) _focus.dispose();
    super.dispose();
  }

  void _onAttachmentsChanged() {
    if (mounted) setState(_recomputeCanSend);
  }

  void _recomputeCanSend() {
    final can =
        _controller.text.trim().isNotEmpty || widget.attachments.isNotEmpty;
    if (can != _canSend) setState(() => _canSend = can);
  }

  /// Pick any number of files of any type. Bytes are deliberately NOT loaded
  /// here (`withData: false`): the send streams each file from its path, so
  /// attaching a large archive costs nothing until it is actually sent.
  Future<void> _pickFiles() async {
    if (!widget.enabled || widget.attachments.uploading) return;
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.any,
        allowMultiple: true,
        withData: false,
      );
      final picked = <StagedFile>[];
      for (final file in result?.files ?? const <PlatformFile>[]) {
        final path = file.path;
        if (path == null) continue;
        final staged = StagedFile.fromPath(path, name: file.name);
        if (staged != null) picked.add(staged);
      }
      if (picked.isEmpty) return;
      widget.attachments.addAll(picked);
    } catch (e) {
      _notify('Could not attach files: $e');
    }
  }

  void _notify(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    final staged = widget.attachments.files.toList();
    if ((text.isEmpty && staged.isEmpty) || !widget.enabled) return;
    // Files upload as they are staged; until every one is up (or a failed one
    // is retried or removed) there is nothing to name, so the send button is
    // disabled and this is only reachable via the Enter key.
    if (!widget.attachments.ready) {
      _notify(widget.attachments.hasFailures
          ? 'Some files did not upload — retry or remove them.'
          : 'Still uploading…');
      return;
    }
    // A send is the one irreversible thing this control does: acknowledge it
    // in the hand, the same way the FAB and long-presses do. Silent on
    // desktop (the engine no-ops) and gated by the Settings haptics switch.
    Haptics.selection();
    _controller.clear();
    setState(() => _canSend = false);
    _focus.requestFocus();

    // Already on the daemon — the send only names them.
    final attachments = widget.attachments.uploadedAttachments;
    // About to go out: clear the staging strip.
    widget.attachments.clear();

    final ok = await widget.onSend(text, attachments: attachments);
    if (!ok && mounted) {
      // Send failed (a system note in the chat explains why). Hand the text
      // and files back rather than losing them — unless the user already
      // started typing a new message.
      if (_controller.text.trim().isEmpty && text.isNotEmpty) {
        _controller.text = text;
      }
      if (widget.attachments.isEmpty && staged.isNotEmpty) {
        widget.attachments.restore(staged);
      }
      _recomputeCanSend();
    }
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent &&
        (event.logicalKey == LogicalKeyboardKey.enter ||
            event.logicalKey == LogicalKeyboardKey.numpadEnter) &&
        !HardwareKeyboard.instance.isShiftPressed) {
      _send();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    // Greyed while any staged file is still going up, and while one has
    // failed — the message would otherwise go out without it.
    final uploading = widget.attachments.uploading;
    final canSend = _canSend &&
        widget.enabled &&
        !uploading &&
        widget.attachments.ready;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 7, 12, 12),
      // The input is the app's one persistent control, so it floats: layered
      // shadow at rest, and on focus the hairline warms to the accent with a
      // soft matching glow — the "you are here" signal.
      child: AnimatedContainer(
        duration: TalonMotion.base,
        curve: TalonMotion.standard,
        decoration: BoxDecoration(
          color: TalonColors.surface.withValues(
            alpha: TalonTheme.isDark ? 0.72 : 0.96,
          ),
          borderRadius: BorderRadius.circular(22),
          border: Border.all(
            color: _focused
                ? TalonColors.accent.withValues(alpha: 0.65)
                : TalonColors.glassStroke,
            width: _focused ? 1.4 : 1,
          ),
          boxShadow: [
            ...TalonShadows.raised,
            if (_focused)
              BoxShadow(
                color: TalonColors.accent.withValues(alpha: 0.18),
                blurRadius: 20,
                offset: const Offset(0, 2),
              ),
          ],
        ),
        padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (widget.attachments.isNotEmpty) _stagingStrip(),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                _AttachButton(
                  enabled: widget.enabled && !uploading,
                  onTap: _pickFiles,
                ),
                Expanded(
                  child: Focus(
                    onKeyEvent: _onKey,
                    child: TextField(
                      controller: _controller,
                      focusNode: _focus,
                      enabled: widget.enabled,
                      minLines: 1,
                      maxLines: 6,
                      textInputAction: TextInputAction.newline,
                      keyboardType: TextInputType.multiline,
                      style: TextStyle(
                          fontSize: TalonDensity.d(14.5, 16), height: 1.4),
                      decoration: InputDecoration(
                        isCollapsed: true,
                        border: InputBorder.none,
                        contentPadding:
                            const EdgeInsets.symmetric(vertical: 12),
                        hintText:
                            widget.enabled ? 'Message Talon…' : 'Connecting…',
                        hintStyle: TextStyle(color: TalonColors.textFaint),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                // Stop while a turn runs and there's nothing staged to send;
                // as soon as the user types, it flips back to send-to-queue.
                // The two buttons morph through a scale+fade so the swap reads
                // as one control changing mode, not a replacement.
                AnimatedSwitcher(
                  duration: TalonMotion.base,
                  switchInCurve: TalonMotion.emphasized,
                  switchOutCurve: Curves.easeIn,
                  transitionBuilder: (child, anim) => ScaleTransition(
                    scale: Tween(begin: 0.6, end: 1.0).animate(anim),
                    child: FadeTransition(opacity: anim, child: child),
                  ),
                  child: (widget.running &&
                          !canSend &&
                          !uploading &&
                          widget.onStop != null)
                      ? _StopButton(
                          key: const ValueKey('stop'), onTap: widget.onStop!)
                      : (!canSend &&
                              !uploading &&
                              widget.enabled &&
                              !widget.running &&
                              widget.onVoice != null)
                          // Empty input + voice available → the slot offers
                          // voice mode instead of a dead send button.
                          ? _VoiceButton(
                              key: const ValueKey('voice'),
                              onTap: widget.onVoice!,
                            )
                          : _SendButton(
                              key: const ValueKey('send'),
                              enabled: canSend,
                              busy: uploading,
                              onTap: _send,
                            ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// The staged files, above the input: image thumbnails and file chips, each
  /// removable, each showing its own progress bar while the send uploads it.
  Widget _stagingStrip() {
    final files = widget.attachments.files;
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 8, 6, 4),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final file in files)
              _StagedTile(
                file: file,
                // Removable even mid-upload: staging starts the upload
                // immediately, so "I dragged the wrong 200 MB file" has to
                // stay cancellable. The in-flight upload drops its result
                // when it finds the file gone from the list.
                onRemove: () {
                  widget.attachments.remove(file);
                  _recomputeCanSend();
                },
                onRetry: file.failed
                    ? () => widget.attachments.retry(file)
                    : null,
              ),
          ],
        ),
      ),
    );
  }
}

/// One staged file: a thumbnail for images, an icon chip for everything else,
/// with a remove affordance and an upload progress bar.
class _StagedTile extends StatelessWidget {
  final StagedFile file;
  final VoidCallback? onRemove;

  /// Retry this file's failed upload. Null unless it failed.
  final VoidCallback? onRetry;
  const _StagedTile({required this.file, this.onRemove, this.onRetry});

  @override
  Widget build(BuildContext context) {
    final progress = file.progress;
    return Semantics(
      label: file.failed
          ? 'Attached ${file.name}, ${file.sizeLabel}, upload failed — '
              'tap to retry'
          : 'Attached ${file.name}, ${file.sizeLabel}',
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: SizedBox(
              height: 72,
              child: Stack(
                fit: StackFit.passthrough,
                children: [
                  file.isImage ? _thumbnail(context) : _fileChip(),
                  // A file whose upload failed blocks the send, so it says so
                  // on the tile itself and retries on tap — otherwise the
                  // greyed button has no visible explanation.
                  if (file.failed)
                    Positioned.fill(
                      child: GestureDetector(
                        onTap: onRetry,
                        child: Container(
                          color: Colors.black.withValues(alpha: 0.55),
                          alignment: Alignment.center,
                          child: const Icon(Icons.refresh,
                              size: 22, color: Colors.white),
                        ),
                      ),
                    ),
                  if (progress != null)
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      child: LinearProgressIndicator(
                        value: progress,
                        minHeight: 3,
                        backgroundColor: TalonColors.surfaceHi,
                        valueColor:
                            AlwaysStoppedAnimation(TalonColors.accent),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (onRemove != null)
            Positioned(
              top: -6,
              right: -6,
              child: Semantics(
                button: true,
                label: 'Remove ${file.name}',
                child: GestureDetector(
                  onTap: onRemove,
                  child: Container(
                    decoration: BoxDecoration(
                      color: TalonColors.surfaceHi,
                      shape: BoxShape.circle,
                      border: Border.all(color: TalonColors.glassStroke),
                    ),
                    padding: const EdgeInsets.all(2),
                    child: const Icon(Icons.close, size: 15,
                        color: Colors.white),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _thumbnail(BuildContext context) {
    // Decode at the tile's physical size, not the photo's: a staged 12 MP
    // original is ~48 MB of RGBA for a 72 px chip.
    final px = (72 * MediaQuery.devicePixelRatioOf(context)).round();
    return Image.file(
      File(file.path),
      width: 72,
      height: 72,
      cacheWidth: px,
      cacheHeight: px,
      fit: BoxFit.cover,
      // The file can vanish between staging and render; show the same chip
      // the non-image case uses rather than a broken box.
      errorBuilder: (_, __, ___) => _fileChip(),
    );
  }

  Widget _fileChip() => Container(
        width: 168,
        height: 72,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        color: TalonColors.surfaceHi,
        child: Row(
          children: [
            Icon(iconForMime(file.mimeType),
                size: 22, color: TalonColors.textDim),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    file.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.2,
                      color: TalonColors.text,
                    ),
                  ),
                  if (file.sizeLabel.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        file.sizeLabel,
                        style: TextStyle(
                            fontSize: 11, color: TalonColors.textFaint),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      );
}

/// A recognisable icon per family of file, so a chip reads at a glance.
IconData iconForMime(String mimeType) {
  if (mimeType.startsWith('image/')) return Icons.image_outlined;
  if (mimeType.startsWith('video/')) return Icons.movie_outlined;
  if (mimeType.startsWith('audio/')) return Icons.audiotrack_outlined;
  if (mimeType == 'application/pdf') return Icons.picture_as_pdf_outlined;
  if (mimeType.contains('zip') ||
      mimeType.contains('tar') ||
      mimeType.contains('compressed') ||
      mimeType.contains('gzip') ||
      mimeType.contains('bzip') ||
      mimeType.contains('xz') ||
      mimeType.contains('zstd') ||
      mimeType.contains('vnd.rar')) {
    return Icons.folder_zip_outlined;
  }
  if (mimeType.contains('spreadsheet') || mimeType == 'text/csv') {
    return Icons.table_chart_outlined;
  }
  if (mimeType.contains('presentation')) return Icons.slideshow_outlined;
  if (mimeType.contains('word') || mimeType == 'application/rtf') {
    return Icons.description_outlined;
  }
  if (mimeType.startsWith('text/') ||
      mimeType.contains('json') ||
      mimeType.contains('xml') ||
      mimeType.contains('yaml') ||
      mimeType.contains('toml') ||
      mimeType.contains('sql')) {
    return Icons.code_outlined;
  }
  return Icons.insert_drive_file_outlined;
}

class _AttachButton extends StatelessWidget {
  final bool enabled;
  final VoidCallback onTap;
  const _AttachButton({required this.enabled, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: enabled ? onTap : null,
      icon: Icon(Icons.attach_file_rounded, size: TalonDensity.d(20, 23)),
      color: TalonColors.textDim,
      tooltip: 'Attach files',
    );
  }
}

/// Fills the send slot when there's nothing typed and voice is available:
/// a quiet mic that opens full-screen voice mode. Same footprint as the send
/// button so the AnimatedSwitcher morph between them reads as one control.
class _VoiceButton extends StatelessWidget {
  final VoidCallback onTap;
  const _VoiceButton({super.key, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Voice mode',
      child: Tooltip(
        message: 'Voice mode',
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: TalonDensity.d(40, 46),
            height: TalonDensity.d(40, 46),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [TalonColors.accent, TalonColors.accentDeep],
              ),
              borderRadius: BorderRadius.circular(TalonDensity.d(14, 16)),
              boxShadow: TalonShadows.glow,
            ),
            child: Icon(Icons.mic_rounded,
                color: Colors.white, size: TalonDensity.d(20, 22)),
          ),
        ),
      ),
    );
  }
}

/// Shown in the send slot while a turn is generating and the input is empty.
/// A calm square "stop" that pulses gently so it reads as live, and fires the
/// interrupt on tap.
class _StopButton extends StatelessWidget {
  final Future<void> Function() onTap;
  const _StopButton({super.key, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    final button = GestureDetector(
      onTap: () => onTap(),
      child: Container(
        width: TalonDensity.d(40, 46),
        height: TalonDensity.d(40, 46),
        decoration: BoxDecoration(
          color: TalonColors.surfaceHi,
          borderRadius: BorderRadius.circular(TalonDensity.d(13, 15)),
          border: Border.all(color: TalonColors.glassStroke),
        ),
        child: Icon(Icons.stop_rounded,
            color: TalonColors.text, size: TalonDensity.d(22, 24)),
      ),
    );
    return Semantics(
      button: true,
      label: 'Stop generating',
      child: Tooltip(
        message: 'Stop generating',
        child: reduceMotion
            ? button
            : button
                .animate(onPlay: (c) => c.repeat(reverse: true))
                .fadeIn(begin: 0.75, duration: 850.ms, curve: Curves.easeInOut)
                .wrapAmbient(),
      ),
    );
  }
}

class _SendButton extends StatefulWidget {
  final bool enabled;
  final bool busy;
  final VoidCallback onTap;
  const _SendButton({
    super.key,
    required this.enabled,
    required this.busy,
    required this.onTap,
  });

  @override
  State<_SendButton> createState() => _SendButtonState();
}

class _SendButtonState extends State<_SendButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final active = widget.enabled;
    final busy = widget.busy;
    // Coloured while there's something to send OR an upload is in flight.
    final colored = active || busy;
    // Springs up to full size + full colour when actionable, dips under the
    // finger, softens to a flat idle state when empty, and shows a spinner
    // while the attached image uploads.
    return Semantics(
      button: true,
      enabled: active,
      label: busy ? 'Sending, files uploading' : 'Send message',
      child: GestureDetector(
        onTapDown: active ? (_) => setState(() => _pressed = true) : null,
        onTapUp: active ? (_) => setState(() => _pressed = false) : null,
        onTapCancel: active ? () => setState(() => _pressed = false) : null,
        onTap: active ? widget.onTap : null,
        child: AnimatedScale(
          scale: _pressed
              ? 0.88
              : colored
                  ? 1.0
                  : 0.9,
          duration: TalonMotion.fast,
          curve: TalonMotion.emphasized,
          child: AnimatedContainer(
            duration: TalonMotion.base,
            curve: TalonMotion.standard,
            width: TalonDensity.d(40, 46),
            height: TalonDensity.d(40, 46),
            decoration: BoxDecoration(
              gradient: colored
                  ? LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [TalonColors.accent, TalonColors.accentDeep],
                    )
                  : null,
              color: colored ? null : TalonColors.surfaceHi,
              borderRadius: BorderRadius.circular(TalonDensity.d(14, 16)),
              boxShadow: colored ? TalonShadows.glow : null,
            ),
            child: busy
                ? const Padding(
                    padding: EdgeInsets.all(11),
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation(Colors.white),
                    ),
                  )
                : Icon(
                    Icons.arrow_upward_rounded,
                    color: colored ? Colors.white : TalonColors.textFaint,
                    size: TalonDensity.d(20, 22),
                  ),
          ),
        ),
      ),
    );
  }
}
