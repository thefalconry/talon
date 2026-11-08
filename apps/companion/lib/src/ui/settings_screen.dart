import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/bridge_models.dart';
import '../security/app_lock/app_lock_controller.dart';
import '../services/log.dart';
import '../services/secure_window.dart';
import '../services/voice.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'extensions_screen.dart';
import 'glass.dart';
import 'logs_screen.dart';
import 'motion.dart';
import 'app_lock/app_lock_gate.dart';
import 'settings/app_lock_card.dart';
import 'settings/appearance_card.dart';
import 'settings/mesh_audit_section.dart';
import 'settings/mesh_card.dart';
import 'settings/notifications_card.dart';
import 'settings/overview_cards.dart';
import 'settings/screen_privacy_card.dart';
import 'settings/settings_widgets.dart';
import 'settings/updates_card.dart';
import 'settings/voice_card.dart';

/// Talon control panel: live daemon status, the daemon's own settings (synced
/// and editable), connection profile, and a restart action. This is the parity
/// surface — everything Telegram's `/settings` exposes, plus the global config
/// the chat frontends can't touch.
class SettingsScreen extends StatefulWidget {
  final AppState state;
  const SettingsScreen({super.key, required this.state});

  /// Width at which the settings home (rows that push chapter pages) becomes
  /// a chapter rail plus a detail pane. Higher than the app shell's 820 on purpose: that breakpoint only
  /// has to fit a 308px chat list beside a conversation that reads fine at any
  /// width, whereas this route has to fit the rail *and* leave the card column
  /// the ~560 it was tuned for — [_railWidth] 248 + the 24 gutter + 24 of
  /// padding either side = 320 of overhead, so 880 is the first width where
  /// nothing gets squeezed. 900 rounds that up to a real window size.
  static const double _railBreakpoint = 900;

  /// Fixed rail width. Narrower than the sidebar's 308 because these rows are
  /// a glyph, a chapter name and one line of contents rather than an avatar
  /// plus a message preview; 248 still holds those at the 1.3× end of the
  /// text-size slider.
  static const double _railWidth = 248;

  /// Pane width at which a chapter's cards split into two columns. Two columns
  /// of 448 is the narrowest that keeps a card honest — the widest fixed label
  /// gutter inside one is 128px, so below this the second column starts eating
  /// the values. Landing here means a 1240px window is already two-up, which
  /// covers every common laptop size; anything narrower gets one column that
  /// simply fills the pane, so there is no width where the cards sit in a
  /// ribbon with dead space beside them.
  static const double _twoColumnMin = 920;

  /// Cap on a *single* column, for the 900–1240 band. Wider than the phone's
  /// 560 because a lone column should use the pane it has, but not unbounded:
  /// past ~720 a switch row's label and its toggle drift far enough apart to
  /// stop reading as one control.
  static const double _maxCardWidth = 720;

  /// Cap on the rail + pane pair, which then centres in anything wider. Sized
  /// so the widest useful composition — rail plus two 560px card columns —
  /// fits exactly: 248 + 24 gutter + (560 + 24 + 560) + 24 padding either
  /// side. Left uncapped, a maximised 4K window would stretch every switch row
  /// until the label and its toggle were a hand-span apart.
  static const double _maxContentWidth =
      _railWidth + TalonSpace.xl + 2 * 560 + TalonSpace.xl + 2 * TalonSpace.xl;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  ConfigSnapshot? _cfg;
  bool _loading = true;
  String? _error;
  bool _restarting = false;
  bool _dreaming = false;

  /// Optimistic overrides for in-flight `_apply` config updates, keyed by
  /// config field. A toggle flips the moment it's tapped; the entry is
  /// dropped when the daemon confirms (snapshot replaces it) or reverted
  /// with a toast if the round-trip fails. Without this the Switch only
  /// moved after the HTTP call — up to the 12s client timeout of nothing.
  final Map<String, Object?> _pending = {};

  final _name = TextEditingController();
  final _tz = TextEditingController();

  /// Which chapter the wide layout is showing, keyed by title. Titles are
  /// unique and are what the rail draws, so there is no parallel id to keep in
  /// sync; a title that no longer exists (Agent, before the config lands) falls
  /// back to the first available chapter at build time rather than through a
  /// setState.
  String _selectedSection = 'Connection';

  /// The installed app lock, read (and subscribed to) in [build].
  AppLockController? _lock;

  /// Bumped on every [setState], so a pushed chapter page — its own route,
  /// outside this widget's rebuilds — repaints with this screen.
  final ValueNotifier<int> _tick = ValueNotifier(0);

  @override
  void setState(VoidCallback fn) {
    super.setState(fn);
    _tick.value++;
  }

  @override
  void initState() {
    super.initState();
    // Rebuild on AppState changes: the mesh toggles / device list live in
    // AppState + prefs, and mutate via notifyListeners — without this
    // subscription the switches only repainted on a manual refresh.
    widget.state.addListener(_onAppState);
    _load();
  }

  @override
  void dispose() {
    widget.state.removeListener(_onAppState);
    _tick.dispose();
    _name.dispose();
    _tz.dispose();
    super.dispose();
  }

  void _onAppState() {
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    // Device and foreground-service health are useful, but neither is needed
    // to paint Settings. Refresh them alongside the config request instead of
    // serialising all three and holding the whole screen behind the result.
    unawaited(_refreshMeshStatus());
    try {
      final c = await widget.state.loadConfig();
      if (!mounted) return;
      setState(() {
        _cfg = c;
        _loading = false;
        if (c != null) {
          _name.text = c.botDisplayName;
          _tz.text = c.timezone;
        }
      });
    } catch (e) {
      AppLog.error('settings', 'config load failed', e);
      if (mounted) {
        setState(() {
          _loading = false;
          _error = e.toString();
        });
      }
    }
  }

  Future<void> _refreshMeshStatus() async {
    try {
      await Future.wait([
        widget.state.refreshMeshDevices(),
        widget.state.refreshMeshBackgroundHealth(),
      ]);
    } catch (e) {
      // Mesh status is auxiliary to this screen. Keep the last known state if
      // the platform query fails; the config UI must remain usable.
      AppLog.warn('settings', 'mesh status refresh failed', e);
    }
  }

  Future<void> _apply(Map<String, dynamic> update) async {
    // Optimistic: reflect the change immediately, then reconcile with the
    // daemon's confirmed snapshot (or revert + toast on failure).
    setState(() => _pending.addAll(update));
    final c = await widget.state.updateConfig(update);
    if (!mounted) return;
    setState(() {
      update.keys.forEach(_pending.remove);
      if (c != null) _cfg = c;
    });
    if (c == null) {
      _toast('Update failed — check the connection and try again');
    }
  }

  /// Read a config value with any in-flight optimistic override applied.
  T _eff<T>(String key, T base) {
    final v = _pending[key];
    return v is T ? v : base;
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _runControl(String action) async {
    final result = await widget.state.daemonControl(action);
    _toast(
      result.message.isEmpty ? (result.ok ? 'Done' : 'Failed') : result.message,
    );
  }

  Future<void> _confirmRestart() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: TalonColors.surface,
        title: const Text('Restart Talon?'),
        content: const Text(
          'The daemon goes offline for a few seconds while it restarts. '
          'This client will reconnect automatically.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(true),
            child: const Text('Restart'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _restarting = true);
    await _runControl('restart');
    if (mounted) setState(() => _restarting = false);
  }

  Future<void> _triggerDream() async {
    setState(() => _dreaming = true);
    await _runControl('dream');
    if (mounted) setState(() => _dreaming = false);
  }

  /// Plugins + Skills sub-menus. Gated on the daemon's `plugins-skills`
  /// bridge capability — an older daemon simply doesn't show the card.
  Widget _extensionsCard() {
    return SettingsSection(
      title: 'Extensions',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ControlButton(
            icon: Icons.extension_outlined,
            label: 'Plugins',
            subtitle:
                'Built-ins, module plugins, and MCP servers — view & toggle',
            pending: false,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => PluginsScreen(state: widget.state),
              ),
            ),
          ),
          const Divider(height: 12),
          ControlButton(
            icon: Icons.menu_book_outlined,
            label: 'Skills',
            subtitle: 'SKILL.md workflow bundles — view & toggle',
            pending: false,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => SkillsScreen(state: widget.state),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Daemon tools that are safe to run any time.
  Widget _toolsCard() {
    return SettingsSection(
      title: 'Tools',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ControlButton(
            icon: Icons.receipt_long_outlined,
            label: 'View logs',
            subtitle: 'Live daemon log — filter by severity or subsystem',
            pending: false,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => LogsScreen(state: widget.state),
              ),
            ),
          ),
          const Divider(height: 12),
          ControlButton(
            icon: Icons.auto_awesome_outlined,
            label: 'Run dream now',
            subtitle: 'Consolidate memory + write the diary immediately',
            pending: _dreaming,
            onTap: _dreaming ? null : _triggerDream,
          ),
        ],
      ),
    );
  }

  /// Disruptive actions, last on the page and in red.
  Widget _dangerCard() {
    return SettingsSection(
      title: 'Danger zone',
      child: ControlButton(
        icon: Icons.restart_alt,
        label: 'Restart Talon',
        subtitle: 'Bounce the daemon — applies pending config changes. '
            'Every client drops for a few seconds.',
        pending: _restarting,
        onTap: _restarting ? null : _confirmRestart,
        destructive: true,
      ),
    );
  }

  /// Command audit: what the connected Talon ran on this device. Local, so it
  /// shows with or without a daemon config.
  Widget _auditCard() => const SettingsSection(
        title: 'Mesh audit',
        child: MeshAuditSection(),
      );

  @override
  Widget build(BuildContext context) {
    // Subscribes this screen to lock changes, so the Security summary on the
    // home follows the passcode and screenshot switches.
    _lock = AppLockScope.maybeOf(context);
    // This screen is a pushed route, outside the root's theme rebuild chain —
    // subscribe to palette changes so toggling Appearance repaints in place.
    return ValueListenableBuilder<int>(
      valueListenable: TalonTheme.revision,
      builder: (context, _, __) => TalonBackdrop(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            title: const Text('Talon settings'),
            actions: [
              IconButton(
                onPressed: _loading ? null : _load,
                icon: _loading
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh),
                tooltip: 'Refresh',
              ),
            ],
          ),
          // Two forms of the same chapters. A phone gets a settings home —
          // one row per chapter with a summary of its current value — that
          // pushes each chapter as its own page; a desktop window gets the
          // rail and an independently scrolling pane.
          body: LayoutBuilder(
            builder: (context, constraints) =>
                constraints.maxWidth >= SettingsScreen._railBreakpoint
                    ? _masterDetail()
                    : _home(),
          ),
        ),
      ),
    );
  }

  /// The chapters, in order, for both layouts:
  ///
  ///   Connection · Agent │ Mesh & device control · Security · Notifications
  ///   │ Appearance · Voice │ Updates · Advanced
  ///
  /// What you check first (am I connected, to what) leads; what you change
  /// once (theme) sits in the middle; what you only need when something is
  /// wrong (diagnostics, logs) and what can hurt (restart) come last. Each
  /// [SettingsChapter.subtitle] is a one-line summary of the chapter's
  /// current value, recomputed on every build.
  ///
  /// Each chapter declares its cards as columns rather than a flat list, so the
  /// desktop pane's two-up split is authored where the content is known.
  /// Flattened in order they give the phone page's running order.
  ///
  /// Agent and Mesh need a config snapshot; Security needs an installed app
  /// lock; Notifications and Voice need a platform that has them. Until the
  /// snapshot arrives, Connection carries the skeleton or the failure copy
  /// under the status card.
  List<SettingsChapter> _sections(ConfigSnapshot? cfg) {
    final lock = _lock;
    final s = widget.state;
    final prefs = s.prefs;
    final updates = s.updates;
    final c = s.config;
    final where = c.isLoopback ? 'this computer' : c.host;
    final connected = s.conn == ConnState.connected;
    final themeLabel = switch (TalonTheme.mode.value) {
      ThemeMode.system => 'Auto',
      ThemeMode.light => 'Light',
      ThemeMode.dark => 'Dark',
    };
    final textPct = (TalonTheme.textScale.value * 100).round();
    return [
      SettingsChapter(
        title: 'Connection',
        subtitle: '${connected ? 'Connected' : 'Disconnected'} · $where',
        icon: Icons.monitor_heart_outlined,
        columns: () => [
          [
            StatusCard(state: widget.state, cfg: cfg),
            if (cfg == null && _loading)
              const SettingsSkeleton()
            else if (cfg == null)
              _unavailableCard(),
          ],
          [ConnectionCard(state: widget.state)],
        ],
      ),
      if (cfg != null) _agentSection(cfg),
      if (cfg != null)
        SettingsChapter(
          title: 'Mesh & device control',
          subtitle: !prefs.meshSharing
              ? 'Off'
              : 'Location on · control '
                  '${prefs.meshDeviceControl ? 'on' : 'off'}',
          icon: Icons.hub_outlined,
          group: 1,
          columns: () => [
            [MeshCard(state: widget.state)],
          ],
        ),
      if (lock != null)
        SettingsChapter(
          title: 'Security',
          subtitle: [
            lock.enabled ? 'Passcode on' : 'No passcode',
            if (SecureWindow.supported)
              lock.blockScreenshots
                  ? 'screenshots blocked'
                  : 'screenshots allowed',
          ].join(' · '),
          icon: Icons.shield_outlined,
          group: 1,
          columns: () => [
            [AppLockCard(controller: lock)],
            [ScreenPrivacyCard(controller: lock)],
          ],
        ),
      if (NotificationsCard.supported)
        SettingsChapter(
          title: 'Notifications',
          subtitle: prefs.messageNotifications
              ? 'Message notifications on'
              : 'Off',
          icon: Icons.notifications_none_outlined,
          group: 1,
          columns: () => [
            [NotificationsCard(state: widget.state)],
          ],
        ),
      SettingsChapter(
        title: 'Appearance',
        subtitle: '$themeLabel theme · text $textPct%',
        icon: Icons.palette_outlined,
        group: 2,
        columns: () => [
          [AppearanceCard(state: widget.state)],
        ],
      ),
      if (VoiceService.supported)
        SettingsChapter(
          title: 'Voice',
          subtitle: '${prefs.voiceName == null ? 'System voice' : 'Custom voice'}'
              ' · hands-free ${prefs.voiceHandsFree ? 'on' : 'off'}',
          icon: Icons.graphic_eq,
          group: 2,
          columns: () => [
            [VoiceCard(state: widget.state)],
          ],
        ),
      SettingsChapter(
        title: 'Updates',
        subtitle: updates.updateAvailable && updates.release != null
            ? 'v${updates.release!.version} is available'
            : [
                if (updates.currentVersion != null)
                  'v${updates.currentVersion}',
                updates.autoCheck ? 'checks automatically' : 'auto-check off',
              ].join(' · ').capitalized,
        icon: Icons.system_update_alt,
        group: 3,
        columns: () => [
          [UpdatesCard(state: widget.state)],
        ],
      ),
      SettingsChapter(
        title: 'Advanced',
        subtitle: 'Diagnostics, logs & audit',
        versionFooter: true,
        icon: Icons.tune_outlined,
        group: 3,
        columns: () => [
          [
            DiagnosticsCard(state: widget.state, cfg: cfg),
            if (cfg != null) _toolsCard(),
            _auditCard(),
          ],
          [
            const HelpCard(),
            AboutCard(state: widget.state, cfg: cfg),
            if (cfg != null) _dangerCard(),
          ],
        ],
      ),
    ];
  }

  /// The daemon's own chapter. Split out so [cfg] arrives here already
  /// non-null: the alternative is card closures that lean on a nullable local
  /// staying promoted across a closure boundary, which is a needlessly subtle
  /// thing to depend on.
  SettingsChapter _agentSection(ConfigSnapshot cfg) {
    final background = [
      if (_eff('pulse', cfg.pulse)) 'pulse',
      if (_eff('heartbeat', cfg.heartbeat)) 'heartbeat',
      if (_eff('dream', cfg.dream)) 'dream',
    ];
    final model = cfg.modelDisplay.isEmpty ? cfg.model : cfg.modelDisplay;
    return SettingsChapter(
      title: 'Agent',
      subtitle: '$model · '
          '${background.isEmpty ? 'background agents off' : '${background.join(', ')} on'}',
      icon: Icons.auto_awesome_outlined,
      columns: () => [
        [_generalCard(cfg), _backgroundAgentsCard(cfg)],
        [
          if (widget.state.status.hasCapability('plugins-skills'))
            _extensionsCard(),
        ],
      ],
    );
  }

  /// The chapter currently named [title], rebuilt from live state — what a
  /// pushed chapter page paints on every tick. Null once it has gone (a
  /// failed refresh retires Agent and Mesh).
  SettingsChapter? _chapterNamed(String title) {
    if (!mounted) return null;
    final cfg = _cfg ?? widget.state.appConfig;
    for (final section in _sections(cfg)) {
      if (section.title == title) return section;
    }
    return null;
  }

  void _openChapter(String title) {
    final lock = _lock;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _ChapterPage(
          title: title,
          state: widget.state,
          listenable: Listenable.merge([
            _tick,
            widget.state,
            widget.state.updates,
            if (lock != null) lock,
          ]),
          resolve: () => _chapterNamed(title),
        ),
      ),
    );
  }

  /// The phone's settings home: the chapters as grouped rows, each with a
  /// one-line summary of its current value, then the version footer.
  Widget _home() {
    final cfg = _cfg ?? widget.state.appConfig;
    return ListenableBuilder(
      // Update checks land outside AppState; keep the Updates summary live.
      listenable: widget.state.updates,
      builder: (context, _) {
        final groups = <List<SettingsChapter>>[];
        int? last;
        for (final section in _sections(cfg)) {
          if (section.group != last) groups.add([]);
          groups.last.add(section);
          last = section.group;
        }
        return Align(
          alignment: Alignment.topCenter,
          child: SingleChildScrollView(
            // Bottom inset: this screen runs under the navigation bar like
            // every other phone surface.
            padding: EdgeInsets.fromLTRB(
                16, 12, 16, 20 + navInset(context)),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final (i, group) in groups.indexed) ...[
                    if (i > 0) const SizedBox(height: TalonSpace.lg),
                    SettingsNavGroup(
                      rows: [
                        for (final section in group)
                          SettingsNavRow(
                            key: ValueKey('settings-row-${section.title}'),
                            icon: section.icon,
                            title: section.title,
                            summary: section.subtitle,
                            onTap: () => _openChapter(section.title),
                          ),
                      ],
                    ),
                  ],
                  const SizedBox(height: TalonSpace.sm),
                  VersionFooter(state: widget.state),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _masterDetail() {
    // Same cached-snapshot fallback as the home: the local cards have to
    // paint on the first frame, before the config fetch resolves.
    final cfg = _cfg ?? widget.state.appConfig;
    return ListenableBuilder(
      listenable: widget.state.updates,
      builder: (context, _) {
        final sections = _sections(cfg);
        // Fall back to the first chapter when the remembered title has gone —
        // a failed refresh can retire the whole Agent chapter under you.
        final selected = sections.firstWhere(
          (s) => s.title == _selectedSection,
          orElse: () => sections.first,
        );
        return Align(
          // Top-aligned, not centred: a settings page starts at the top.
          // Centring is horizontal only, for the case where the window is
          // wider than the widest composition this screen has any use for.
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
                maxWidth: SettingsScreen._maxContentWidth),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                  TalonSpace.xl, TalonSpace.sm, TalonSpace.xl, TalonSpace.xl),
              child: Row(
                // start, not stretch: both columns end where their content
                // does instead of the rail trailing empty glass.
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: SettingsScreen._railWidth,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(child: _rail(sections, selected.title)),
                        VersionFooter(state: widget.state),
                      ],
                    ),
                  ),
                  const SizedBox(width: TalonSpace.xl),
                  Expanded(child: _detailPane(selected)),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  /// The chapter rail: a compact glass panel echoing the chat sidebar's, the
  /// same chapters and groups as the phone home.
  ///
  /// The list is [Flexible] around a shrink-wrapping [ListView] rather than
  /// [Expanded]: that way the panel is exactly as tall as its chapters, but a
  /// short window (or a 1.3× text scale) still scrolls instead of overflowing.
  Widget _rail(List<SettingsChapter> sections, String selectedTitle) {
    final still = reduceMotion(context);
    return Glass(
      radius: TalonRadius.lg,
      blur: 24,
      padding: const EdgeInsets.fromLTRB(
          TalonSpace.sm, TalonSpace.md, TalonSpace.sm, TalonSpace.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.only(
                left: TalonSpace.sm, bottom: TalonSpace.sm),
            child: Text('SETTINGS', style: TalonType.eyebrow),
          ),
          Flexible(
            child: ListView(
              padding: EdgeInsets.zero,
              shrinkWrap: true,
              children: [
                for (final (i, section) in sections.indexed) ...[
                  // A hairline between the home's groups.
                  if (i > 0 && section.group != sections[i - 1].group)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: TalonSpace.sm, vertical: TalonSpace.xs),
                      child: Divider(
                        height: 1,
                        thickness: 1,
                        color: TalonColors.glassStroke,
                      ),
                    ),
                  // Keyed by title so the entrance plays once per tile and the
                  // frequent AppState-driven rebuilds of this screen never
                  // restart the cascade mid-flight.
                  EntranceFx(
                    key: ValueKey('rail-${section.title}'),
                    enabled: !still,
                    from: const Offset(-0.1, 0),
                    delay: TalonMotion.stagger * i.clamp(0, 8),
                    child: RailTile(
                      title: section.title,
                      subtitle: section.subtitle,
                      icon: section.icon,
                      selected: section.title == selectedTitle,
                      onTap: () => setState(
                        () => _selectedSection = section.title,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// The selected chapter's cards, scrolling independently of the rail so a
  /// long chapter can't push the rail off screen.
  ///
  /// Two columns once the pane can afford them, one otherwise — and the
  /// one-column form flattens the chapter's columns in order, so it reads as
  /// the same running order as the phone page. Empty columns are dropped
  /// first, so a missing card never reserves half the pane for nothing.
  Widget _detailPane(SettingsChapter section) {
    final columns = [
      for (final column in section.columns())
        if (column.isNotEmpty) column,
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final twoUp = columns.length > 1 &&
            constraints.maxWidth >= SettingsScreen._twoColumnMin;
        return SingleChildScrollView(
          // Keyed by chapter: a fresh Scrollable starts at the top instead of
          // inheriting the previous chapter's offset, and remounting the
          // subtree is also what re-plays the pane entrance below.
          key: ValueKey('settings-pane-${section.title}'),
          padding: EdgeInsets.only(bottom: TalonSpace.xl + navInset(context)),
          child: EntranceFx(
            enabled: !reduceMotion(context),
            // A whisper from the right — enough to read as a pane swap, not
            // enough to feel like the whole screen moved.
            from: const Offset(0.015, 0),
            child: twoUp
                ? Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final (i, column) in columns.indexed) ...[
                        if (i > 0) const SizedBox(width: TalonSpace.xl),
                        Expanded(child: settingsCardStack(column)),
                      ],
                    ],
                  )
                // Align first: the pane hands down a *tight* width, and a bare
                // ConstrainedBox can't shrink below an incoming tight minimum —
                // it would silently ignore the cap. Align loosens it and keeps
                // the column against the rail rather than adrift mid-pane.
                : Align(
                    alignment: Alignment.topLeft,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                          maxWidth: SettingsScreen._maxCardWidth),
                      child: settingsCardStack(
                        [for (final column in columns) ...column],
                      ),
                    ),
                  ),
          ),
        );
      },
    );
  }

  /// Shown in place of the daemon-backed cards when the config fetch failed.
  /// Carries whatever [AppLog.diagnose] can infer from the error plus a
  /// one-tap dump, because "Settings unavailable" on its own tells a user
  /// filing a bug nothing at all.
  Widget _unavailableCard() {
    return SettingsSection(
      title: 'Settings unavailable',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            _error ?? 'Could not read settings from the daemon.',
            style: TextStyle(color: TalonColors.textFaint),
          ),
          if (_error != null && AppLog.diagnose(_error!) != null) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: TalonColors.accent.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.lightbulb_outline,
                    size: 16,
                    color: TalonColors.accent,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      AppLog.diagnose(_error!)!,
                      style: TextStyle(
                        fontSize: 12.5,
                        color: TalonColors.textDim,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () async {
                final dump =
                    '${_error ?? ''}\n\n--- recent log ---\n${AppLog.dump()}';
                await Clipboard.setData(ClipboardData(text: dump));
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Diagnostics copied to clipboard'),
                    ),
                  );
                }
              },
              icon: const Icon(Icons.copy_all_outlined, size: 16),
              label: const Text('Copy diagnostics'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _generalCard(ConfigSnapshot cfg) {
    return SettingsSection(
      title: 'General',
      child: Column(
        children: [
          ModelRow(
            state: widget.state,
            cfg: cfg,
            onPick: (id) => _apply({'model': id}),
          ),
          const SizedBox(height: 14),
          settingsTextRow(
            'Display name',
            _name,
            onSubmit: (v) => _apply({'botDisplayName': v}),
          ),
          const SizedBox(height: 14),
          settingsTextRow(
            'Timezone',
            _tz,
            hint: 'e.g. Europe/London',
            onSubmit: (v) => _apply({'timezone': v}),
          ),
        ],
      ),
    );
  }

  Widget _backgroundAgentsCard(ConfigSnapshot cfg) {
    return SettingsSection(
      title: 'Background agents',
      child: Column(
        children: [
          settingsSwitchRow(
            'Pulse',
            'Proactive check-ins when something matters',
            _eff('pulse', cfg.pulse),
            (v) => _apply({'pulse': v}),
          ),
          if (_eff('pulse', cfg.pulse))
            settingsIntervalRow(
              'Pulse interval',
              '${(_eff('pulseIntervalMs', cfg.pulseIntervalMs) / 60000).round()} min',
              (_eff('pulseIntervalMs', cfg.pulseIntervalMs) / 60000).round(),
              min: 1,
              onChange: (m) => _apply({'pulseIntervalMs': m * 60000}),
            ),
          const Divider(height: 22),
          settingsSwitchRow(
            'Heartbeat',
            'Periodic goal advancement',
            _eff('heartbeat', cfg.heartbeat),
            (v) => _apply({'heartbeat': v}),
          ),
          if (_eff('heartbeat', cfg.heartbeat))
            settingsIntervalRow(
              'Heartbeat interval',
              '${_eff('heartbeatIntervalMinutes', cfg.heartbeatIntervalMinutes)} min',
              _eff(
                'heartbeatIntervalMinutes',
                cfg.heartbeatIntervalMinutes,
              ),
              min: 5,
              onChange: (m) => _apply({'heartbeatIntervalMinutes': m}),
            ),
          const Divider(height: 22),
          settingsSwitchRow(
            'Dream',
            'Memory consolidation + diary',
            _eff('dream', cfg.dream),
            (v) => _apply({'dream': v}),
          ),
        ],
      ),
    );
  }
}

/// A chapter's cards stacked with the section gap.
Widget settingsCardStack(List<Widget> cards) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, card) in cards.indexed) ...[
          if (i > 0) const SizedBox(height: TalonSpace.lg),
          card,
        ],
      ],
    );

/// One chapter as its own phone page, pushed from the settings home.
///
/// The cards are built by the settings screen's state (which owns the config
/// snapshot, the optimistic updates and the text controllers), so the page
/// re-resolves its chapter from [resolve] whenever [listenable] ticks —
/// that screen's setState, AppState, updates and the lock — rather than
/// holding a stale copy.
class _ChapterPage extends StatelessWidget {
  final String title;
  final AppState state;
  final Listenable listenable;
  final SettingsChapter? Function() resolve;

  const _ChapterPage({
    required this.title,
    required this.state,
    required this.listenable,
    required this.resolve,
  });

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: TalonTheme.revision,
      builder: (context, _, __) => TalonBackdrop(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            title: Text(title),
          ),
          body: ListenableBuilder(
            listenable: listenable,
            builder: (context, _) {
              final chapter = resolve();
              if (chapter == null) {
                return Center(
                  child: Padding(
                    padding: const EdgeInsets.all(TalonSpace.xl),
                    child: Text(
                      'This section isn’t available right now — '
                      'check the connection and refresh Settings.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: TalonColors.textDim),
                    ),
                  ),
                );
              }
              return Align(
                alignment: Alignment.topCenter,
                child: SingleChildScrollView(
                  key: ValueKey('settings-page-$title'),
                  padding: EdgeInsets.fromLTRB(
                      16, 8, 16, 20 + navInset(context)),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 560),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        settingsCardStack(
                          [for (final column in chapter.columns()) ...column],
                        ),
                        if (chapter.versionFooter) ...[
                          const SizedBox(height: TalonSpace.sm),
                          VersionFooter(state: state),
                        ],
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

extension on String {
  /// Summaries are joined from lower-case parts; the row starts upper-case.
  String get capitalized =>
      isEmpty ? this : '${this[0].toUpperCase()}${substring(1)}';
}
