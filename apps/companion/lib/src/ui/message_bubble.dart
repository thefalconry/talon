import 'dart:io' show File;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart' show launchUrl, LaunchMode;

import '../models/bridge_models.dart';
import '../services/attachment_opener.dart';
import '../services/haptics.dart';
import '../theme.dart';
import 'assistant_surface.dart';
import 'composer.dart' show iconForMime;
import 'code_block.dart';
import 'image_bounds.dart';
import 'markdown.dart';
import 'motion.dart';
import 'tool_timeline.dart';

/// Compact clock stamp for message rows ("14:32").
String _clock(DateTime t) {
  final local = t.toLocal();
  String two(int n) => n < 10 ? '0$n' : '$n';
  return '${two(local.hour)}:${two(local.minute)}';
}

/// A single conversation row, ChatGPT-style:
///   - user: a compact rounded bubble aligned right
///   - assistant: a full-width row with the Talon avatar + markdown + actions
///   - system: a quiet centered note
class MessageBubble extends StatelessWidget {
  final ClientMessage message;
  final String botName;

  /// Play a one-shot entrance when the row first appears. Only set for freshly
  /// arrived messages — never history or rows recycled back into view on scroll
  /// — so the list stays calm and nothing re-animates while scrolling.
  final bool animateIn;

  /// Fully-resolved URL for the first attached image, or null. Kept separate
  /// from [files] because an image-only message lays its bubble out
  /// differently (no text padding around the picture).
  final String? imageUrl;

  /// The message's non-image attachments, already resolved to fetchable URLs.
  /// Rendered as a column of chips under the text.
  final List<BubbleFile> files;

  /// Headers every media fetch sends — the bridge's `Authorization`, which
  /// used to ride in the URL as `?token=`.
  final Map<String, String> mediaHeaders;

  /// The bridge base URL (e.g. `https://host:port`). A link in message text
  /// that points at this origin is a bridge attachment and is fetched in-app
  /// with [mediaHeaders]; every other link opens in the external browser.
  final String mediaBaseUrl;

  /// False when this row is grouped under a previous assistant row from the
  /// same run — the avatar + name header is skipped.
  final bool showHeader;

  /// False when a following user message in the same run carries the
  /// timestamp — this row's external clock is skipped.
  final bool showTime;

  const MessageBubble({
    super.key,
    required this.message,
    required this.botName,
    this.animateIn = false,
    this.imageUrl,
    this.files = const [],
    this.mediaHeaders = const {},
    this.mediaBaseUrl = '',
    this.showHeader = true,
    this.showTime = true,
  });

  @override
  Widget build(BuildContext context) {
    final Widget row;
    switch (message.role) {
      case Role.system:
        row = _system();
      case Role.user:
        row = _userRow();
      case Role.assistant:
        row = _assistantRow();
    }
    // A user message rises from its side; the assistant fades in place with a
    // whisper of upward drift so it settles rather than snaps. EntranceFx
    // latches the play decision at mount so the frequent streaming rebuilds
    // (which flip `animateIn` back to false) can't tear the entrance down
    // mid-flight. Reduce-motion is honoured inside EntranceFx via `enabled`.
    final fromRight = message.role == Role.user;
    return EntranceFx(
      enabled: animateIn && !reduceMotion(context),
      from: Offset(fromRight ? 0.04 : -0.01, 0.12),
      child: row,
    );
  }

  Widget _system() => Padding(
        padding: const EdgeInsets.symmetric(
            vertical: TalonSpace.sm, horizontal: TalonSpace.md),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(
                horizontal: TalonSpace.md, vertical: 6),
            decoration: BoxDecoration(
              color: TalonColors.glassFill,
              borderRadius: TalonRadius.rPill,
              border: Border.all(color: TalonColors.glassStroke),
            ),
            child: Text(
              message.text,
              textAlign: TextAlign.center,
              style: TalonType.caption,
            ),
          ),
        ),
      );

  Widget _userRow() => Padding(
        // Grouped bubbles (clock deferred to the run's last message) sit
        // closer together so the run reads as one thought.
        padding: EdgeInsets.only(top: 9, bottom: showTime ? 9 : 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Spacer(flex: 3),
            Flexible(
              flex: 10,
              // Align fills the flex slot and pins the (shrink-wrapped)
              // bubble column to its right edge — without it the column sits
              // at the start of the slot and user messages drift left.
              child: Align(
                alignment: Alignment.centerRight,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Tooltip(
                      message:
                          message.time.toLocal().toString().split('.').first,
                      waitDuration: const Duration(milliseconds: 600),
                      child: Builder(
                        builder: (context) => GestureDetector(
                          // Touch path to copy your own message: assistant rows
                          // have a Copy button, user bubbles previously had
                          // nothing reachable without a mouse (SelectableText
                          // still handles precise selection on the text itself).
                          onLongPress: message.text.isEmpty
                              ? null
                              : () async {
                                  Haptics.medium();
                                  final messenger =
                                      ScaffoldMessenger.maybeOf(context);
                                  await Clipboard.setData(
                                      ClipboardData(text: message.text));
                                  messenger?.hideCurrentSnackBar();
                                  messenger?.showSnackBar(const SnackBar(
                                      content: Text('Message copied')));
                                },
                          child: Container(
                            key: const Key('user-message-bubble'),
                            padding: EdgeInsets.symmetric(
                              horizontal:
                                  imageUrl != null && message.text.isEmpty
                                      ? TalonSpace.sm
                                      : TalonSpace.lg,
                              vertical: imageUrl != null && message.text.isEmpty
                                  ? TalonSpace.sm
                                  : 11,
                            ),
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.topLeft,
                                end: Alignment.bottomRight,
                                colors: [
                                  TalonColors.accent,
                                  TalonColors.accentDeep,
                                ],
                              ),
                              borderRadius: const BorderRadius.only(
                                topLeft: Radius.circular(20),
                                topRight: Radius.circular(20),
                                bottomLeft: Radius.circular(20),
                                bottomRight: Radius.circular(6),
                              ),
                              border: Border.all(
                                color: Colors.white.withValues(alpha: 0.13),
                              ),
                              boxShadow: [
                                BoxShadow(
                                  color: TalonColors.accentDeep
                                      .withValues(alpha: 0.22),
                                  blurRadius: 14,
                                  offset: const Offset(0, 5),
                                ),
                              ],
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (imageUrl != null)
                                  Padding(
                                    padding: EdgeInsets.only(
                                      bottom: message.text.isEmpty
                                          ? 0
                                          : TalonSpace.sm,
                                    ),
                                    child: _InlineImage(
                                        url: imageUrl!, headers: mediaHeaders),
                                  ),
                                if (message.text.isNotEmpty)
                                  // One SelectionArea, plain Text inside —
                                  // not a SelectableText, which drags in an
                                  // EditableText + focus node per row.
                                  SelectionArea(
                                    child: Text(
                                      message.text,
                                      style: TalonType.body.copyWith(
                                        color: Colors.white,
                                        fontWeight: FontWeight.w500,
                                      ),
                                    ),
                                  ),
                                if (files.isNotEmpty)
                                  _FileList(
                                      files: files,
                                      headers: mediaHeaders,
                                      onAccent: true),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    // Timestamp on the canvas under the bubble, not inside
                    // it — same anatomy as the assistant row's external
                    // metadata. Skipped mid-run: the last bubble of a
                    // consecutive group carries the clock for the whole run.
                    if (showTime)
                      Padding(
                        padding: const EdgeInsets.only(top: 4, right: 4),
                        child: Text(
                          _clock(message.time),
                          key: const Key('user-message-time'),
                          style: TalonType.caption.copyWith(
                            fontSize: 10.5,
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      );

  // Chat-app anatomy: only the reply itself lives in the bubble. The name +
  // time header, the tool trace, and the copy/token/duration footer all sit
  // outside on the canvas (see AssistantSurface).
  Widget _assistantRow() => AssistantSurface(
        botName: botName,
        surfaceKey: const Key('assistant-message-card'),
        showHeader: showHeader,
        trailing: Text(
          _clock(message.time),
          style: TalonType.caption.copyWith(
            fontSize: 10.5,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        aboveBubble:
            message.tools.isEmpty ? null : ToolTrace(tools: message.tools),
        bubble: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (imageUrl != null)
              Padding(
                padding: EdgeInsets.only(
                    bottom: message.text.isEmpty ? 0 : TalonSpace.sm),
                child: _InlineImage(url: imageUrl!, headers: mediaHeaders),
              ),
            // Suppress the "…" placeholder for an attachment-only message.
            // A single selection system per reply: one SelectionArea over a
            // non-selectable MarkdownBody (whose code panels carry no
            // SelectionArea of their own). `selectable: true` built a
            // SelectableText per paragraph and nested a SelectionArea per code
            // block — two systems, torn down mid-drag whenever the lazy list
            // disposed the row, a known desktop crash while scrolling (#1062).
            if (!((imageUrl != null || files.isNotEmpty) &&
                message.text.isEmpty))
              SelectionArea(
                child: Builder(
                  builder: (context) => MarkdownBody(
                    data: message.text.isEmpty ? '…' : message.text,
                    builders: {'code': CodeElementBuilder()},
                    onTapLink: (_, href, __) => _onTapLink(context, href),
                    styleSheet: talonMarkdownStyle(),
                  ),
                ),
              ),
            if (files.isNotEmpty)
              _FileList(files: files, headers: mediaHeaders, onAccent: false),
          ],
        ),
        belowBubble: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (message.buttons.isNotEmpty) _buttons(),
            if (message.reactions.isNotEmpty) _reactions(),
            _MessageActions(message: message),
          ],
        ),
      );

  /// A tapped link in message text. A bridge attachment link (`/media?id=…`)
  /// is fetched in-app through the authenticated media stack, so the bearer
  /// token never rides in a browser-visible URL and mTLS still applies, then
  /// opened locally. Everything else opens in the browser.
  void _onTapLink(BuildContext context, String? href) {
    if (href == null) return;
    final media = bridgeMediaUrl(href, mediaBaseUrl);
    if (media != null) {
      final messenger = ScaffoldMessenger.maybeOf(context);
      AttachmentOpener.instance
          .openLink(url: media, headers: mediaHeaders)
          .catchError((Object e) {
        messenger?.showSnackBar(
          SnackBar(content: Text("Couldn't open link: $e")),
        );
        return File('');
      });
      return;
    }
    launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication);
  }

  /// The URL to fetch in-app for a `/media?id=…` link, or null when [href]
  /// isn't one (or no bridge is connected).
  ///
  /// The daemon writes these links with whatever address *it* thinks it has
  /// (often a public hostname behind a reverse proxy), which needn't match
  /// the address this client connected with (a LAN or tailnet IP). A media id
  /// only means something to the bridge that minted it, so the link is always
  /// re-pointed at the connected bridge: [baseUrl] + `/media?id=<id>`. That
  /// keeps the auth header on our own origin (a look-alike host in message
  /// text never receives it) and drops anything else in the query, such as a
  /// legacy `token=`.
  @visibleForTesting
  static String? bridgeMediaUrl(String href, String baseUrl) {
    if (baseUrl.isEmpty) return null;
    final link = Uri.tryParse(href);
    if (link == null) return null;
    if (link.scheme != 'http' && link.scheme != 'https') return null;
    if (link.path != '/media') return null;
    final id = link.queryParameters['id'];
    if (id == null || id.isEmpty) return null;
    final base = baseUrl.endsWith('/')
        ? baseUrl.substring(0, baseUrl.length - 1)
        : baseUrl;
    return '$base/media?id=${Uri.encodeQueryComponent(id)}';
  }

  Widget _buttons() => Padding(
        padding: const EdgeInsets.only(top: TalonSpace.sm),
        child: Wrap(
          spacing: TalonSpace.sm,
          runSpacing: TalonSpace.sm,
          children: [
            for (final row in message.buttons)
              for (final b in row)
                OutlinedButton(
                  onPressed: b.url == null
                      ? null
                      : () => launchUrl(Uri.parse(b.url!),
                          mode: LaunchMode.externalApplication),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: TalonColors.accent,
                    side: BorderSide(
                        color: TalonColors.accent.withValues(alpha: 0.5)),
                    shape: const RoundedRectangleBorder(
                        borderRadius: TalonRadius.rSm),
                  ),
                  child: Text(b.text),
                ),
          ],
        ),
      );

  Widget _reactions() => Padding(
        padding: const EdgeInsets.only(top: TalonSpace.sm),
        child: Wrap(
          spacing: TalonSpace.xs,
          children: [
            for (final r in message.reactions)
              Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: TalonSpace.sm, vertical: 3),
                decoration: BoxDecoration(
                  color: TalonColors.glassFill,
                  borderRadius: TalonRadius.rPill,
                  border: Border.all(color: TalonColors.glassStroke),
                ),
                child: Text(r, style: const TextStyle(fontSize: 13)),
              ),
          ],
        ),
      );
}

/// An inline attached image: rounded, width-capped, tap to open full-screen,
/// with quiet loading and error states so a slow or broken fetch never breaks
/// the row layout.
class _InlineImage extends StatelessWidget {
  final String url;
  final Map<String, String> headers;
  const _InlineImage({required this.url, required this.headers});

  static const double _maxWidth = 340;
  static const double _maxHeight = 420;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Attached image. Open full screen',
      child: GestureDetector(
        onTap: () => _openFull(context),
        child: ClipRRect(
          borderRadius: TalonRadius.rMd,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
                maxWidth: _maxWidth, maxHeight: _maxHeight),
            child: Image(
              // Decoded at the box's physical size, not the photo's: a 12 MP
              // original is ~48 MB of RGBA for a 340 px thumbnail, and a tall
              // screenshot can exceed the GL texture limit outright (#1062).
              image: boundedNetworkImage(
                url,
                headers: headers,
                maxWidth: _maxWidth,
                maxHeight: _maxHeight,
                devicePixelRatio: MediaQuery.devicePixelRatioOf(context),
              ),
              // contain, not cover: cover cropped anything non-square into an
              // arbitrary window, which is what made history images look wrong.
              // contain keeps the full frame at its natural aspect ratio.
              fit: BoxFit.contain,
              loadingBuilder: (context, child, progress) {
                if (progress == null) return child;
                return Container(
                  width: 220,
                  height: 160,
                  alignment: Alignment.center,
                  color: TalonColors.surface,
                  child: const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                );
              },
              // Sized by constraint, not a fixed width: inside a narrow
              // bubble (a phone, a long file name beside it) a hard 200px
              // placeholder overflows its own row.
              errorBuilder: (context, _, __) => Container(
                constraints: const BoxConstraints(maxWidth: 200, minHeight: 110),
                padding: const EdgeInsets.symmetric(
                    horizontal: TalonSpace.sm, vertical: TalonSpace.sm),
                alignment: Alignment.center,
                color: TalonColors.surface,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.broken_image_outlined,
                        size: 18, color: TalonColors.textFaint),
                    const SizedBox(width: TalonSpace.sm),
                    Flexible(
                      child: Text('Image unavailable',
                          style: TextStyle(
                              color: TalonColors.textFaint, fontSize: 12.5)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _openFull(BuildContext context) {
    Navigator.of(context).push(
      PageRouteBuilder<void>(
        opaque: false,
        barrierColor: Colors.black.withValues(alpha: 0.9),
        pageBuilder: (_, __, ___) => GestureDetector(
          onTap: () => Navigator.of(context).pop(),
          child: Stack(
            children: [
              Center(
                child: InteractiveViewer(
                  maxScale: 5,
                  child: Image(
                    image: fullScreenNetworkImage(url, headers: headers),
                    fit: BoxFit.contain,
                  ),
                ),
              ),
              Positioned(
                top: 40,
                right: TalonSpace.lg,
                child: IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  tooltip: 'Close image',
                  icon: const Icon(Icons.close, color: Colors.white),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The assistant row's footer: a Copy button plus a quiet stats readout
/// (duration + token usage) once the turn has ended.
class _MessageActions extends StatefulWidget {
  final ClientMessage message;
  const _MessageActions({required this.message});

  @override
  State<_MessageActions> createState() => _MessageActionsState();
}

class _MessageActionsState extends State<_MessageActions> {
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.message.text));
    if (!mounted) return;
    setState(() => _copied = true);
    Future.delayed(const Duration(milliseconds: 1400), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.message;
    if (m.text.isEmpty && !m.hasStats) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          if (m.text.isNotEmpty)
            // Text child announces itself; this only adds the missing role.
            Semantics(
              button: true,
              child: InkWell(
                onTap: _copy,
                borderRadius: TalonRadius.rSm,
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(_copied ? Icons.check : Icons.copy_rounded,
                          size: 14, color: TalonColors.textFaint),
                      const SizedBox(width: 5),
                      Text(
                        _copied ? 'Copied' : 'Copy',
                        style: TextStyle(
                            fontSize: 11.5, color: TalonColors.textFaint),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          if (m.hasStats) ...[
            const SizedBox(width: TalonSpace.sm),
            // Flexible + ellipsis: on a narrow phone column the full
            // "2.1k in · 460 out · 9.4s" readout can outgrow the row.
            Flexible(
              child: Text(
                _stats(m),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TalonType.caption.copyWith(fontSize: 11),
              ),
            ),
          ],
        ],
      ),
    );
  }

  String _stats(ClientMessage m) {
    final parts = <String>[];
    if (m.tokensIn != null && m.tokensIn! > 0) {
      parts.add('${_compact(m.tokensIn!)} in');
    }
    if (m.tokensOut != null && m.tokensOut! > 0) {
      parts.add('${_compact(m.tokensOut!)} out');
    }
    if (m.durationMs != null && m.durationMs! > 0) {
      // Reuse the same formatter the tool trace uses, so the duration here and
      // in the ToolTrace summary on the same row read identically.
      parts.add(fmtToolDuration(Duration(milliseconds: m.durationMs!)));
    }
    return parts.join(' · ');
  }

  static String _compact(int n) {
    if (n < 1000) return '$n';
    final k = n / 1000;
    // Round first so 9950 → "10k", not "10.0k".
    return k < 9.95 ? '${k.toStringAsFixed(1)}k' : '${k.round()}k';
  }
}

/// One non-image attachment as the bubble renders it: what to show, and where
/// to fetch it from when the reader taps it.
class BubbleFile {
  final String name;
  final String sizeLabel;
  final String mimeType;

  /// Fully-resolved URL the bytes are served from. Carries no token: the
  /// chip fetches it with the bubble's [MessageBubble.mediaHeaders].
  final String url;

  const BubbleFile({
    required this.name,
    required this.sizeLabel,
    required this.mimeType,
    required this.url,
  });
}

/// The attached files under a message: one tappable chip each, opening the
/// file with the OS handler. [onAccent] tints them for the accent-filled user
/// bubble rather than the neutral assistant one.
class _FileList extends StatelessWidget {
  final List<BubbleFile> files;
  final Map<String, String> headers;
  final bool onAccent;
  const _FileList({
    required this.files,
    required this.headers,
    required this.onAccent,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: TalonSpace.sm),
      child: Column(
        crossAxisAlignment:
            onAccent ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final file in files)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child:
                  _FileChip(file: file, headers: headers, onAccent: onAccent),
            ),
        ],
      ),
    );
  }
}

class _FileChip extends StatefulWidget {
  final BubbleFile file;
  final Map<String, String> headers;
  final bool onAccent;
  const _FileChip({
    required this.file,
    required this.headers,
    required this.onAccent,
  });

  @override
  State<_FileChip> createState() => _FileChipState();
}

/// Tapping downloads the file with the auth header and opens the local copy
/// (see [AttachmentOpener]); the trailing icon turns into a spinner while
/// the download runs, and a failure says so in a snackbar.
class _FileChipState extends State<_FileChip> {
  bool _busy = false;

  Future<void> _open() async {
    if (_busy) return;
    final file = widget.file;
    final messenger = ScaffoldMessenger.maybeOf(context);
    setState(() => _busy = true);
    try {
      await AttachmentOpener.instance.open(
        url: file.url,
        name: file.name,
        mimeType: file.mimeType,
        headers: widget.headers,
      );
    } catch (e) {
      messenger?.showSnackBar(
        SnackBar(content: Text("Couldn't open ${file.name}: $e")),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final file = widget.file;
    final onAccent = widget.onAccent;
    final foreground = onAccent ? Colors.white : TalonColors.text;
    final faint =
        onAccent ? Colors.white.withValues(alpha: 0.75) : TalonColors.textFaint;
    return Semantics(
      button: true,
      label: 'Attached file ${file.name}, ${file.sizeLabel}. Open',
      child: Tooltip(
        message: 'Open ${file.name}',
        child: GestureDetector(
          onTap: _open,
          child: Container(
            constraints: const BoxConstraints(maxWidth: 280),
            padding: const EdgeInsets.symmetric(
                horizontal: TalonSpace.sm, vertical: 7),
            decoration: BoxDecoration(
              color: onAccent
                  ? Colors.white.withValues(alpha: 0.16)
                  : TalonColors.glassFill,
              borderRadius: TalonRadius.rSm,
              border: Border.all(
                color: onAccent
                    ? Colors.white.withValues(alpha: 0.24)
                    : TalonColors.glassStroke,
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(iconForMime(file.mimeType), size: 18, color: foreground),
                const SizedBox(width: TalonSpace.sm),
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        file.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          color: foreground,
                        ),
                      ),
                      if (file.sizeLabel.isNotEmpty)
                        Text(
                          file.sizeLabel,
                          style: TextStyle(fontSize: 11, color: faint),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 4),
                if (_busy)
                  SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(
                        strokeWidth: 1.6, color: faint),
                  )
                else
                  Icon(Icons.open_in_new_rounded, size: 14, color: faint),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
