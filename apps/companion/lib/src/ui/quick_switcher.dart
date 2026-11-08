import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'chat_actions.dart';
import 'extensions_screen.dart';
import 'logs_screen.dart';
import 'markdown.dart';
import 'model_sheet.dart';
import 'motion.dart';
import 'settings_screen.dart';
import 'shortcuts_help.dart';

/// Cmd/Ctrl+K command palette: run an action, jump to a chat, or search
/// message bodies — keyboard-first (↑↓ to move, Enter to run, Esc to dismiss).
///
/// Actions and chats match locally and instantly; message hits stream in from
/// `GET /search` after a short debounce. The action list is the point: nearly
/// every command here also lives behind a menu, a long-press sheet, or a
/// Settings card, and this is the only surface that makes them reachable by
/// name.
///
/// [context] is the *caller's* (the shell's), and it is handed to the palette
/// deliberately: the palette dismisses itself before running a command, so by
/// the time a command wants to push a route or raise a confirmation dialog its
/// own context is unmounted. The shell's outlives the dialog.
Future<void> openQuickSwitcher(BuildContext context, AppState state) {
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.55),
    builder: (_) => _QuickSwitcher(state: state, host: context),
  );
}

/// One palette command. [run] receives the host context described above, never
/// the palette's own.
class _Command {
  final String name;

  /// Second line — usually what the command is about to act on, so
  /// "Delete this chat" can never be ambiguous about *which* chat.
  final String? detail;
  final IconData icon;

  /// Extra lowercase match terms, so a command is findable by intent ("dark",
  /// "export", "reboot") and not only by its exact wording.
  final String keywords;

  /// Shown in the default list, when nothing has been typed yet.
  final bool primary;

  /// A global chord that also triggers this, rendered as a key cap. The
  /// binding itself lives in app_shell.dart — this is just the label.
  final String? chord;

  /// Destructive: wears the `bad` tint instead of the accent.
  final bool danger;

  final Future<void> Function(BuildContext host) run;

  const _Command({
    required this.name,
    required this.icon,
    required this.keywords,
    required this.run,
    this.detail,
    this.primary = false,
    this.chord,
    this.danger = false,
  });

  /// [query] is already trimmed and lowercased by the caller.
  bool matches(String query) =>
      name.toLowerCase().contains(query) || keywords.contains(query);
}

/// A row in the palette's flat list. Section headers and notes are rows too so
/// the whole sectioned result set builds as one linear [ListView], but only
/// [_CommandRow] / [_JumpRow] ever take the keyboard highlight — see
/// `_selectableIndices`.
sealed class _Row {
  const _Row();
}

/// An all-caps eyebrow header ("ACTIONS", "CHATS", "MESSAGES").
class _SectionRow extends _Row {
  final String label;

  /// Shows a hairline spinner beside the label (the daemon search in flight).
  final bool busy;

  const _SectionRow(this.label, {this.busy = false});
}

/// Non-selectable explanatory line inside a section.
class _NoteRow extends _Row {
  final String text;
  const _NoteRow(this.text);
}

class _CommandRow extends _Row {
  final _Command command;
  const _CommandRow(this.command);
}

/// A jump target: an existing chat, or a message hit inside one. Both open the
/// chat, so they share a row type.
class _JumpRow extends _Row {
  final String chatId;
  final String title;
  final String? subtitle;
  final IconData icon;
  const _JumpRow({
    required this.chatId,
    required this.title,
    required this.icon,
    this.subtitle,
  });
}

class _QuickSwitcher extends StatefulWidget {
  final AppState state;

  /// The invoking (shell) context — see [openQuickSwitcher].
  final BuildContext host;

  const _QuickSwitcher({required this.state, required this.host});

  @override
  State<_QuickSwitcher> createState() => _QuickSwitcherState();
}

class _QuickSwitcherState extends State<_QuickSwitcher> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();

  /// Attached to whichever row currently holds the highlight, so arrow keys
  /// can scroll it into view. Exactly one row carries it per frame, so moving
  /// it between rows never trips the duplicate-key assertion.
  final _highlightKey = GlobalKey();

  Timer? _debounce;
  List<SearchHit> _hits = const [];
  bool _searching = false;

  /// Position of the highlight *within the selectable rows*, not within the
  /// row list — that's what keeps ↑↓ from ever landing on a section header.
  int _cursor = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onQuery(String q) {
    setState(() => _cursor = 0);
    _debounce?.cancel();
    if (q.trim().length < 2) {
      setState(() {
        _hits = const [];
        _searching = false;
      });
      return;
    }
    setState(() => _searching = true);
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      final hits = await widget.state.searchMessages(q);
      if (mounted) {
        setState(() {
          _hits = hits;
          _searching = false;
        });
      }
    });
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  /// The command set for the current app state. Rebuilt per keystroke rather
  /// than cached because half of it is conditional: chat-scoped actions only
  /// exist while a chat is selected, daemon controls only while connected, and
  /// the theme entry flips label with the active palette.
  List<_Command> _commands() {
    final state = widget.state;
    final chat = state.selectedChat;
    final connected = state.conn == ConnState.connected;
    final mod = defaultTargetPlatform == TargetPlatform.macOS ? '⌘' : 'Ctrl';
    final dark = TalonTheme.isDark;

    return [
      _Command(
        name: 'New chat',
        icon: Icons.add_rounded,
        keywords: 'create start compose conversation',
        primary: true,
        chord: '$mod N',
        run: (_) => state.newChat(),
      ),
      // Chat-scoped actions: only meaningful with a target, and each carries
      // that target on its detail line so "delete" can't be a leap of faith.
      if (chat != null) ...[
        _Command(
          name: "Reset this chat's session",
          detail: 'Start fresh in "${chat.title}"',
          icon: Icons.refresh,
          keywords: 'clear context forget restart session',
          primary: true,
          // Shares the action sheet's confirm rather than resetting outright:
          // a palette makes destructive actions reachable in two keystrokes,
          // which is exactly why this one must still ask.
          run: (host) => confirmResetSession(host, state, chat),
        ),
        _Command(
          name: 'Change model or reasoning effort',
          detail: chat.model == null
              ? 'Pick a model for "${chat.title}"'
              : '${chat.model} · effort ${chat.effort ?? 'adaptive'}',
          icon: Icons.tune,
          keywords: 'llm backend thinking effort switch',
          primary: true,
          run: (host) => openModelSheet(host, state, chat),
        ),
        _Command(
          name: 'Rename this chat',
          detail: chat.title,
          icon: Icons.edit_outlined,
          keywords: 'title label',
          run: (host) => promptRenameChat(host, state, chat),
        ),
        _Command(
          name: 'Copy this conversation as Markdown',
          detail: chat.title,
          icon: Icons.ios_share_outlined,
          keywords: 'export share clipboard md',
          run: (host) => _copyMarkdown(host, state, chat),
        ),
        _Command(
          name: 'Delete this chat',
          detail: chat.title,
          icon: Icons.delete_outline,
          keywords: 'remove trash',
          danger: true,
          run: (host) => confirmDeleteChat(host, state, chat),
        ),
      ],
      _Command(
        name: 'Open Talon settings',
        icon: Icons.settings_outlined,
        keywords: 'preferences config appearance accent connection mesh voice',
        primary: true,
        run: (host) => _push(host, (_) => SettingsScreen(state: state)),
      ),
      _Command(
        name: 'View daemon logs',
        icon: Icons.receipt_long_outlined,
        keywords: 'log console diagnostics debug',
        run: (host) => _push(host, (_) => LogsScreen(state: state)),
      ),
      // Same additive-capability gate the Settings card uses: an older daemon
      // has no /plugins endpoint, so the commands simply don't exist.
      if (state.status.hasCapability('plugins-skills')) ...[
        _Command(
          name: 'Manage plugins',
          icon: Icons.extension_outlined,
          keywords: 'extensions mcp modules builtins',
          run: (host) => _push(host, (_) => PluginsScreen(state: state)),
        ),
        _Command(
          name: 'Manage skills',
          icon: Icons.menu_book_outlined,
          keywords: 'extensions workflows bundles',
          run: (host) => _push(host, (_) => SkillsScreen(state: state)),
        ),
      ],
      // Daemon controls go over the bridge, so they work against a remote
      // Talon too — but only once there's a connection to send them down.
      if (connected) ...[
        _Command(
          name: 'Run dream now',
          detail: 'Consolidate memory and write the diary',
          icon: Icons.auto_awesome_outlined,
          keywords: 'memory diary consolidate sleep',
          run: (host) => _runControl(host, state, 'dream', 'Dreaming…'),
        ),
        _Command(
          name: 'Restart Talon',
          detail: 'Bounce the daemon — applies pending config changes',
          icon: Icons.restart_alt,
          keywords: 'reboot bounce daemon',
          danger: true,
          run: (host) => _confirmRestart(host, state),
        ),
      ],
      _Command(
        name: dark ? 'Switch to light theme' : 'Switch to dark theme',
        icon: dark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
        keywords: 'theme appearance dark light mode palette',
        run: (_) =>
            _setThemeMode(state, dark ? ThemeMode.light : ThemeMode.dark),
      ),
      if (TalonTheme.mode.value != ThemeMode.system)
        _Command(
          name: 'Match the system theme',
          icon: Icons.brightness_auto_outlined,
          keywords: 'theme appearance auto system',
          run: (_) => _setThemeMode(state, ThemeMode.system),
        ),
      _Command(
        name: 'Refresh from Talon',
        detail:
            connected ? 'Re-sync chats and models' : 'Retry the connection now',
        icon: Icons.sync,
        keywords: 'reload reconnect sync',
        run: (_) => state.refresh(),
      ),
      _Command(
        name: 'Keyboard shortcuts',
        icon: Icons.keyboard_outlined,
        keywords: 'help keys bindings chords',
        primary: true,
        run: (host) => openShortcutsHelp(host),
      ),
    ];
  }

  // ── Result rows ────────────────────────────────────────────────────────────

  List<_Row> _rows() {
    final q = _controller.text.trim().toLowerCase();
    final rows = <_Row>[];

    final commands = _commands()
        .where((c) => q.isEmpty ? c.primary : c.matches(q))
        .take(8)
        .toList();
    if (commands.isNotEmpty) {
      rows.add(const _SectionRow('Actions'));
      rows.addAll(commands.map(_CommandRow.new));
    }

    final chats = widget.state.chats
        .where((c) => q.isEmpty || c.title.toLowerCase().contains(q))
        .take(6);
    if (chats.isNotEmpty) {
      rows.add(const _SectionRow('Chats'));
      for (final c in chats) {
        rows.add(_JumpRow(
          chatId: c.id,
          title: c.title,
          subtitle: c.preview.isEmpty ? null : c.preview,
          icon: Icons.chat_bubble_outline,
        ));
      }
    }

    // Message search is daemon-side and debounced, so the section appears as
    // soon as the query is long enough and fills in (or reports nothing) once
    // the request lands — never a silent gap.
    if (q.length >= 2) {
      rows.add(_SectionRow('Messages', busy: _searching));
      if (_hits.isEmpty) {
        if (!_searching) rows.add(const _NoteRow('No message matches.'));
      } else {
        for (final h in _hits.take(12)) {
          rows.add(_JumpRow(
            chatId: h.chatId,
            title: h.chatTitle,
            subtitle: h.message.text.replaceAll('\n', ' '),
            icon: Icons.manage_search,
          ));
        }
      }
    }
    return rows;
  }

  /// Indices of the rows the highlight may land on — everything except the
  /// section eyebrows and their notes.
  static List<int> _selectableIndices(List<_Row> rows) => [
        for (var i = 0; i < rows.length; i++)
          if (rows[i] is _CommandRow || rows[i] is _JumpRow) i,
      ];

  // ── Activation ─────────────────────────────────────────────────────────────

  void _activate(_Command command) {
    // Dismiss first: a palette that lingers behind a pushed Settings route or
    // a rename dialog reads as a stuck overlay.
    final host = widget.host;
    Navigator.of(context).pop();
    if (!host.mounted) return;
    unawaited(command.run(host));
  }

  void _open(_JumpRow row) {
    final state = widget.state;
    Navigator.of(context).pop();
    unawaited(state.selectChat(row.chatId));
  }

  void _activateRow(_Row row) {
    if (row is _CommandRow) {
      _activate(row.command);
    } else if (row is _JumpRow) {
      _open(row);
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }

    final down = key == LogicalKeyboardKey.arrowDown;
    if (down || key == LogicalKeyboardKey.arrowUp) {
      final picks = _selectableIndices(_rows());
      if (picks.isEmpty) return KeyEventResult.handled;
      setState(() {
        _cursor = (_cursor.clamp(0, picks.length - 1) +
                (down ? 1 : -1) +
                picks.length) %
            picks.length;
      });
      _revealHighlighted(forward: down);
      return KeyEventResult.handled;
    }

    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      final rows = _rows();
      final picks = _selectableIndices(rows);
      if (picks.isNotEmpty) {
        _activateRow(rows[picks[_cursor.clamp(0, picks.length - 1)]]);
      }
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  /// Keep the highlighted row on screen after an arrow key. Scrolls the
  /// minimum distance in the direction of travel rather than centring, so the
  /// list doesn't lurch on every keypress.
  void _revealHighlighted({required bool forward}) {
    // Read the motion preference now, while we're still inside a normal
    // synchronous callback — the post-frame body only touches the key.
    final instant = reduceMotion(context);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final rowContext = _highlightKey.currentContext;
      if (rowContext == null) {
        // The row is outside ListView.builder's cache extent, so it has no
        // element to scroll to — this is the wrap-around from the last row to
        // the first (or back). Snap to the matching end instead.
        if (_scroll.hasClients) {
          _scroll.jumpTo(forward ? 0.0 : _scroll.position.maxScrollExtent);
        }
        return;
      }
      unawaited(Scrollable.ensureVisible(
        rowContext,
        duration: instant ? Duration.zero : TalonMotion.fast,
        curve: TalonMotion.standard,
        alignmentPolicy: forward
            ? ScrollPositionAlignmentPolicy.keepVisibleAtEnd
            : ScrollPositionAlignmentPolicy.keepVisibleAtStart,
      ));
    });
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final rows = _rows();
    final picks = _selectableIndices(rows);
    // Clamped locally, never written back: the row count changes during build
    // (a search landing, a chat arriving) and setState here would be illegal.
    final highlighted =
        picks.isEmpty ? -1 : picks[_cursor.clamp(0, picks.length - 1)];

    // Clipped rather than relying on each child to round its own corners: the
    // footer carries a top hairline, and a BoxDecoration may not combine a
    // one-sided border with a borderRadius (Border.paint throws on it).
    final panel = DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: TalonRadius.rLg,
        boxShadow: TalonShadows.raised,
      ),
      child: ClipRRect(
        borderRadius: TalonRadius.rLg,
        child: Container(
          decoration: BoxDecoration(
            color: TalonColors.void1,
            borderRadius: TalonRadius.rLg,
            border: Border.all(color: TalonColors.glassStroke),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            // Stretch, so the footer's fill and hairline span the panel
            // instead of hugging their own content.
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _field(),
              Flexible(
                child: rows.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.fromLTRB(TalonSpace.md,
                            TalonSpace.xs, TalonSpace.md, TalonSpace.lg),
                        child: Text('No matches.', style: TalonType.caption),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        shrinkWrap: true,
                        padding: const EdgeInsets.fromLTRB(
                            TalonSpace.sm, 0, TalonSpace.sm, TalonSpace.sm),
                        itemCount: rows.length,
                        itemBuilder: (context, i) =>
                            _rowWidget(rows[i], selected: i == highlighted),
                      ),
              ),
              _footer(),
            ],
          ),
        ),
      ),
    );

    return Dialog(
      backgroundColor: Colors.transparent,
      alignment: const Alignment(0, -0.5),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620, maxHeight: 480),
        child: EntranceFx(
          enabled: !reduceMotion(context),
          from: const Offset(0, -0.03),
          duration: TalonMotion.fast,
          child: panel,
        ),
      ),
    );
  }

  Widget _field() {
    return Padding(
      padding: const EdgeInsets.all(10),
      child: Focus(
        onKeyEvent: _onKey,
        child: TextField(
          controller: _controller,
          autofocus: true,
          onChanged: _onQuery,
          style: const TextStyle(fontSize: 15),
          decoration: InputDecoration(
            prefixIcon: const Icon(Icons.search, size: 19),
            hintText: 'Run an action, jump to a chat, search messages…',
            hintStyle: TextStyle(color: TalonColors.textFaint),
            filled: true,
            fillColor: TalonColors.void0.withValues(alpha: 0.6),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide.none,
            ),
          ),
        ),
      ),
    );
  }

  Widget _rowWidget(_Row row, {required bool selected}) {
    return switch (row) {
      _SectionRow r => _SectionHeader(label: r.label, busy: r.busy),
      _NoteRow r => Padding(
          padding: const EdgeInsets.symmetric(
              horizontal: TalonSpace.sm + 2, vertical: TalonSpace.xs),
          child: Text(r.text, style: TalonType.caption),
        ),
      _CommandRow r => _PaletteRow(
          key: selected ? _highlightKey : null,
          leading: _IconWell(
            icon: r.command.icon,
            tint: r.command.danger ? TalonColors.bad : TalonColors.accent,
            selected: selected,
          ),
          title: r.command.name,
          titleColor: r.command.danger ? TalonColors.bad : null,
          subtitle: r.command.detail,
          // A command with its own chord always advertises it; everything else
          // only earns a cap while it's the row Enter would fire.
          trailing: r.command.chord ?? (selected ? 'enter' : null),
          selected: selected,
          onTap: () => _activate(r.command),
        ),
      _JumpRow r => _PaletteRow(
          key: selected ? _highlightKey : null,
          leading: _IconWell(icon: r.icon, selected: selected),
          title: r.title,
          subtitle: r.subtitle,
          subtitleMarkdown: true,
          trailing: selected ? 'enter' : null,
          selected: selected,
          onTap: () => _open(r),
        ),
    };
  }

  /// The standing keyboard legend — the palette is a keyboard surface first,
  /// and this is where its three bindings are discoverable without opening the
  /// shortcuts dialog.
  Widget _footer() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(height: 1, color: TalonColors.glassStroke),
        Container(
          padding: const EdgeInsets.fromLTRB(
              TalonSpace.md, TalonSpace.sm, TalonSpace.md, TalonSpace.sm),
          color: TalonColors.void0.withValues(alpha: 0.35),
          child: Row(
            children: [
              _hint('↑ ↓', 'Move'),
              const SizedBox(width: TalonSpace.md),
              // Spelled out rather than "↵": U+21B5 is not in the bundled Inter
              // and lands as tofu wherever the platform has no fallback for it
              // (the screenshot gallery renders it as an empty box). "esc" is a
              // word here too, so this is the consistent choice as well.
              _hint('enter', 'Run'),
              const SizedBox(width: TalonSpace.md),
              _hint('esc', 'Close'),
            ],
          ),
        ),
      ],
    );
  }
}

Widget _hint(String keys, String label) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _KeyCap(keys),
        const SizedBox(width: 6),
        Text(label, style: TalonType.caption),
      ],
    );

// ── Command implementations that outlive the palette ─────────────────────────
//
// Top-level rather than methods on the State: they all run *after* the palette
// has popped, so the State is disposed by then and reaching back through
// `widget.state` would be reading a dead element's fields.

Future<void> _push(BuildContext host, WidgetBuilder builder) async {
  await Navigator.of(host).push(MaterialPageRoute<void>(builder: builder));
}

Future<void> _copyMarkdown(
  BuildContext host,
  AppState state,
  ClientChat chat,
) async {
  // Grab the messenger before the clipboard await, so the confirmation never
  // touches a context across an async gap.
  final messenger = ScaffoldMessenger.maybeOf(host);
  await Clipboard.setData(ClipboardData(text: state.exportMarkdown(chat.id)));
  messenger?.showSnackBar(
    const SnackBar(content: Text('Conversation copied as Markdown')),
  );
}

/// Fire a daemon control action and narrate both ends of it — these take a
/// visible moment (a dream run especially), so silence would read as a no-op.
Future<void> _runControl(
  BuildContext host,
  AppState state,
  String action,
  String pending,
) async {
  final messenger = ScaffoldMessenger.maybeOf(host);
  messenger?.showSnackBar(SnackBar(content: Text(pending)));
  final result = await state.daemonControl(action);
  messenger?.showSnackBar(SnackBar(
    content: Text(
      result.message.isEmpty ? (result.ok ? 'Done' : 'Failed') : result.message,
    ),
  ));
}

/// Restart always confirms. Fuzzy matching means a half-typed "res" can put
/// "Restart Talon" under the cursor when the user meant "Reset session", and
/// an unconfirmed Enter there would drop the daemon.
Future<void> _confirmRestart(BuildContext host, AppState state) async {
  final ok = await showDialog<bool>(
    context: host,
    builder: (ctx) => AlertDialog(
      backgroundColor: TalonColors.surface,
      title: const Text('Restart Talon?'),
      content: const Text(
        'The daemon goes offline for a few seconds while it restarts. '
        'This client will reconnect automatically.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(false),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(true),
          child: const Text('Restart'),
        ),
      ],
    ),
  );
  if (ok != true || !host.mounted) return;
  await _runControl(host, state, 'restart', 'Restarting Talon…');
}

Future<void> _setThemeMode(AppState state, ThemeMode mode) async {
  // The notifier is what repaints the app (main.dart listens and re-applies
  // the palette); the pref is only what makes it survive a relaunch.
  TalonTheme.mode.value = mode;
  await state.prefs.setThemeMode(switch (mode) {
    ThemeMode.light => 'light',
    ThemeMode.dark => 'dark',
    ThemeMode.system => 'system',
  });
}

// ── Row chrome ───────────────────────────────────────────────────────────────

class _SectionHeader extends StatelessWidget {
  final String label;
  final bool busy;
  const _SectionHeader({required this.label, required this.busy});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          TalonSpace.sm + 2, TalonSpace.md, TalonSpace.sm, 6),
      child: Row(
        children: [
          Text(label.toUpperCase(), style: TalonType.eyebrow),
          if (busy)
            const Padding(
              padding: EdgeInsets.only(left: TalonSpace.sm),
              child: SizedBox(
                width: 10,
                height: 10,
                child: CircularProgressIndicator(strokeWidth: 1.6),
              ),
            ),
        ],
      ),
    );
  }
}

/// Leading glyph in a rounded well. An accent [tint] marks a command (it *does*
/// something); a tintless well is a navigation target, which keeps the two
/// kinds of row distinguishable at a glance while their columns stay aligned.
/// Mirrors the starter chips in chat_view.dart.
class _IconWell extends StatelessWidget {
  final IconData icon;
  final Color? tint;
  final bool selected;
  const _IconWell({required this.icon, required this.selected, this.tint});

  @override
  Widget build(BuildContext context) {
    final accent = tint;
    final color =
        accent ?? (selected ? TalonColors.accent : TalonColors.textFaint);
    return Container(
      width: 28,
      height: 28,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: accent == null
            ? TalonColors.glassFill
            : accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Icon(icon, size: 15, color: color),
    );
  }
}

/// One selectable row, shared by commands and jump targets so a mixed list
/// still reads as a single column.
class _PaletteRow extends StatelessWidget {
  final Widget leading;
  final String title;
  final Color? titleColor;
  final String? subtitle;

  /// Whether [subtitle] is Markdown from the daemon (chat previews, message
  /// hits) rather than a plain authored string (command detail lines).
  final bool subtitleMarkdown;

  /// Key-cap text on the right, or null for none.
  final String? trailing;
  final bool selected;
  final VoidCallback onTap;

  const _PaletteRow({
    super.key,
    required this.leading,
    required this.title,
    required this.selected,
    required this.onTap,
    this.titleColor,
    this.subtitle,
    this.subtitleMarkdown = false,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        onTap: onTap,
        borderRadius: TalonRadius.rMd,
        child: AnimatedContainer(
          duration: TalonMotion.fast,
          curve: TalonMotion.standard,
          margin: const EdgeInsets.symmetric(vertical: 1),
          padding: const EdgeInsets.symmetric(
              horizontal: TalonSpace.sm, vertical: 7),
          decoration: BoxDecoration(
            borderRadius: TalonRadius.rMd,
            color: selected
                ? TalonColors.accent.withValues(alpha: 0.14)
                : Colors.transparent,
            // Transparent when idle rather than absent, so the 1px stroke doesn't
            // reflow the row as the highlight moves.
            border: Border.all(
              color: selected
                  ? TalonColors.accent.withValues(alpha: 0.35)
                  : Colors.transparent,
            ),
          ),
          child: Row(
            children: [
              leading,
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TalonType.label.copyWith(
                        color: titleColor ?? TalonColors.text,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (subtitle != null)
                      // Chat previews and message hits arrive as raw Markdown, so
                      // they render through the same inline renderer the sidebar
                      // tiles use — otherwise a preview reads `**Sounds good**`
                      // here and "Sounds good" three inches to the left. Command
                      // detail lines are plain author-written strings and take the
                      // cheaper path.
                      subtitleMarkdown
                          ? InlineMarkdownText(
                              data: subtitle!,
                              maxLines: 1,
                              style: TalonType.caption,
                            )
                          : Text(
                              subtitle!,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TalonType.caption,
                            ),
                  ],
                ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: TalonSpace.sm),
                _KeyCap(trailing!),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// A key cap, matching the ones in the shortcuts dialog so the same chord
/// reads the same wherever it appears.
class _KeyCap extends StatelessWidget {
  final String keys;
  const _KeyCap(this.keys);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: TalonColors.surfaceHi,
        borderRadius: TalonRadius.rSm,
        border: Border.all(color: TalonColors.glassStroke),
      ),
      child: Text(
        keys,
        style: TextStyle(
          fontSize: 11,
          height: 1.3,
          fontWeight: FontWeight.w600,
          color: TalonColors.textDim,
        ),
      ),
    );
  }
}
