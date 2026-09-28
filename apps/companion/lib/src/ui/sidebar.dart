import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;

import '../models/bridge_models.dart';
import '../services/haptics.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'brand.dart';
import 'chat_actions.dart';
import 'empty_state.dart';
import 'glass.dart';
import 'markdown.dart';
import 'motion.dart';
import 'settings_screen.dart';
import 'status_pill.dart';

/// The chat list. Two presentations from one widget:
///
///   * desktop rail — a glass card docked beside the conversation, with the
///     new-chat CTA at the top and a status/settings footer;
///   * phone home ([mobile]) — the same content as a full-bleed screen: a
///     single top bar carrying identity, live status and settings, then
///     search, then the list, with the primary action moved to a floating
///     button in the thumb zone where a phone's main action belongs.
class Sidebar extends StatefulWidget {
  final AppState state;

  /// When set (narrow layout) tapping a chat routes through this.
  final void Function(String chatId)? onSelect;

  /// Phone presentation: no glass card, top bar + FAB instead of the rail's
  /// header CTA and footer.
  final bool mobile;

  const Sidebar({
    super.key,
    required this.state,
    required this.onSelect,
    this.mobile = false,
  });

  @override
  State<Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<Sidebar> {
  String _query = '';

  /// Phone only: the FAB rides out to its labelled form at rest and pulls in
  /// to a bare + while the list scrolls under it.
  bool _fabExtended = true;

  /// Daemon-side full-text hits for [_query] — the same `GET /search` the
  /// desktop quick switcher uses, so message search isn't keyboard-only.
  List<SearchHit> _hits = const [];
  bool _searching = false;
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  /// Collapse the phone FAB while the list is moving away from the user and
  /// restore it when they scroll back — the standard Material behaviour, so a
  /// labelled button never covers the row you're reading.
  bool _onUserScroll(UserScrollNotification n) {
    if (!widget.mobile) return false;
    final extended = switch (n.direction) {
      ScrollDirection.reverse => false,
      ScrollDirection.forward => true,
      ScrollDirection.idle => _fabExtended,
    };
    if (extended != _fabExtended) {
      // The notification arrives mid-layout; defer the rebuild by a frame.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() => _fabExtended = extended);
      });
    }
    return false;
  }

  bool get _isTouch =>
      defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;

  void _onQuery(String v) {
    setState(() => _query = v);
    _debounce?.cancel();
    final q = v.trim();
    if (q.length < 2) {
      setState(() {
        _hits = const [];
        _searching = false;
      });
      return;
    }
    setState(() => _searching = true);
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      final hits = await widget.state.searchMessages(q);
      // A slower response for an older query must not clobber the newer one.
      if (mounted && q == _query.trim()) {
        setState(() {
          _hits = hits;
          _searching = false;
        });
      }
    });
  }

  /// Chat ids we've already shown, so the entrance cascade plays once per tile
  /// and never re-fires on the frequent rebuilds driven by live streaming.
  final Set<String> _seen = <String>{};

  void _openSettings(BuildContext context) => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => SettingsScreen(state: widget.state),
        ),
      );

  /// The settings glyph, wearing a dot while a new release is waiting. This
  /// is the updater's only presence outside Settings on purpose: a banner over
  /// the conversation would interrupt the thing people opened the app for,
  /// and the check that feeds it never downloads anything on its own.
  Widget _settingsGlyph({required double size}) => AnimatedBuilder(
        animation: widget.state.updates,
        builder: (context, _) {
          final glyph = Icon(
            Icons.settings_outlined,
            size: size,
            color: TalonColors.textDim,
          );
          if (!widget.state.updates.updateAvailable) return glyph;
          return Stack(
            clipBehavior: Clip.none,
            children: [
              glyph,
              Positioned(
                right: -1,
                top: -1,
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: TalonColors.accent,
                    shape: BoxShape.circle,
                    border: Border.all(color: TalonColors.surface, width: 1.5),
                  ),
                ),
              ),
            ],
          );
        },
      );

  /// The wordmark, wearing the brand gradient — one deliberate hero moment,
  /// matching the falcon tile beside it.
  Widget _wordmark({required double size}) => ShaderMask(
        shaderCallback: (bounds) =>
            TalonColors.accentGradient.createShader(bounds),
        blendMode: BlendMode.srcIn,
        child: Text(
          widget.state.status.botName,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TalonType.title.copyWith(
            fontSize: size,
            fontWeight: FontWeight.w700,
            color: Colors.white,
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    if (widget.mobile) return _mobile(context);
    return Glass(
      radius: TalonRadius.lg,
      blur: 24,
      padding: const EdgeInsets.fromLTRB(
          TalonSpace.md, TalonSpace.lg, TalonSpace.md, TalonSpace.sm),
      child: ListenableBuilder(
        listenable: widget.state,
        builder: (context, _) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const BrandMark(size: 30),
                  const SizedBox(width: TalonSpace.sm + 2),
                  Expanded(child: _wordmark(size: 17)),
                ],
              ),
              const SizedBox(height: TalonSpace.md),
              _NewChatButton(onTap: widget.state.newChat),
              const SizedBox(height: TalonSpace.sm),
              _SearchBox(onChanged: _onQuery),
              const SizedBox(height: TalonSpace.sm),
              Expanded(child: _groupedList(context)),
              const Divider(height: TalonSpace.md),
              Row(
                children: [
                  Expanded(child: StatusPill(state: widget.state)),
                  IconButton(
                    tooltip: 'Settings',
                    onPressed: () => _openSettings(context),
                    icon: _settingsGlyph(size: 20),
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  /// Phone home screen. The rail's three chrome rows (header, full-width CTA,
  /// footer status + settings) collapse into one top bar plus a floating
  /// action button: identity, connection state and settings share a single
  /// line, and the ~120px that the CTA and footer used to spend is returned to
  /// the conversation list. "New chat" moves to the bottom-right FAB — the
  /// reachable corner on a phone, and where Material puts a screen's primary
  /// action — and collapses to a bare + while the list is scrolling so it
  /// never sits on top of what you're reading.
  Widget _mobile(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        return Stack(
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  // Left edge shared with the search field and the tiles;
                  // right edge 0 so the settings target runs to the screen
                  // edge and its glyph lands on the same 12px margin as
                  // everything else in the column.
                  padding: const EdgeInsets.fromLTRB(
                      TalonSpace.md, TalonSpace.sm, 0, 0),
                  child: Row(
                    children: [
                      const BrandMark(size: 32),
                      const SizedBox(width: TalonSpace.md),
                      // Identity + status share ONE expanded slot, so all the
                      // slack lives inside it and the settings button stays
                      // pinned to the right edge. (A Flexible wordmark beside
                      // a Spacer split that slack between them, which parked
                      // the gear short of the edge — and the longer the bot
                      // name, the further short.)
                      Expanded(
                        child: Row(
                          children: [
                            Flexible(child: _wordmark(size: 20)),
                            const SizedBox(width: TalonSpace.sm),
                            StatusPill(state: widget.state, compact: true),
                          ],
                        ),
                      ),
                      const SizedBox(width: TalonSpace.sm),
                      IconButton(
                        tooltip: 'Settings',
                        onPressed: () => _openSettings(context),
                        iconSize: 24,
                        // A full 48dp target that ends at the screen edge:
                        // zero padding + fixed box, so the glyph itself sits
                        // 12px in rather than the ~20px the default padding
                        // pushed it to.
                        padding: EdgeInsets.zero,
                        constraints: BoxConstraints.tightFor(
                          width: TalonDensity.tap,
                          height: TalonDensity.tap,
                        ),
                        icon: _settingsGlyph(size: 24),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(TalonSpace.md,
                      TalonSpace.sm, TalonSpace.md, TalonSpace.sm),
                  child: _SearchBox(onChanged: _onQuery),
                ),
                Expanded(
                  child: Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: TalonSpace.xs),
                    child: _groupedList(context),
                  ),
                ),
              ],
            ),
            Positioned(
              right: TalonSpace.lg,
              // Above the navigation bar the list scrolls under. Uses
              // padding (not viewPadding) so it rides the keyboard's edge
              // when the search field is focused instead of hovering an
              // inset that is no longer there.
              bottom: TalonSpace.lg + MediaQuery.of(context).padding.bottom,
              child: _NewChatFab(
                extended: _fabExtended,
                onTap: widget.state.newChat,
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _groupedList(BuildContext context) {
    final chats = widget.state.chats.where((c) {
      if (_query.isEmpty) return true;
      final q = _query.toLowerCase();
      return c.title.toLowerCase().contains(q) ||
          c.preview.toLowerCase().contains(q);
    }).toList();

    final searchingMessages = _query.trim().length >= 2;
    if (chats.isEmpty &&
        !(searchingMessages && (_searching || _hits.isNotEmpty))) {
      final connected = widget.state.conn == ConnState.connected;
      final label = connected
          ? (_query.isEmpty ? 'No chats yet.' : 'No matches.')
          : 'Connecting…';
      // On a phone the list IS the screen, so an empty one deserves more than
      // a line of grey text: say what the button in the corner will do.
      if (widget.mobile && connected && _query.isEmpty) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(TalonSpace.xl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const BrandMark(size: 52),
                const SizedBox(height: TalonSpace.lg),
                Text('No chats yet', style: TalonType.title),
                const SizedBox(height: 6),
                Text(
                  'Tap New chat to start talking to '
                  '${widget.state.status.botName}.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: TalonColors.textFaint, height: 1.5),
                ),
              ],
            ),
          ),
        );
      }
      return TalonEmptyState(
        compact: true,
        icon: !connected
            ? Icons.cloud_sync_outlined
            : (_query.isEmpty
                ? Icons.forum_outlined
                : Icons.search_off_outlined),
        title: label,
        message: !connected
            ? null
            : (_query.isEmpty
                ? 'New chats will appear here.'
                : 'No chat title or preview matches “${_query.trim()}”.'),
      );
    }

    final groups = _groupByTime(chats);
    // Stagger only tiles the sidebar hasn't shown before, cascading by their
    // ordinal among the fresh ones so the first paint ripples in without
    // re-animating on every streaming-driven rebuild.
    var freshOrdinal = 0;
    final reduceMotion = MediaQuery.of(context).disableAnimations;

    // Flattened rows for a lazy ListView.builder: only the tiles on screen
    // are built. The list used to build every tile (and parse every preview)
    // on every AppState notification.
    final items = <Object>[
      for (final group in groups) ...[
        _GroupHeader(group.label),
        ...group.chats,
      ],
      if (searchingMessages) ...[
        const _MessagesHeader(),
        if (!_searching && _hits.isEmpty) const _NoHits(),
        ..._hits.take(12),
      ],
    ];

    // Freshness is decided for every chat up front, in list order, exactly
    // as when the whole list was built eagerly — the lazy builder only
    // decides which tiles get built, never which ones count as new.
    final freshOrder = <String, int>{};
    for (final group in groups) {
      for (final chat in group.chats) {
        if (_seen.add(chat.id)) freshOrder[chat.id] = freshOrdinal++;
      }
    }

    Widget chatTile(ClientChat chat) {
      final ordinal = freshOrder[chat.id];
      final isFresh = ordinal != null;
      // Stagger only the fresh tiles; the delay is fixed at the tile's
      // first appearance and latched inside EntranceFx, so later
      // rebuilds never restart or truncate the cascade.
      final delay = ordinal != null
          ? TalonMotion.stagger * ordinal.clamp(0, 12)
          : Duration.zero;
      Widget tile = _ChatTile(
        chat: chat,
        selected: chat.id == widget.state.selectedChatId,
        unread: widget.state.hasUnread(chat),
        onTap: () => (widget.onSelect ?? widget.state.selectChat)(chat.id),
        // Touch path to every chat action (rename/export/reset/
        // delete) — the hover-only delete affordance doesn't
        // exist on a phone.
        onLongPress: () => showChatActionsSheet(context, widget.state, chat),
        onDelete: () => confirmDeleteChat(context, widget.state, chat),
      );
      // Mobile: swipe a tile left to delete (with the usual confirm).
      // confirmDismiss always resolves false — deletion happens via
      // AppState and the rebuild removes the tile, which sidesteps
      // Dismissible's "must be gone once dismissed" contract when a
      // slow round-trip would otherwise leave it in the tree.
      if (_isTouch) {
        tile = Dismissible(
          key: ValueKey('swipe-${chat.id}'),
          direction: DismissDirection.endToStart,
          confirmDismiss: (_) async {
            Haptics.medium();
            await confirmDeleteChat(context, widget.state, chat);
            return false;
          },
          background: Container(
            alignment: Alignment.centerRight,
            padding: const EdgeInsets.only(right: TalonSpace.lg),
            decoration: BoxDecoration(
              borderRadius: TalonRadius.rSm,
              color: TalonColors.bad.withValues(alpha: 0.18),
            ),
            child: Icon(Icons.delete_outline, size: 18, color: TalonColors.bad),
          ),
          child: tile,
        );
      }
      return EntranceFx(
        key: ValueKey('tile-${chat.id}'),
        enabled: isFresh && !reduceMotion,
        from: const Offset(-0.12, 0),
        delay: delay,
        child: tile,
      );
    }

    Widget item(int i) => switch (items[i]) {
          _GroupHeader(:final label) => Padding(
              key: ValueKey('group-$label'),
              padding: const EdgeInsets.fromLTRB(
                  TalonSpace.sm, TalonSpace.sm, TalonSpace.sm, 6),
              child: Text(label.toUpperCase(), style: TalonType.eyebrow),
            ),
          final ClientChat chat => chatTile(chat),
          // Full-text hits from the daemon, below the title matches — brings
          // the desktop quick switcher's message search to every layout.
          _MessagesHeader() => Padding(
              key: const ValueKey('messages-header'),
              padding: const EdgeInsets.fromLTRB(
                  TalonSpace.sm, TalonSpace.md, TalonSpace.sm, 6),
              child: Row(
                children: [
                  Text('MESSAGES', style: TalonType.eyebrow),
                  const SizedBox(width: TalonSpace.sm),
                  if (_searching)
                    const SizedBox(
                      width: 10,
                      height: 10,
                      child: CircularProgressIndicator(strokeWidth: 1.6),
                    ),
                ],
              ),
            ),
          _NoHits() => Padding(
              key: const ValueKey('no-hits'),
              padding: const EdgeInsets.symmetric(
                  horizontal: TalonSpace.sm, vertical: TalonSpace.xs),
              child: Text('No message matches.', style: TalonType.caption),
            ),
          final SearchHit hit => _HitTile(
              hit: hit,
              onTap: () =>
                  (widget.onSelect ?? widget.state.selectChat)(hit.chatId),
            ),
          _ => const SizedBox.shrink(),
        };

    // Key → index, so a tile keeps its element (hover state, entrance) when
    // chats above it are added, removed or reordered.
    final keyIndex = <Object, int>{
      for (var i = 0; i < items.length; i++)
        if (items[i] is ClientChat) 'tile-${(items[i] as ClientChat).id}': i,
    };

    final list = ListView.builder(
      // Room under the last tile for the floating action button AND for the
      // navigation bar the list now scrolls beneath — without it the last
      // chat would come to rest under the gesture pill.
      padding: widget.mobile
          ? EdgeInsets.only(bottom: 84 + MediaQuery.of(context).padding.bottom)
          : EdgeInsets.zero,
      itemCount: items.length,
      itemBuilder: (context, i) => item(i),
      findChildIndexCallback: (key) =>
          key is ValueKey<String> ? keyIndex[key.value] : null,
    );

    // Pull-to-refresh: re-sync chats/models (or retry the connection when
    // it's down). Mostly a touch gesture; harmless on desktop.
    final refreshable = RefreshIndicator(
      onRefresh: widget.state.refresh,
      color: TalonColors.accent,
      backgroundColor: TalonColors.surfaceHi,
      child: list,
    );
    if (!widget.mobile) return refreshable;
    return NotificationListener<UserScrollNotification>(
      onNotification: _onUserScroll,
      child: refreshable,
    );
  }

  List<_Group> _groupByTime(List<ClientChat> chats) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final week = today.subtract(const Duration(days: 7));
    final month = today.subtract(const Duration(days: 30));

    final buckets = <String, List<ClientChat>>{
      'Today': [],
      'Yesterday': [],
      'Previous 7 days': [],
      'Previous 30 days': [],
      'Older': [],
    };
    for (final c in chats) {
      final d = c.lastActiveTime;
      if (!d.isBefore(today)) {
        buckets['Today']!.add(c);
      } else if (!d.isBefore(yesterday)) {
        buckets['Yesterday']!.add(c);
      } else if (!d.isBefore(week)) {
        buckets['Previous 7 days']!.add(c);
      } else if (!d.isBefore(month)) {
        buckets['Previous 30 days']!.add(c);
      } else {
        buckets['Older']!.add(c);
      }
    }
    return [
      for (final entry in buckets.entries)
        if (entry.value.isNotEmpty) _Group(entry.key, entry.value),
    ];
  }
}

class _Group {
  final String label;
  final List<ClientChat> chats;
  _Group(this.label, this.chats);
}

/// Row kinds in the lazy chat list besides chats and search hits.
class _GroupHeader {
  final String label;
  const _GroupHeader(this.label);
}

class _MessagesHeader {
  const _MessagesHeader();
}

class _NoHits {
  const _NoHits();
}

/// Per-chat identity gradient, derived from the title so every conversation
/// gets a stable, distinct hue pair (WhatsApp/Telegram avatar pattern).
/// Saturation/lightness are pinned per brightness so any hue stays readable
/// under white text.
LinearGradient chatIdentityGradient(String seedText) {
  final h =
      seedText.codeUnits.fold<int>(0, (a, c) => (a * 31 + c) & 0x7fffffff);
  final hue = (h % 360).toDouble();
  final dark = TalonTheme.isDark;
  final c1 = HSLColor.fromAHSL(1, hue, 0.55, dark ? 0.60 : 0.50).toColor();
  final c2 = HSLColor.fromAHSL(1, (hue + 42) % 360, 0.60, dark ? 0.46 : 0.38)
      .toColor();
  return LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [c1, c2],
  );
}

/// Rounded-square avatar with the chat's identity gradient and initial.
class _ChatAvatar extends StatelessWidget {
  final String title;
  const _ChatAvatar({required this.title});

  @override
  Widget build(BuildContext context) {
    final t = title.trim();
    final initial = t.isEmpty ? '·' : String.fromCharCode(t.runes.first);
    final size = TalonDensity.d(34, 42);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        gradient: chatIdentityGradient(title),
        borderRadius: BorderRadius.circular(TalonDensity.d(11, 13)),
      ),
      child: Text(
        initial.toUpperCase(),
        style: TextStyle(
          color: Colors.white,
          fontSize: TalonDensity.d(14, 17),
          fontWeight: FontWeight.w700,
          height: 1,
        ),
      ),
    );
  }
}

/// Compact "how long ago" stamp for chat tiles: `now`, `12m`, `3h`, `2d`,
/// then a short date once it's over a week old.
String _relTime(DateTime t) {
  final diff = DateTime.now().difference(t);
  if (diff.inMinutes < 1) return 'now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  if (diff.inDays < 7) return '${diff.inDays}d';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${t.day} ${months[t.month - 1]}';
}

class _ChatTile extends StatefulWidget {
  final ClientChat chat;
  final bool selected;
  final bool unread;
  final VoidCallback onTap;
  final VoidCallback onLongPress;
  final VoidCallback onDelete;

  const _ChatTile({
    required this.chat,
    required this.selected,
    required this.unread,
    required this.onTap,
    required this.onLongPress,
    required this.onDelete,
  });

  @override
  State<_ChatTile> createState() => _ChatTileState();
}

class _ChatTileState extends State<_ChatTile> {
  bool _hover = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final selected = widget.selected;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        onLongPress: () {
          Haptics.medium();
          widget.onLongPress();
        },
        onTapDown: (_) => setState(() => _pressed = true),
        onTapUp: (_) => setState(() => _pressed = false),
        onTapCancel: () => setState(() => _pressed = false),
        child: AnimatedScale(
          scale: _pressed ? 0.975 : 1.0,
          duration: TalonMotion.fast,
          curve: TalonMotion.emphasized,
          child: AnimatedContainer(
            duration: TalonMotion.fast,
            curve: TalonMotion.standard,
            margin: EdgeInsets.symmetric(vertical: TalonDensity.d(2, 3)),
            padding: EdgeInsets.symmetric(
                horizontal: TalonSpace.sm, vertical: TalonDensity.d(8, 11)),
            decoration: BoxDecoration(
              borderRadius: TalonRadius.rMd,
              color: selected
                  ? TalonColors.accent.withValues(alpha: 0.14)
                  : (_hover ? TalonColors.surface : Colors.transparent),
              border: Border.all(
                color: selected
                    ? TalonColors.accent.withValues(alpha: 0.35)
                    : Colors.transparent,
              ),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                _ChatAvatar(title: widget.chat.title),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              widget.chat.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: TalonDensity.d(13.5, 15),
                                fontWeight: selected || widget.unread
                                    ? FontWeight.w600
                                    : FontWeight.w500,
                                color: selected || widget.unread
                                    ? TalonColors.text
                                    : TalonColors.textDim,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            _relTime(widget.chat.lastActiveTime),
                            style: TextStyle(
                                fontSize: TalonDensity.d(10.5, 11.5),
                                color: TalonColors.textFaint),
                          ),
                          // Unread: activity newer than the user's last look.
                          if (widget.unread)
                            Container(
                              width: TalonDensity.d(7, 8),
                              height: TalonDensity.d(7, 8),
                              margin: const EdgeInsets.only(left: 6),
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                gradient: TalonColors.accentGradient,
                              ),
                            ),
                        ],
                      ),
                      if (widget.chat.preview.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 1),
                          child: InlineMarkdownText(
                            key: ValueKey('chat-preview-${widget.chat.id}'),
                            data: widget.chat.preview,
                            style: TextStyle(
                                fontSize: TalonDensity.d(11.5, 13),
                                color: TalonColors.textFaint,
                                height: 1.35),
                          ),
                        ),
                    ],
                  ),
                ),
                // Pointer-only affordance: on touch the same action lives in
                // the long-press sheet and the swipe, both of which are real
                // targets — this 15px glyph is not.
                if (!TalonDensity.touch)
                  AnimatedOpacity(
                    duration: TalonMotion.fast,
                    opacity: (_hover || selected) ? 1 : 0,
                    child: IgnorePointer(
                      ignoring: !(_hover || selected),
                      child: Semantics(
                        button: true,
                        label: 'Delete chat',
                        child: InkWell(
                          onTap: widget.onDelete,
                          borderRadius: BorderRadius.circular(6),
                          child: Padding(
                            padding: const EdgeInsets.all(2),
                            child: Icon(Icons.close,
                                size: 15, color: TalonColors.textFaint),
                          ),
                        ),
                      ),
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

class _NewChatButton extends StatefulWidget {
  final VoidCallback onTap;
  const _NewChatButton({required this.onTap});

  @override
  State<_NewChatButton> createState() => _NewChatButtonState();
}

class _NewChatButtonState extends State<_NewChatButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        // The one primary CTA in the sidebar: full accent gradient with a
        // matching glow that deepens on hover.
        child: AnimatedContainer(
          duration: TalonMotion.fast,
          curve: TalonMotion.standard,
          padding: const EdgeInsets.symmetric(
              vertical: 12, horizontal: TalonSpace.md),
          decoration: BoxDecoration(
            borderRadius: TalonRadius.rMd,
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: _hover
                  ? [TalonColors.accent, TalonColors.accent]
                  : [TalonColors.accent, TalonColors.accentDeep],
            ),
            boxShadow: [
              BoxShadow(
                color:
                    TalonColors.accent.withValues(alpha: _hover ? 0.45 : 0.28),
                blurRadius: _hover ? 22 : 14,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.add_rounded, color: Colors.white, size: 19),
              SizedBox(width: TalonSpace.sm),
              Text(
                'New chat',
                style: TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w600,
                    fontSize: 13.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A full-text search hit: chat title + a one-line snippet of the matching
/// message. Tapping opens the chat.
class _HitTile extends StatelessWidget {
  final SearchHit hit;
  final VoidCallback onTap;
  const _HitTile({required this.hit, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: TalonRadius.rSm,
      child: Padding(
        padding:
            const EdgeInsets.symmetric(horizontal: TalonSpace.sm, vertical: 7),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Icon(Icons.manage_search,
                  size: 15, color: TalonColors.textFaint),
            ),
            const SizedBox(width: TalonSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    hit.chatTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: TalonColors.textDim,
                    ),
                  ),
                  InlineMarkdownText(
                    data: hit.message.text,
                    maxLines: 2,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.35,
                      color: TalonColors.textFaint,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SearchBox extends StatefulWidget {
  final ValueChanged<String> onChanged;
  const _SearchBox({required this.onChanged});

  @override
  State<_SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<_SearchBox> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _clear() {
    _controller.clear();
    widget.onChanged('');
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: _controller,
      onChanged: (v) {
        widget.onChanged(v);
        setState(() {}); // keep the clear affordance in sync
      },
      style: const TextStyle(fontSize: 13.5),
      decoration: InputDecoration(
        isDense: true,
        prefixIcon: const Icon(Icons.search, size: 17),
        prefixIconConstraints:
            const BoxConstraints(minWidth: 36, minHeight: 36),
        suffixIcon: _controller.text.isEmpty
            ? null
            : IconButton(
                onPressed: _clear,
                icon: const Icon(Icons.close, size: 15),
                tooltip: 'Clear',
              ),
        suffixIconConstraints:
            const BoxConstraints(minWidth: 36, minHeight: 36),
        hintText: 'Search chats & messages',
        hintStyle: TextStyle(color: TalonColors.textFaint, fontSize: 13),
        filled: true,
        fillColor: TalonColors.void0.withValues(alpha: 0.5),
        contentPadding: const EdgeInsets.symmetric(vertical: TalonSpace.sm),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: BorderSide(color: TalonColors.glassStroke),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: BorderSide(color: TalonColors.glassStroke),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: BorderSide(color: TalonColors.accent),
        ),
      ),
    );
  }
}

/// The phone's primary action: a gradient pill in the reachable corner. It
/// carries its label at rest and pulls in to a bare + while the list scrolls,
/// so it never covers the row being read.
class _NewChatFab extends StatelessWidget {
  final bool extended;
  final VoidCallback onTap;
  const _NewChatFab({required this.extended, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(20);
    return Container(
      height: 56,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [TalonColors.accent, TalonColors.accentDeep],
        ),
        borderRadius: radius,
        boxShadow: [
          BoxShadow(
            color: TalonColors.accent.withValues(alpha: 0.36),
            blurRadius: 22,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () {
            Haptics.medium();
            onTap();
          },
          borderRadius: radius,
          child: AnimatedSize(
            duration: TalonMotion.base,
            curve: TalonMotion.emphasized,
            alignment: Alignment.centerRight,
            child: Padding(
              padding: EdgeInsets.symmetric(
                  horizontal: extended ? TalonSpace.lg : 16),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.add_rounded, color: Colors.white, size: 24),
                  if (extended) ...[
                    const SizedBox(width: TalonSpace.sm),
                    const Text(
                      'New chat',
                      style: TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
