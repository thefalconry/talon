import 'dart:io' show Platform;

import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../models/bridge_models.dart';
import '../services/haptics.dart';
import '../services/voice.dart';
import '../state/app_state.dart';
import '../state/composer_attachments.dart';
import '../theme.dart';
import 'activity_card.dart';
import 'brand.dart';
import 'chat_actions.dart';
import 'composer.dart';
import 'context_sheet.dart';
import 'message_bubble.dart';
import 'model_sheet.dart';
import 'voice_mode_screen.dart';
import 'effects.dart';

const double _columnMax = 768;

class ChatView extends StatefulWidget {
  final AppState state;
  final bool showBack;
  final VoidCallback? onBack;

  /// Phone presentation: no rounded card or canvas tint — the conversation
  /// sits directly on the app backdrop edge to edge (like Settings), the
  /// header pads itself under the status bar, and the composer respects the
  /// bottom system inset.
  final bool fullBleed;

  const ChatView({
    super.key,
    required this.state,
    required this.showBack,
    this.onBack,
    this.fullBleed = false,
  });

  @override
  State<ChatView> createState() => _ChatViewState();
}

/// Native file drop is a desktop affordance — there is no OS drag source on
/// Android, and desktop_drop ships no implementation there.
bool get _dropSupported =>
    Platform.isLinux || Platform.isMacOS || Platform.isWindows;

class _ChatViewState extends State<ChatView> {
  final _scroll = ScrollController();

  /// Files staged for the next send. Owned here (not by the composer) so the
  /// drop target wrapping the whole pane can stage into the same list.
  final _attachments = ComposerAttachments();

  /// The composer's field, owned here so Reply can quote a message into it.
  final _composerText = TextEditingController();
  final _composerFocus = FocusNode();

  /// True while a drag is hovering the chat, for the drop overlay.
  bool _dragging = false;

  /// Ids we've already shown, so the entrance animation plays once per message
  /// and never re-fires when a row is recycled back into view on scroll.
  final Set<String> _seen = <String>{};

  /// Memoised message rows (messages interleaved with day markers). Rebuilt
  /// only when the chat's message list actually changes, not on every
  /// AppState notification — during a streamed reply that is every token.
  List<Object> _rows = const [];
  Object? _rowsKey;

  /// Which chat the list is currently anchored to, and whether we still owe it
  /// a jump-to-newest. When you open a chat it should land on the most recent
  /// message (like any chat app), not the top of the scrollback.
  String? _anchoredChatId;
  bool _pendingJumpToBottom = false;
  int _settleToken = 0;

  /// Whether the user has scrolled up into history far enough that a
  /// jump-to-latest affordance is useful.
  bool _awayFromBottom = false;

  /// The on-screen chat's live turn. Streamed tokens notify it (not
  /// AppState), so following the growing reply to the bottom hangs off it.
  TurnState? _followedTurn;
  bool _followQueued = false;

  /// Voice mode is offered only where a speech recognizer actually exists
  /// (Android with a recognition service). Probed once at mount.
  bool _voiceAvailable = false;

  @override
  void initState() {
    super.initState();
    // Staged files upload immediately, so the list needs the uploader before
    // anything can be dropped or picked into it.
    _attachments.uploader = widget.state.uploadAttachment;
    _scroll.addListener(_onScrolled);
    if (VoiceService.supported) {
      VoiceService.instance.isSttAvailable().then((ok) {
        if (mounted && ok) setState(() => _voiceAvailable = true);
      });
    }
  }

  @override
  void dispose() {
    _followedTurn?.removeListener(_onTurnTick);
    _attachments.dispose();
    _composerText.dispose();
    _composerFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _followTurn(TurnState turn) {
    if (identical(turn, _followedTurn)) return;
    _followedTurn?.removeListener(_onTurnTick);
    _followedTurn = turn..addListener(_onTurnTick);
  }

  /// A token landed (already coalesced to one per frame): once the live row
  /// has laid out, keep the view pinned to the bottom if it already was.
  /// jumpTo, not animateTo — restarting a 160 ms scroll animation on every
  /// frame of a stream is exactly the churn this path exists to avoid.
  void _onTurnTick() {
    if (_followQueued) return;
    _followQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _followQueued = false;
      if (!mounted || !_scroll.hasClients) return;
      final pos = _scroll.position;
      if (pos.maxScrollExtent - pos.pixels < 260) {
        _scroll.jumpTo(pos.maxScrollExtent);
      }
    });
  }

  /// Stage everything dropped on the chat. Directories and empty files are
  /// skipped (a folder has no single set of bytes to upload); if that leaves
  /// nothing, say so rather than silently doing nothing.
  Future<void> _onDrop(DropDoneDetails detail) async {
    setState(() => _dragging = false);
    if (widget.state.conn != ConnState.connected) return;
    final added = _attachments.addPaths(
      detail.files.map((f) => f.path).where((p) => p.isNotEmpty),
    );
    if (added > 0) {
      Haptics.selection();
    } else if (detail.files.isNotEmpty && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Nothing to attach — folders and empty files are '
              'skipped.'),
        ),
      );
    }
  }

  void _onScrolled() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    final away = pos.maxScrollExtent - pos.pixels > 420;
    if (away != _awayFromBottom) setState(() => _awayFromBottom = away);
    // Nearing the top of loaded scrollback → pull the previous page in.
    if (pos.pixels < 240 && !_pendingJumpToBottom) _maybeLoadOlder();
  }

  /// Fetch the page above the current scrollback and keep the viewport
  /// anchored on the row the user was looking at (prepending grows
  /// maxScrollExtent; jump by the delta so nothing visibly shifts).
  Future<void> _maybeLoadOlder() async {
    final chatId = _anchoredChatId;
    if (chatId == null) return;
    final state = widget.state;
    if (state.isLoadingOlder(chatId) || !state.hasMoreHistory(chatId)) return;
    final extentBefore =
        _scroll.hasClients ? _scroll.position.maxScrollExtent : 0.0;
    final pixelsBefore = _scroll.hasClients ? _scroll.position.pixels : 0.0;
    final added = await state.loadOlderMessages(chatId);
    if (added > 0 && mounted) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_scroll.hasClients) return;
        final delta = _scroll.position.maxScrollExtent - extentBefore;
        if (delta > 0) _scroll.jumpTo(pixelsBefore + delta);
      });
    }
  }

  void _jumpToLatest() {
    if (!_scroll.hasClients) return;
    _scroll.animateTo(
      _scroll.position.maxScrollExtent,
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
  }

  /// The message's non-image attachments, resolved to fetchable URLs. The
  /// first image is already rendered inline from `imagePath`, so it is left
  /// out here; any further image still gets a chip rather than vanishing.
  List<BubbleFile> _bubbleFiles(ClientMessage m) {
    if (m.attachments.isEmpty) return const [];
    final inline = m.imagePath;
    return [
      for (final a in m.attachments)
        if (a.url != inline)
          BubbleFile(
            name: a.name,
            sizeLabel: a.sizeLabel,
            mimeType: a.mimeType,
            url: widget.state.activeConfig.mediaUrl(a.url),
          ),
    ];
  }

  /// Whether [a] (earlier) and [b] (later) belong to the same visual run:
  /// same author, close together in time.
  ///
  /// Assistant runs get a wider window than user ones: a model delivering
  /// progress messages mid-turn (send_message) can spend minutes in tools
  /// between them, and those messages are still one reply to the reader.
  static bool _grouped(ClientMessage? a, ClientMessage? b) {
    if (a == null || b == null) return false;
    if (a.role != b.role || a.role == Role.system) return false;
    final window = a.role == Role.assistant
        ? const Duration(minutes: 10)
        : const Duration(minutes: 3);
    return b.time.difference(a.time).abs() < window;
  }

  /// The text of the assistant run ending at row [end], oldest first — what
  /// the run's single Copy button puts on the clipboard.
  String _runText(List<Object> rows, int end) {
    final parts = <String>[];
    var i = end;
    while (i >= 0 && rows[i] is ClientMessage) {
      final m = rows[i] as ClientMessage;
      if (m.text.isNotEmpty) parts.add(m.text);
      final prev = i > 0 && rows[i - 1] is ClientMessage
          ? rows[i - 1] as ClientMessage
          : null;
      if (!_grouped(prev, m)) break;
      i--;
    }
    return parts.reversed.join('\n\n');
  }

  /// Reply: quote [m] at the top of the composer (keeping anything already
  /// typed below it) and put the cursor at the end.
  void _reply(ClientMessage m) {
    var text = m.text.trim();
    if (text.length > 280) text = '${text.substring(0, 280).trimRight()}…';
    final quote = text.split('\n').map((l) => '> $l').join('\n');
    final existing = _composerText.text.trim();
    final next = existing.isEmpty ? '$quote\n\n' : '$quote\n\n$existing';
    _composerText.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: next.length),
    );
    _composerFocus.requestFocus();
  }

  /// A row animates in only the first time we see it AND when it's genuinely
  /// fresh (sent/received seconds ago) — so opening a chat's history doesn't
  /// trigger a cascade of animations.
  bool _shouldAnimate(ClientMessage m) {
    final firstSight = _seen.add(m.id);
    if (!firstSight) return false;
    return DateTime.now().difference(m.time).inMilliseconds < 4000;
  }

  void _autoScroll(String chatId, int messageCount) {
    // Opening (or switching to) a chat should land on the newest message. The
    // history often loads a frame or two after the switch, so keep owing the
    // jump until the chat actually has content, then snap to the bottom.
    if (chatId != _anchoredChatId) {
      _anchoredChatId = chatId;
      _pendingJumpToBottom = true;
      _settleToken++;
    }
    final token = _settleToken;
    final historyLoading = widget.state.isHistoryLoading(chatId);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      if (_pendingJumpToBottom) {
        void settle(int retry, double lastExtent, int stableFrames) {
          if (!mounted || !_scroll.hasClients || _settleToken != token) return;
          final pos = _scroll.position;
          // If the user actively touches or scrolls during settle, yield to the gesture.
          if (pos.userScrollDirection != ScrollDirection.idle) {
            _pendingJumpToBottom = false;
            return;
          }
          // Hard cap: content that keeps growing (a streaming reply) must not
          // keep this loop alive frame after frame. Live growth is followed
          // by the near-bottom rule below once settling gives up.
          if (retry >= 60) {
            if (messageCount > 0 && !historyLoading) {
              _pendingJumpToBottom = false;
            }
            return;
          }
          if (!pos.hasContentDimensions) {
            WidgetsBinding.instance.addPostFrameCallback(
              (_) => settle(retry + 1, lastExtent, stableFrames),
            );
            return;
          }
          final currentExtent = pos.maxScrollExtent;
          if (pos.pixels < currentExtent) {
            _scroll.jumpTo(currentExtent);
            WidgetsBinding.instance.addPostFrameCallback(
              (_) => settle(retry + 1, currentExtent, 0),
            );
          } else if ((currentExtent - lastExtent).abs() > 0.5) {
            // Extent changed or just jumped; wait for next frame to check stability.
            WidgetsBinding.instance.addPostFrameCallback(
              (_) => settle(retry + 1, currentExtent, 0),
            );
          } else if (stableFrames < 2 && retry < 40) {
            // Extent unchanged across 1 frame; confirm stability on a 2nd consecutive frame
            // so multi-pass layouts (tall markdown bubbles, code highlighters) finish.
            WidgetsBinding.instance.addPostFrameCallback(
              (_) => settle(retry + 1, currentExtent, stableFrames + 1),
            );
          } else {
            // Settled: position is at maximum extent and extent has stabilized.
            if (messageCount > 0 && !historyLoading) {
              _pendingJumpToBottom = false;
            }
          }
        }

        settle(0, -1.0, 0);
        return;
      }
      final pos = _scroll.position;
      // Otherwise follow live growth only when the user is already near the
      // bottom, so we never yank them up while they're reading scrollback.
      if (pos.hasContentDimensions && pos.maxScrollExtent - pos.pixels < 260) {
        _scroll.animateTo(
          pos.maxScrollExtent,
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final body = ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final chat = widget.state.selectedChat;
        if (chat == null) return const _EmptyState();
        _followTurn(widget.state.turnFor(chat.id));
        _autoScroll(chat.id, widget.state.messagesFor(chat.id).length);
        return Column(
          children: [
            _Header(
              state: widget.state,
              chat: chat,
              showBack: widget.showBack,
              onBack: widget.onBack,
              extendIntoStatusBar: widget.fullBleed,
            ),
            if (widget.state.conn != ConnState.connected)
              _ConnBanner(state: widget.state),
            Expanded(child: _messages(chat.id)),
            // top:false — only the bottom (and side) system insets matter
            // here; in the card presentation the outer SafeArea has already
            // consumed them and this collapses to a no-op.
            SafeArea(
              top: false,
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: _columnMax),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _QueuedBar(state: widget.state, chatId: chat.id),
                      Composer(
                        onSend: (text, {attachments = const []}) {
                          _pendingJumpToBottom = true;
                          _settleToken++;
                          return widget.state
                              .sendMessage(text, attachments: attachments);
                        },
                        attachments: _attachments,
                        controller: _composerText,
                        focusNode: _composerFocus,
                        enabled: widget.state.conn == ConnState.connected,
                        running: widget.state.isTurnRunning(chat.id),
                        onStop: () => widget.state.interruptTurn(chat.id),
                        onVoice: _voiceAvailable
                            ? () => Navigator.of(context)
                                .push(VoiceModeScreen.route(widget.state))
                            : null,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
    // Full-bleed (phone): straight onto the app backdrop, like Settings.
    final framed = widget.fullBleed
        ? body
        // Card (desktop/tablet pane): rounded clip over a quiet canvas tint.
        : ClipRRect(
            borderRadius: BorderRadius.circular(22),
            child: Container(
              color: TalonColors.void1.withValues(alpha: 0.55),
              child: body,
            ),
          );
    if (!_dropSupported) return framed;
    // Desktop: the whole conversation pane is a drop zone — files land in the
    // composer's staging strip exactly as if they'd been picked.
    return DropTarget(
      onDragEntered: (_) => setState(() => _dragging = true),
      onDragExited: (_) => setState(() => _dragging = false),
      onDragDone: _onDrop,
      child: Stack(
        children: [
          framed,
          if (_dragging) const Positioned.fill(child: _DropOverlay()),
        ],
      ),
    );
  }

  /// Interleave day markers: a quiet centered "Today / Yesterday / 4 July"
  /// pill wherever the calendar day changes, so scrollback has temporal
  /// landmarks instead of one undifferentiated stream. Memoised on the
  /// list's identity, length and ends.
  List<Object> _rowsFor(String chatId, List<ClientMessage> msgs) {
    final key = (
      chatId,
      identityHashCode(msgs),
      msgs.length,
      msgs.isEmpty ? null : msgs.first.id,
      msgs.isEmpty ? null : msgs.last.id,
    );
    if (key == _rowsKey) return _rows;
    final rows = <Object>[];
    DateTime? day;
    for (final m in msgs) {
      final t = m.time.toLocal();
      final d = DateTime(t.year, t.month, t.day);
      if (day == null || d != day) {
        rows.add(d);
        day = d;
      }
      rows.add(m);
    }
    _rowsKey = key;
    _rowIndexCache = null;
    return _rows = rows;
  }

  Map<Object, int>? _rowIndexCache;

  /// Row index for a list key (see findChildIndexCallback), built lazily.
  int? _rowIndex(Object key) {
    final index = _rowIndexCache ??= {
      for (var i = 0; i < _rows.length; i++) _rowKey(_rows[i]): i,
    };
    return index[key];
  }

  /// The list key's value for a row: `m:<id>` for a message, the day itself
  /// for a divider.
  static Object _rowKey(Object row) =>
      row is ClientMessage ? 'm:${row.id}' : row;

  Widget _messages(String chatId) {
    final msgs = widget.state.messagesFor(chatId);
    final turn = widget.state.turnFor(chatId);
    final showActivity = turn.active &&
        (turn.hasDraft ||
            turn.reasoning.isNotEmpty ||
            turn.tools.isNotEmpty ||
            turn.typing ||
            turn.continuing);

    if (msgs.isEmpty && widget.state.isHistoryLoading(chatId)) {
      return const _HistorySkeleton();
    }

    if (msgs.isEmpty && !showActivity) {
      return _ConversationEmpty(
        onPrompt: widget.state.conn == ConnState.connected
            ? (p) {
                _pendingJumpToBottom = true;
                _settleToken++;
                widget.state.sendMessage(p);
              }
            : null,
      );
    }

    final rows = _rowsFor(chatId, msgs);
    // A live turn that follows the model's own mid-turn messages is the same
    // reply still being written: it joins their run (no second avatar/name,
    // no "Talon · Working" card) instead of starting a new one.
    final lastRow = rows.isEmpty ? null : rows.last;
    final liveJoinsRun = showActivity &&
        lastRow is ClientMessage &&
        lastRow.role == Role.assistant;

    final topLoader = widget.state.isLoadingOlder(chatId);
    final itemCount =
        (topLoader ? 1 : 0) + rows.length + (showActivity ? 1 : 0);
    return Stack(
      children: [
        Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _columnMax),
            child: ListView.builder(
              controller: _scroll,
              // Stable keys + this lookup let an older page prepended at the
              // top (or a row inserted mid-list) keep every existing row's
              // element and state instead of rebuilding by shifted index.
              findChildIndexCallback: (key) {
                if (key is! ValueKey<Object>) return null;
                final i = _rowIndex(key.value);
                return i == null ? null : i + (topLoader ? 1 : 0);
              },
              padding: EdgeInsets.fromLTRB(
                  TalonDensity.d(20, 18), 18, TalonDensity.d(20, 18), 10),
              itemCount: itemCount,
              itemBuilder: (context, i) {
                if (topLoader && i == 0) {
                  return const Padding(
                    padding: EdgeInsets.symmetric(vertical: 10),
                    child: Center(
                      child: SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  );
                }
                final mi = i - (topLoader ? 1 : 0);
                if (mi < rows.length) {
                  final row = rows[mi];
                  if (row is DateTime) {
                    return _DayDivider(
                        key: ValueKey<Object>(_rowKey(row)), day: row);
                  }
                  final m = row as ClientMessage;
                  // Group consecutive same-role messages (day dividers break
                  // runs naturally — the neighbor is a DateTime, not a
                  // message): grouped assistant rows drop the repeated
                  // avatar/name header, grouped user rows defer the clock to
                  // the run's last bubble.
                  final prev = mi > 0 && rows[mi - 1] is ClientMessage
                      ? rows[mi - 1] as ClientMessage
                      : null;
                  final next =
                      mi + 1 < rows.length && rows[mi + 1] is ClientMessage
                          ? rows[mi + 1] as ClientMessage
                          : null;
                  final assistant = m.role == Role.assistant;
                  // Another row of this assistant run follows: a later
                  // message, or (for the newest row) the live turn.
                  final continues = assistant &&
                      (next != null
                          ? _grouped(m, next)
                          : mi == rows.length - 1 && liveJoinsRun);
                  final runStart = assistant && !_grouped(prev, m);
                  return MessageBubble(
                    key: ValueKey<Object>(_rowKey(m)),
                    message: m,
                    botName: widget.state.status.botName,
                    animateIn: _shouldAnimate(m),
                    showHeader: !(assistant && _grouped(prev, m)),
                    showTime: !(m.role == Role.user && _grouped(m, next)),
                    showFooter: !continues,
                    continues: continues,
                    copyText: assistant && !continues && !runStart
                        ? _runText(rows, mi)
                        : null,
                    onReply: _reply,
                    // activeConfig, not config: in local auto-discover mode the
                    // saved config lacks the bridge's real port/token, and media
                    // fetched through it 404s or gets rejected.
                    imageUrl: m.imagePath == null
                        ? null
                        : widget.state.activeConfig.mediaUrl(m.imagePath!),
                    files: _bubbleFiles(m),
                    mediaHeaders: widget.state.activeConfig.authHeaders(),
                    mediaBaseUrl: widget.state.activeConfig.baseUrl,
                  );
                }
                return LiveTurn(
                  turn: turn,
                  botName: widget.state.status.botName,
                  showHeader: !liveJoinsRun,
                );
              },
            ),
          ),
        ),
        Positioned(
          right: 18,
          bottom: 12,
          child: AnimatedSlide(
            duration: TalonMotion.base,
            curve: TalonMotion.emphasized,
            offset: _awayFromBottom ? Offset.zero : const Offset(0, 0.4),
            child: AnimatedOpacity(
              duration: TalonMotion.fast,
              opacity: _awayFromBottom ? 1 : 0,
              child: IgnorePointer(
                ignoring: !_awayFromBottom,
                child: _JumpToLatest(onTap: _jumpToLatest),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Round "back to the newest message" button shown once the user scrolls up
/// into history.
/// Centered day marker between messages from different calendar days.
class _DayDivider extends StatelessWidget {
  final DateTime day;
  const _DayDivider({super.key, required this.day});

  static const _months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  String get _label {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final days = today.difference(day).inDays;
    if (days <= 0) return 'Today';
    if (days == 1) return 'Yesterday';
    final base = '${day.day} ${_months[day.month - 1]}';
    return day.year == now.year ? base : '$base ${day.year}';
  }

  @override
  Widget build(BuildContext context) {
    // A single quiet centered pill — no rule lines flanking it. The hairline
    // dashes read as clutter against the open canvas (and doubly so now the
    // conversation is full-bleed).
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: TalonSpace.md),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(
            horizontal: TalonSpace.md,
            vertical: TalonSpace.xs,
          ),
          decoration: BoxDecoration(
            color: TalonColors.glassFill,
            borderRadius: TalonRadius.rPill,
          ),
          child: Text(
            _label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.3,
              color: TalonColors.textDim,
            ),
          ),
        ),
      ),
    );
  }
}

class _JumpToLatest extends StatelessWidget {
  final VoidCallback onTap;
  const _JumpToLatest({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [TalonColors.accent, TalonColors.accentDeep],
        ),
        boxShadow: TalonShadows.glow,
      ),
      child: Material(
        color: Colors.transparent,
        // Icon-only: without an explicit label a screen reader announces
        // nothing at all here.
        child: Semantics(
          button: true,
          label: 'Scroll to latest message',
          child: InkWell(
            onTap: onTap,
            customBorder: const CircleBorder(),
            child: const Padding(
              padding: EdgeInsets.all(10),
              child: Icon(Icons.arrow_downward_rounded,
                  size: 18, color: Colors.white),
            ),
          ),
        ),
      ),
    );
  }
}

/// Slim status strip under the header while the app is reconnecting or the
/// bridge is unreachable, so a dead connection is visible from the chat
/// itself (not just the sidebar pill) and recoverable in place.
class _ConnBanner extends StatelessWidget {
  final AppState state;
  const _ConnBanner({required this.state});

  @override
  Widget build(BuildContext context) {
    final error = state.conn == ConnState.error;
    final color = error ? TalonColors.bad : TalonColors.warn;
    final text =
        error ? (state.connError ?? 'Connection lost') : 'Connecting to Talon…';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
      color: color.withValues(alpha: 0.10),
      child: Row(
        children: [
          if (error)
            Icon(Icons.cloud_off_rounded, size: 15, color: color)
          else
            SizedBox(
              width: 13,
              height: 13,
              child: CircularProgressIndicator(
                strokeWidth: 1.8,
                valueColor: AlwaysStoppedAnimation(color),
              ),
            ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12.5, color: color),
            ),
          ),
          if (error)
            TextButton(
              onPressed: state.start,
              style: TextButton.styleFrom(
                foregroundColor: color,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                minimumSize: const Size(0, 30),
                textStyle: const TextStyle(
                    fontSize: 12.5, fontWeight: FontWeight.w700),
              ),
              child: const Text('Retry'),
            ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final AppState state;
  final ClientChat chat;
  final bool showBack;
  final VoidCallback? onBack;

  /// Pad the bar by the top system inset so its surface runs up under the
  /// status bar (full-bleed phone presentation, same as Settings' AppBar).
  final bool extendIntoStatusBar;

  const _Header({
    required this.state,
    required this.chat,
    required this.showBack,
    this.onBack,
    this.extendIntoStatusBar = false,
  });

  @override
  Widget build(BuildContext context) {
    final model = chat.model ?? state.status.model;
    final effort = chat.effort ?? 'adaptive';
    final topInset =
        extendIntoStatusBar ? MediaQuery.of(context).padding.top : 0.0;
    return Container(
      padding: EdgeInsets.fromLTRB(12, 10 + topInset, 8, 10),
      decoration: BoxDecoration(
        color: TalonColors.surface.withValues(
          alpha: TalonTheme.isDark ? 0.68 : 0.92,
        ),
        border: Border(bottom: BorderSide(color: TalonColors.glassStroke)),
        boxShadow: TalonTheme.isDark
            ? null
            : [
                BoxShadow(
                  color: const Color(0xFF171A3D).withValues(alpha: 0.045),
                  blurRadius: 12,
                  offset: const Offset(0, 3),
                ),
              ],
      ),
      // One structure at every width now, instead of two layouts that agreed
      // on almost nothing. The wide bar used to carry a plain title plus a
      // context pill, a model pill and an effort pill — four bordered things
      // fighting the title — while the narrow bar folded model + effort into
      // the title's subtitle. Folding won, so it applies everywhere: the title
      // stays the loudest element, the right edge holds exactly two controls
      // (context, overflow), and the model/effort sheet is one tap on the
      // identity block. LayoutBuilder still measures the pane (a desktop window
      // with the sidebar open gives the chat less room than the same window
      // fullscreen), but now only to shrink the context pill on a narrow bar —
      // it no longer swaps one layout for another.
      child: LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxWidth < 560;
          final info = chat.context;
          return Row(
            children: [
              if (showBack)
                IconButton(
                  onPressed: onBack,
                  tooltip: 'Back to chats',
                  // Compact density with a pointer: the identity block sets
                  // the bar's height there, and a standard-density button
                  // would be taller than it and push the whole header out for
                  // nothing. On touch it goes back to a full 48dp target —
                  // back is the most-pressed control on the screen.
                  visualDensity:
                      TalonDensity.touch ? null : VisualDensity.compact,
                  constraints: TalonDensity.touch
                      ? BoxConstraints(
                          minWidth: TalonDensity.tap,
                          minHeight: TalonDensity.tap)
                      : null,
                  // Platform-adaptive: Material arrow on Android, iOS chevron
                  // on Apple platforms.
                  icon: Icon(Icons.adaptive.arrow_back,
                      size: TalonDensity.d(21, 24)),
                ),
              Expanded(
                child: _Identity(
                  title: chat.title,
                  model: model.isEmpty ? 'model' : model,
                  effort: effort,
                  connected: state.conn == ConnState.connected,
                  onTap: () => openModelSheet(context, state, chat),
                ),
              ),
              // Absent whenever the daemon reports no figure (older bridges,
              // and every chat between a reset and its first turn).
              if (info != null && info.known) ...[
                const SizedBox(width: TalonSpace.sm),
                _ContextChip(
                  info: info,
                  dense: compact,
                  onTap: () => openContextSheet(context, state, chat),
                ),
              ],
              _ChatMenu(state: state, chat: chat),
            ],
          );
        },
      ),
    );
  }
}

/// The header's identity block: the conversation title over a hairline
/// subtitle carrying the connection dot, the model and the reasoning effort.
/// The whole block is one target that opens the model/effort sheet.
///
/// It keeps `Key('conversation-identity')` on the [InkWell] rather than on the
/// widget itself so a test that taps the key lands on the actual gesture
/// target, not on a wrapper whose centre could drift as the block's layout
/// changes.
class _Identity extends StatelessWidget {
  final String title;
  final String model;
  final String effort;
  final bool connected;
  final VoidCallback onTap;

  const _Identity({
    required this.title,
    required this.model,
    required this.effort,
    required this.connected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      // The header paints its own opaque surface, so ink on the Scaffold's
      // Material underneath would be invisible — same trick as _StarterChip.
      color: Colors.transparent,
      child: Semantics(
        button: true,
        child: InkWell(
          key: const Key('conversation-identity'),
          onTap: onTap,
          borderRadius: TalonRadius.rSm,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: TalonSpace.xs,
              vertical: 3,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TalonType.title
                      .copyWith(fontSize: TalonDensity.d(16, 17.5)),
                ),
                const SizedBox(height: TalonSpace.xxs),
                Row(
                  children: [
                    _ConnDot(connected: connected),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        '$model · $effort',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: TalonColors.textFaint,
                          fontSize: TalonDensity.d(11, 12.5),
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                    // The only cue that this line is a control now that the wide
                    // layout has no bordered model pill to imply it.
                    const SizedBox(width: TalonSpace.xxs),
                    Icon(Icons.expand_more,
                        size: 13, color: TalonColors.textFaint),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Connection dot in the identity subtitle. On a phone this is the header's
/// only connection signal (there is no sidebar pill), so it carries a
/// semantics label too — a 6px colour difference is nothing to a screen reader
/// or a grayscale display. When the link is genuinely down, [_ConnBanner]
/// spells it out in words immediately below the bar.
class _ConnDot extends StatelessWidget {
  final bool connected;
  const _ConnDot({required this.connected});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: connected ? 'Connected' : 'Not connected',
      child: Container(
        width: TalonDensity.d(6, 7),
        height: TalonDensity.d(6, 7),
        decoration: BoxDecoration(
          color: connected ? TalonColors.ok : TalonColors.bad,
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}

class _ChatMenu extends StatelessWidget {
  final AppState state;
  final ClientChat chat;
  const _ChatMenu({required this.state, required this.chat});

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      icon: Icon(Icons.menu,
          size: TalonDensity.d(20, 24), color: TalonColors.accent),
      tooltip: 'Conversation menu',
      iconSize: TalonDensity.d(20, 24),
      color: TalonColors.surfaceHi,
      surfaceTintColor: Colors.transparent,
      elevation: 6,
      shape: RoundedRectangleBorder(
        borderRadius: TalonRadius.rMd,
        side: BorderSide(color: TalonColors.glassStroke),
      ),
      onSelected: (v) async {
        switch (v) {
          case 'reset':
            await confirmResetSession(context, state, chat);
            break;
          case 'export':
            final messenger = ScaffoldMessenger.of(context);
            await Clipboard.setData(
              ClipboardData(text: state.exportMarkdown(chat.id)),
            );
            messenger.showSnackBar(
              const SnackBar(content: Text('Conversation copied as Markdown')),
            );
            break;
          case 'rename':
            await promptRenameChat(context, state, chat);
            break;
          case 'delete':
            await confirmDeleteChat(context, state, chat);
            break;
        }
      },
      itemBuilder: (_) => [
        const PopupMenuItem(
          value: 'reset',
          child: _MenuRow(icon: Icons.refresh, label: 'Reset session'),
        ),
        const PopupMenuItem(
          value: 'export',
          child: _MenuRow(
              icon: Icons.ios_share_outlined, label: 'Copy as Markdown'),
        ),
        const PopupMenuItem(
          value: 'rename',
          child: _MenuRow(icon: Icons.edit_outlined, label: 'Rename'),
        ),
        const PopupMenuItem(
          value: 'delete',
          child: _MenuRow(
              icon: Icons.delete_outline, label: 'Delete', danger: true),
        ),
      ],
    );
  }
}

class _MenuRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool danger;
  const _MenuRow(
      {required this.icon, required this.label, this.danger = false});

  @override
  Widget build(BuildContext context) {
    final color = danger ? TalonColors.bad : TalonColors.text;
    final iconColor = danger ? TalonColors.bad : TalonColors.accent;
    return Row(
      children: [
        Icon(icon, size: 17, color: iconColor),
        const SizedBox(width: 10),
        Text(label, style: TextStyle(color: color, fontSize: 13.5)),
      ],
    );
  }
}

/// Context-window readout: a small fill ring, the percentage, and — once the
/// window is ≥80% full — an exclamation glyph, because the warn state used to
/// be carried by amber alone.
///
/// Now a button: it opens [openContextSheet]. It was informational-only, which
/// made it the one place in the app that knew the window was filling up and the
/// one place that offered nothing to do about it. The tooltip stays for a
/// hovering desktop pointer (cheaper than a sheet for "how full is it?"), but a
/// tooltip is not an affordance on touch, so the figures now have a route that
/// works with a finger.
class _ContextChip extends StatelessWidget {
  final ContextInfo info;
  final bool dense;
  final VoidCallback onTap;

  const _ContextChip({
    required this.info,
    required this.dense,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final color = info.warn ? TalonColors.warn : TalonColors.textDim;
    final figures = info.max > 0
        ? '${formatTokens(info.used)} / ${formatTokens(info.max)} tokens'
            ' (${info.pct}%)'
        : '${formatTokens(info.used)} tokens';
    // The chip renders only "42%", which is meaningless read aloud on its own,
    // so the label carries the same sentence the tooltip does and replaces the
    // bare percentage rather than sitting alongside it.
    return Semantics(
      button: true,
      label: 'Context: $figures',
      excludeSemantics: true,
      child: Tooltip(
        message: 'Context: $figures — tap for details',
        child: Container(
          decoration: BoxDecoration(
            color: info.warn
                ? TalonColors.warn.withValues(alpha: 0.12)
                : TalonColors.glassFill,
            borderRadius: TalonRadius.rPill,
            border: Border.all(
              color: info.warn ? TalonColors.warn : TalonColors.glassStroke,
            ),
          ),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: onTap,
              borderRadius: TalonRadius.rPill,
              child: Padding(
                padding: EdgeInsets.symmetric(
                  horizontal: dense ? TalonSpace.sm : 10,
                  vertical: dense ? 5 : 6,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      width: dense ? 12 : 13,
                      height: dense ? 12 : 13,
                      child: CircularProgressIndicator(
                        value: info.pct.clamp(0, 100) / 100,
                        strokeWidth: 2.4,
                        backgroundColor: TalonColors.glassStroke,
                        valueColor: AlwaysStoppedAnimation(color),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '${info.pct}%',
                      style: TextStyle(
                        fontSize: dense ? 11 : 12,
                        color: color,
                        fontWeight:
                            info.warn ? FontWeight.w700 : FontWeight.w500,
                      ),
                    ),
                    if (info.warn) ...[
                      const SizedBox(width: TalonSpace.xxs),
                      Icon(Icons.priority_high_rounded,
                          size: dense ? 12 : 13, color: TalonColors.warn),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Sticky bar above the composer showing the single queued follow-up while a
/// turn is running. Editable inline (pencil), sendable now (arrow), or
/// discardable (x). It auto-sends when the running turn ends.
class _QueuedBar extends StatefulWidget {
  final AppState state;
  final String chatId;
  const _QueuedBar({required this.state, required this.chatId});

  @override
  State<_QueuedBar> createState() => _QueuedBarState();
}

class _QueuedBarState extends State<_QueuedBar> {
  bool _editing = false;
  final _controller = TextEditingController();
  final _focus = FocusNode();

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _startEdit(String current) {
    _controller.text = current;
    _controller.selection = TextSelection.collapsed(offset: current.length);
    setState(() => _editing = true);
    _focus.requestFocus();
  }

  void _saveEdit() {
    widget.state.editQueued(widget.chatId, _controller.text);
    setState(() => _editing = false);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final queued = widget.state.queuedFor(widget.chatId);
        if (queued == null) {
          if (_editing) _editing = false;
          return const SizedBox.shrink();
        }
        final hasAttachment = queued.hasAttachment;
        return Container(
          margin: const EdgeInsets.fromLTRB(14, 0, 14, 6),
          padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
          decoration: BoxDecoration(
            color: TalonColors.accent.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(14),
            border:
                Border.all(color: TalonColors.accent.withValues(alpha: 0.35)),
          ),
          child: Row(
            children: [
              Icon(Icons.schedule, size: 15, color: TalonColors.accent),
              const SizedBox(width: 8),
              Expanded(
                child: _editing
                    ? TextField(
                        controller: _controller,
                        focusNode: _focus,
                        autofocus: true,
                        minLines: 1,
                        maxLines: 4,
                        style: const TextStyle(fontSize: 13.5),
                        decoration: const InputDecoration(
                          isDense: true,
                          border: InputBorder.none,
                          hintText: 'Edit queued message…',
                        ),
                        onSubmitted: (_) => _saveEdit(),
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            'Queued · sends when the reply finishes',
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.3,
                              color: TalonColors.accent,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Row(
                            children: [
                              if (hasAttachment) ...[
                                Icon(Icons.attach_file,
                                    size: 13, color: TalonColors.textDim),
                                const SizedBox(width: 4),
                              ],
                              Expanded(
                                child: Text(
                                  queued.text.isEmpty && hasAttachment
                                      ? '(attachment)'
                                      : queued.text,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 13.5),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
              ),
              if (_editing)
                _QueuedAction(
                  icon: Icons.check,
                  tooltip: 'Save',
                  color: TalonColors.ok,
                  onTap: _saveEdit,
                )
              else
                _QueuedAction(
                  icon: Icons.edit_outlined,
                  tooltip: 'Edit',
                  onTap: () => _startEdit(queued.text),
                ),
              _QueuedAction(
                icon: Icons.close,
                tooltip: 'Discard',
                onTap: () {
                  setState(() => _editing = false);
                  widget.state.editQueued(widget.chatId, '');
                },
              ),
            ],
          ),
        );
      },
    );
  }
}

class _QueuedAction extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final Color? color;
  final VoidCallback onTap;
  const _QueuedAction({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: Icon(icon, size: 18),
      tooltip: tooltip,
      visualDensity: VisualDensity.compact,
      color: color ?? TalonColors.textDim,
      onPressed: onTap,
    );
  }
}

/// Shimmering placeholder rows while a chat's first history page loads, in
/// the same silhouette as real messages so the swap doesn't jump.
class _HistorySkeleton extends StatelessWidget {
  const _HistorySkeleton();

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    Widget bar(double width, {bool right = false}) {
      final box = Align(
        alignment: right ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          width: width,
          height: 40,
          margin: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: TalonColors.surfaceHi.withValues(alpha: 0.55),
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      );
      if (reduceMotion) return box;
      return box
          .animate(onPlay: (c) => c.repeat())
          .shimmer(
            duration: 1200.ms,
            color: Colors.white.withValues(alpha: 0.06),
          )
          .wrapAmbient();
    }

    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _columnMax),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 10),
          children: [
            bar(220, right: true),
            bar(320),
            bar(180, right: true),
            bar(380),
            bar(260),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    const mark = BrandMark(size: 64);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          reduceMotion
              ? mark
              : mark
                  .animate()
                  .fadeIn(duration: TalonMotion.slow)
                  .scaleXY(begin: 0.85, end: 1, curve: TalonMotion.emphasized),
          const SizedBox(height: TalonSpace.lg),
          Text('Talon', style: TalonType.display),
          const SizedBox(height: 6),
          Text('Select a chat, or start a new one.',
              style: TextStyle(color: TalonColors.textFaint)),
        ],
      ),
    );
  }
}

/// Suggested prompts shown in a fresh conversation, à la ChatGPT/Claude — a few
/// tappable starters so an empty chat feels intentional rather than blank.
const List<({IconData icon, String label, String prompt})> _starters = [
  (
    icon: Icons.summarize_outlined,
    label: 'Summarize my day',
    prompt: 'Summarize what happened today and what needs my attention.',
  ),
  (
    icon: Icons.checklist_rounded,
    label: 'Plan a task',
    prompt: 'Help me break down a task into clear, actionable steps.',
  ),
  (
    icon: Icons.lightbulb_outline,
    label: 'Brainstorm ideas',
    prompt: 'Brainstorm a few creative ideas with me.',
  ),
];

class _ConversationEmpty extends StatelessWidget {
  /// Sends a suggested prompt; null while disconnected (chips disabled).
  final void Function(String prompt)? onPrompt;
  const _ConversationEmpty({required this.onPrompt});

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    final header = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const BrandMark(size: 56),
        const SizedBox(height: TalonSpace.lg),
        // Gradient greeting — the fresh-conversation hero moment.
        ShaderMask(
          shaderCallback: (bounds) =>
              TalonColors.accentGradient.createShader(bounds),
          blendMode: BlendMode.srcIn,
          child: Text(
            'How can I help?',
            style: TalonType.display.copyWith(
              fontSize: 24,
              color: Colors.white,
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text('Send a message to begin.',
            style: TextStyle(color: TalonColors.textFaint)),
      ],
    );

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(TalonSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            reduceMotion
                ? header
                : header
                    .animate()
                    .fadeIn(duration: TalonMotion.slow)
                    .slideY(begin: 0.1, end: 0, curve: TalonMotion.emphasized),
            const SizedBox(height: TalonSpace.xl),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: TalonSpace.sm,
              runSpacing: TalonSpace.sm,
              children: [
                for (var i = 0; i < _starters.length; i++)
                  _StarterChip(
                    starter: _starters[i],
                    index: i,
                    reduceMotion: reduceMotion,
                    onTap: onPrompt == null
                        ? null
                        : () => onPrompt!(_starters[i].prompt),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _StarterChip extends StatelessWidget {
  final ({IconData icon, String label, String prompt}) starter;
  final int index;
  final bool reduceMotion;
  final VoidCallback? onTap;

  const _StarterChip({
    required this.starter,
    required this.index,
    required this.reduceMotion,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final chip = Semantics(
      button: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: TalonRadius.rMd,
          child: Container(
            padding: const EdgeInsets.fromLTRB(
                TalonSpace.sm, TalonSpace.sm, TalonSpace.md, TalonSpace.sm),
            decoration: BoxDecoration(
              color: TalonColors.glassFill,
              borderRadius: TalonRadius.rMd,
              border: Border.all(color: TalonColors.glassStroke),
              boxShadow: TalonShadows.soft,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Accent-tinted icon well, so the starters read as actions.
                Container(
                  width: 28,
                  height: 28,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: TalonColors.accent.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child:
                      Icon(starter.icon, size: 15, color: TalonColors.accent),
                ),
                const SizedBox(width: TalonSpace.sm),
                Text(starter.label,
                    style: TalonType.label.copyWith(color: TalonColors.text)),
              ],
            ),
          ),
        ),
      ),
    );
    if (reduceMotion) return chip;
    final delay = (120 + index * 70).ms;
    return chip
        .animate()
        .fadeIn(delay: delay, duration: TalonMotion.base)
        .slideY(
            begin: 0.3, end: 0, delay: delay, curve: TalonMotion.emphasized);
  }
}

/// Shown over the conversation while files are dragged across it: a dashed
/// accent frame and one line of instruction, so the drop target is visible
/// rather than guessed at.
class _DropOverlay extends StatelessWidget {
  const _DropOverlay();

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Container(
        margin: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: TalonColors.void1.withValues(alpha: 0.82),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: TalonColors.accent, width: 1.6),
        ),
        alignment: Alignment.center,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.file_download_outlined,
                size: 34, color: TalonColors.accent),
            const SizedBox(height: 10),
            Text(
              'Drop to attach',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: TalonColors.text,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Any file type — images, archives, documents',
              style: TextStyle(fontSize: 12.5, color: TalonColors.textDim),
            ),
          ],
        ),
      ),
    );
  }
}
