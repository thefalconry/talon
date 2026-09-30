import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart'
    show
        ChangeNotifier,
        defaultTargetPlatform,
        TargetPlatform,
        visibleForTesting;

import '../models/bridge_models.dart';
import '../models/connection.dart';
import '../services/bridge_client.dart';
import '../services/bridge_trust.dart';
import '../services/daemon_supervisor.dart';
import '../services/endpoint.dart';
import '../services/local_discovery.dart';
import '../services/log.dart';
import '../services/menu_bar.dart';
import '../services/mesh_background.dart';
import '../services/mesh_liveness.dart';
import '../services/mesh_service.dart';
import '../services/prefs.dart';
import '../services/updater.dart';
import 'frame_coalescer.dart';

enum ConnState { idle, connecting, connected, error }

/// Transient per-turn state: the streaming draft, the model's reasoning, and
/// any live tool calls. Cleared when the turn ends.
///
/// Also a [Listenable] of its own: streamed tokens (`delta`, `reasoning`)
/// update the turn and notify only *its* listeners — the live bubble and the
/// chat's follow-the-bottom scroller — at most once per frame, instead of
/// rebuilding the whole app per token through [AppState] (#1059).
class TurnState extends ChangeNotifier {
  late final FrameCoalescer _frame = FrameCoalescer(notifyListeners);

  /// Signal that streamed content changed. Coalesced to one notification per
  /// frame.
  void changed() => _frame.request();

  // The draft is kept as a settled string plus a buffer of chunks that
  // arrived since it was last read, so appending a token doesn't copy the
  // whole reply (O(n²) over a long answer); the join happens at most once per
  // read — i.e. once per frame.
  String _draft = '';
  final StringBuffer _incoming = StringBuffer();

  String get draft {
    if (_incoming.isNotEmpty) {
      _draft = '$_draft$_incoming';
      _incoming.clear();
    }
    return _draft;
  }

  set draft(String value) {
    _incoming.clear();
    _draft = value;
  }

  /// Append a streamed chunk without materialising the draft.
  void appendDraft(String chunk) => _incoming.write(chunk);

  /// Whether any reply text has arrived, without joining the buffer.
  bool get hasDraft => _draft.isNotEmpty || _incoming.isNotEmpty;

  final List<String> reasoning = [];
  final List<ToolActivity> tools = [];
  bool active = false;
  bool typing = false;

  /// True when the model delivered a message mid-turn but hasn't ended the
  /// turn — i.e. it's still working and more is likely coming. Set on a short
  /// grace delay after a delivered assistant message (so a normal single-reply
  /// turn, where `turn_end` lands right after, never flashes it), cleared the
  /// moment fresh content streams or the turn actually ends. Drives the quiet
  /// "still working" indicator under the delivered bubble.
  bool continuing = false;

  void reset() {
    draft = '';
    reasoning.clear();
    tools.clear();
    active = true;
    typing = true;
    continuing = false;
  }
}

/// Single source of truth for the UI. Owns the bridge client, the daemon
/// supervisor (desktop), the chat/message stores, and reconnection.
class AppState extends ChangeNotifier {
  final Prefs prefs;
  ConnectionConfig config;

  AppState(this.prefs, {bool? narrowLayout})
      : _narrowLayout = narrowLayout ?? _defaultNarrow,
        config = prefs.connection {
    _hydrateFromSnapshot();
  }

  /// Phones start in the single-pane layout: the chat list comes first and
  /// nothing is auto-selected on their behalf. Desktop keeps the two-pane
  /// behavior where a conversation is always in view.
  static bool get _defaultNarrow =>
      defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;

  /// Whether the app is currently laid out as a single pane (phone / skinny
  /// window). Kept in sync by AppShell's LayoutBuilder. In narrow layout the
  /// chat list is a real screen of its own, so we never auto-select a chat —
  /// selection is a navigation act that only the user performs.
  bool _narrowLayout;
  bool get narrowLayout => _narrowLayout;

  /// Called from AppShell whenever the layout breakpoint flips. Growing into
  /// the wide two-pane layout with nothing selected picks the most recent chat
  /// (an empty conversation pane is dead weight on desktop); shrinking to
  /// narrow leaves selection untouched — whatever was open stays open.
  void setNarrowLayout(bool narrow) {
    if (_narrowLayout == narrow) return;
    _narrowLayout = narrow;
    if (!narrow && selectedChatId == null && chats.isNotEmpty) {
      selectedChatId = chats.first.id;
      final id = selectedChatId!;
      // Defer: this runs from build (LayoutBuilder), where notifying is illegal.
      scheduleMicrotask(() {
        if (_disposed || selectedChatId != id) return;
        markRead(id);
        notifyListeners();
        if (!_loadedHistory.contains(id)) unawaited(_loadHistory(id));
      });
    }
  }

  BridgeClient? _client;
  DaemonSupervisor? _supervisor;
  StreamSubscription<Map<String, dynamic>>? _sub;
  MeshService? _mesh;
  Timer? _reconnect;
  int _backoffMs = 800;
  bool _disposed = false;

  /// Network changes, watched while the profile has a local address so the
  /// app hops between it and the main address as the phone moves.
  StreamSubscription<List<ConnectivityResult>>? _networkWatch;
  Timer? _networkDebounce;

  /// Per-chat grace timers that promote a delivered-but-not-ended turn into the
  /// "still working" state. Keyed by chatId; cancelled on `turn_end`, fresh
  /// content, or a newer delivery.
  final Map<String, Timer> _continuingTimers = {};

  /// How long after a mid-turn assistant message we wait before showing the
  /// "still working" indicator. Long enough that a normal single-reply turn
  /// (whose `turn_end` lands right behind the message) never flashes it.
  static const Duration _continuingGrace = Duration(milliseconds: 600);

  /// Monotonic connection-attempt counter. Each [start] bumps it; awaited
  /// continuations from an older attempt compare against it and bail instead
  /// of disposing the newer attempt's client or stomping its state (e.g. the
  /// user taps Reconnect while a backoff-timer attempt is mid-flight).
  int _epoch = 0;

  /// The connection actually in use. In local auto-discover mode this carries
  /// the discovered port/token, which the saved [config] doesn't — anything
  /// that builds URLs (media, diagnostics) must use this, not [config].
  ConnectionConfig? _activeConfig;
  ConnectionConfig get activeConfig => _activeConfig ?? config;

  // Connection
  ConnState conn = ConnState.idle;
  String? connError;
  DaemonState daemon = const DaemonState(DaemonPhase.unknown);
  BridgeStatus status = BridgeStatus.empty;

  // Data
  final List<ClientChat> chats = [];
  String? selectedChatId;
  final Map<String, List<ClientMessage>> _messages = {};
  final Map<String, TurnState> _turns = {};
  final Set<String> _loadedHistory = {};

  // History pagination: chats whose scrollback is fully loaded, and chats
  // with an older-page fetch in flight.
  static const int _historyPageSize = 100;
  static const int _historyInitialSize = 200;
  final Set<String> _historyExhausted = {};
  final Set<String> _loadingOlder = {};
  final Set<String> _loadingHistory = {};

  // Offline snapshot: debounce handle for persisted cold-start state.
  Timer? _snapshotTimer;

  bool isLoadingOlder(String chatId) => _loadingOlder.contains(chatId);
  bool hasMoreHistory(String chatId) => !_historyExhausted.contains(chatId);

  /// True while a chat's first history page is being fetched (skeleton UI).
  bool isHistoryLoading(String chatId) => _loadingHistory.contains(chatId);

  // Models
  List<ModelOption> models = [];

  // Daemon settings (synced from the bridge)
  ConfigSnapshot? appConfig;
  List<DeviceInfo> meshDevices = [];
  List<DeviceLocation> meshLocations = [];
  MeshForegroundHealth meshBackgroundHealth = evaluateMeshForegroundHealth(
    supported: MeshForegroundController.isSupported ||
        MeshForegroundController.isResidentDesktop,
    sharingEnabled: false,
    serviceRunning: false,
    nowMs: DateTime.now().millisecondsSinceEpoch,
    aliveAtMs: null,
    startedAtMs: null,
  );

  UpdateService? _updates;

  /// The self-updater. Created on first use (a widget test that never opens
  /// Settings shouldn't spin up an HTTP client), and owned here so its
  /// six-hourly timer lives exactly as long as the app does.
  UpdateService get updates => _updates ??= UpdateService(prefs: prefs);

  List<ClientMessage> messagesFor(String chatId) =>
      _messages[chatId] ?? const [];
  TurnState turnFor(String chatId) => _turns.putIfAbsent(chatId, TurnState.new);
  ClientChat? get selectedChat {
    for (final c in chats) {
      if (c.id == selectedChatId) return c;
    }
    return null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /// Connect using the current [config]: local desktop mode discovers Talon's
  /// bridge file first; legacy managed mode can still supervise a daemon when
  /// explicitly configured; everywhere, open the event stream and load chats.
  Future<void> start() async {
    // Paused in the background (Android, foreground service owns the
    // connection): nothing — network changes, timers — may reopen the UI
    // stream until resumeUiStream() clears the flag and calls start().
    if (_uiStreamPaused) return;
    _reconnect?.cancel();
    final epoch = ++_epoch;
    AppLog.info('app_state', 'connect attempt ${config.host}:${config.port}');
    _setConn(ConnState.connecting, null);

    if (config.canAutoDiscoverLocal) {
      daemon = const DaemonState(DaemonPhase.unknown);
      final bridge = await readLocalBridge();
      if (epoch != _epoch) return; // superseded by a newer attempt
      if (bridge == null) {
        _setConn(
          ConnState.error,
          "Talon isn't running on this computer — start Talon and it'll connect automatically.",
        );
        _scheduleReconnect();
        return;
      }
      final discoveredPin =
          ConnectionConfig.normalizeFingerprint(bridge.fingerprint);
      final effective = config.copyWith(
        host: '127.0.0.1',
        port: bridge.port,
        token: bridge.token,
        clearToken: bridge.token == null,
        tls: bridge.scheme == 'https',
        // The discovery file carries the daemon's own fingerprint, so local
        // mode pins without a first-use adoption; a plain-HTTP bridge clears
        // any pin left over from an earlier profile.
        fingerprint: discoveredPin,
        clearFingerprint: bridge.scheme != 'https' || discoveredPin == null,
        manageLocalDaemon: false,
      );
      AppLog.info(
        'app_state',
        'local discovery ${effective.host}:${effective.port}',
      );
      await _openStream(effective, epoch);
    } else if (config.canManageDaemon) {
      _supervisor = DaemonSupervisor(config);
      final ok = await _supervisor!.ensureRunning((d) {
        if (epoch != _epoch) return;
        daemon = d;
        notifyListeners();
      });
      if (epoch != _epoch) return;
      if (!ok) {
        _setConn(
          ConnState.error,
          daemon.detail ?? 'Could not reach or start Talon',
        );
        AppLog.warn('app_state', 'daemon unavailable');
        _scheduleReconnect();
        return;
      }
      await _openStream(null, epoch);
    } else {
      daemon = const DaemonState(DaemonPhase.unknown);
      _watchNetwork();
      // The local address when it answers, the main one otherwise.
      final endpoint = await resolveEndpoint(config);
      if (epoch != _epoch) return;
      if (identical(endpoint, config)) {
        await _openStream(null, epoch);
      } else {
        // The pin belongs to the LAN bridge: persist it only from there.
        await _openStream(
          endpoint,
          epoch,
          persistPin: config.localEndpoint()?.baseUrl == endpoint.baseUrl,
        );
      }
    }
  }

  /// Re-pick the address whenever the network changes (Wi-Fi ↔ cellular,
  /// arriving home…), reconnecting only if the answer changed.
  void _watchNetwork() {
    if (config.localUrl == null) {
      _networkWatch?.cancel();
      _networkWatch = null;
      return;
    }
    if (_networkWatch != null) return;
    try {
      _networkWatch = Connectivity().onConnectivityChanged.listen(
        (results) {
          if (results.every((r) => r == ConnectivityResult.none)) return;
          _networkDebounce?.cancel();
          _networkDebounce = Timer(const Duration(seconds: 2), () async {
            if (_disposed || config.localUrl == null) return;
            final next = await resolveEndpoint(config);
            if (_disposed) return;
            if (next.baseUrl != _activeConfig?.baseUrl) {
              AppLog.info('app_state', 'network changed → ${next.baseUrl}');
              unawaited(start());
            }
          });
        },
        onError: (Object e) =>
            AppLog.debug('app_state', 'network watch unavailable', e),
      );
    } catch (e) {
      // No connectivity plugin (tests, unsupported platform): the address
      // is still re-picked on every reconnect, just not proactively.
      AppLog.debug('app_state', 'network watch unavailable', e);
    }
  }

  Future<void> _openStream(
    ConnectionConfig? effectiveConfig,
    int epoch, {
    bool? persistPin,
  }) async {
    await _sub?.cancel();
    if (epoch != _epoch) return;
    _client?.dispose();
    final cfg = effectiveConfig ?? config;
    // Keep the process-wide pin (Image.network et al.) in step with the
    // profile this attempt uses; TOFU below adopts one when none is set.
    BridgeTrust.pin(cfg.tls ? cfg.fingerprint : null);
    BridgeTrust.useClientContext(cfg.tls ? cfg.clientSecurityContext() : null);
    final client = BridgeClient(cfg);
    // Claim our mesh identity on this stream (when one has been minted) so
    // device commands are addressed to us rather than shouted at every
    // connected device; _startMesh sets it too, for the first-ever connect.
    client.meshDeviceId = prefs.meshDeviceId;
    _client = client;
    _activeConfig = cfg;

    try {
      // Verify identity before committing to the stream — gives a crisp error
      // when the host/token is wrong rather than a silent dead stream.
      final h = await client.health();
      if (epoch != _epoch) {
        _disposeStale(client);
        return;
      }
      AppLog.info('app_state', 'health ${h == null ? 'failed' : 'ok'}');
      if (h == null) {
        throw BridgeException('No Talon bridge at ${cfg.host}:${cfg.port}');
      }

      _sub = client.events.listen(
        _onEvent,
        onError: (Object e) {
          if (!identical(_client, client)) return; // stale stream
          if (e is BridgeException && e.clientCertificateRequired) {
            _stopFatal(e.message);
            return;
          }
          if (_isUnauthorized(e)) {
            _stopUnauthorized();
            return;
          }
          _setConn(ConnState.error, e.toString());
          _scheduleReconnect();
        },
      );
      await client.connect();
      if (epoch != _epoch) {
        _disposeStale(client);
        return;
      }

      AppLog.info('app_state', 'connected');
      await _adoptFingerprint(
        cfg,
        client,
        persist: persistPin ?? effectiveConfig == null,
      );
      _setConn(ConnState.connected, null);
      _backoffMs = 800;
      await _startMesh(client);
      await _refreshChats();
      unawaited(_refreshModels());
      unawaited(refreshMeshDevices());
      unawaited(_maybeUpgradeCredential(client, epoch));
    } catch (e) {
      if (epoch != _epoch) {
        _disposeStale(client);
        return;
      }
      if (e is BridgeException && e.clientCertificateRequired) {
        // Retrying can't produce a certificate — only importing one can.
        _stopFatal(e.message);
        return;
      }
      if (_isUnauthorized(e)) {
        _stopUnauthorized();
        return;
      }
      if (e is BridgeException && e.certificateChanged) {
        // A pin mismatch never heals by retrying — stop and tell the user.
        AppLog.warn('app_state', 'pin-fatal stop');
        _reconnect?.cancel();
        _setConn(ConnState.error, e.message);
        return;
      }
      _setConn(ConnState.error, e.toString());
      _scheduleReconnect();
    }
  }

  /// Set once the daemon answers 404 to `/auth/whoami` (it predates
  /// per-device credentials) — no point asking again this session.
  bool _credentialsUnsupported = false;
  bool _upgradingCredential = false;

  /// #1042: trade the shared bridge token for this device's own credential
  /// (or rotate the credential when the operator asked), in band, right
  /// after a successful connect. The new token is persisted to the profile
  /// BEFORE it is used, and the daemon keeps the old one valid until the new
  /// one is first presented — so neither a crash nor a lost reply can leave
  /// the app holding a token that doesn't work.
  ///
  /// Local-discovery profiles are left alone: they read the token from the
  /// daemon's 0600 discovery file on every connect, and a same-machine
  /// client keeps full access with the shared token by design.
  Future<void> _maybeUpgradeCredential(BridgeClient client, int epoch) async {
    if (_credentialsUnsupported || _upgradingCredential) return;
    if (config.canAutoDiscoverLocal) return;
    final token = client.config.token;
    if (token == null || token.isEmpty) return;
    _upgradingCredential = true;
    try {
      final status = await client.whoami();
      if (status == null) {
        _credentialsUnsupported = true;
        return;
      }
      if (!status.wantsNewCredential(token)) return;
      final deviceId = await _credentialDeviceId();
      if (deviceId == null || epoch != _epoch) return;
      final grant = await client.upgradeCredential(deviceId);
      if (grant.deviceId != deviceId || epoch != _epoch) return;
      config = config.copyWith(token: grant.token);
      await prefs.setConnection(config);
      client.config = client.config.copyWith(token: grant.token);
      _activeConfig = client.config;
      // The background mesh isolate dials with its own copy of the profile.
      MeshForegroundController.notifyReconfigure();
      AppLog.info(
        'app_state',
        'now using per-device credential ${grant.credentialId} '
            '(${grant.scopes.join(', ')})',
      );
    } catch (e) {
      AppLog.warn('app_state', 'credential upgrade failed', e);
    } finally {
      _upgradingCredential = false;
    }
  }

  /// The mesh device id a credential must be bound to — the SAME id this
  /// device registers and claims its stream with, or the daemon refuses the
  /// credential as another device's. On Android the background isolate
  /// mints it; if it hasn't yet, wait for the next connect rather than
  /// racing it with a second id.
  Future<String?> _credentialDeviceId() async {
    await prefs.reload();
    final existing = prefs.meshDeviceId;
    if (existing != null && existing.isNotEmpty) return existing;
    if (MeshForegroundController.isSupported && prefs.meshSharing) return null;
    return MeshService.ensureDeviceId(prefs);
  }

  /// Trust-on-first-use: after the first successful TLS connect with no pin
  /// yet, adopt the certificate the handshake presented. Remote profiles
  /// persist the pin ([persist]); local-discovery ones re-read it from the
  /// daemon's discovery file every connect instead.
  Future<void> _adoptFingerprint(
    ConnectionConfig cfg,
    BridgeClient client, {
    required bool persist,
  }) async {
    final seen = client.seenFingerprint;
    if (!cfg.tls || cfg.fingerprint != null || seen == null) return;
    BridgeTrust.pin(seen);
    client.config = cfg.copyWith(fingerprint: seen);
    _activeConfig = client.config;
    if (persist) {
      config = config.copyWith(fingerprint: seen);
      await prefs.setConnection(config);
      AppLog.info('app_state', 'pinned bridge certificate $seen');
    }
  }

  /// Tear down a client from a superseded connection attempt without touching
  /// the current one (a newer attempt may already own [_client]).
  void _disposeStale(BridgeClient client) {
    if (!identical(_client, client)) client.dispose();
  }

  void _scheduleReconnect() {
    if (_disposed || _uiStreamPaused) return;
    _reconnect?.cancel();
    AppLog.info('app_state', 'reconnect in ${_backoffMs}ms');
    _reconnect = Timer(Duration(milliseconds: _backoffMs), () {
      _backoffMs = (_backoffMs * 1.7).clamp(800, 15000).toInt();
      start();
    });
  }

  void _stopUnauthorized() {
    AppLog.warn('app_state', 'auth-fatal stop');
    _reconnect?.cancel();
    _setConn(ConnState.error, 'Unauthorized — check your token');
  }

  /// Stop reconnecting on an error only the user can fix.
  void _stopFatal(String message) {
    AppLog.warn('app_state', 'fatal stop: $message');
    _reconnect?.cancel();
    _setConn(ConnState.error, message);
  }

  static bool _isUnauthorized(Object e) =>
      e is BridgeException && e.unauthorized ||
      e.toString().contains('Unauthorized') ||
      e.toString().contains('(401)');

  /// Drop the connection profile (token, client certificate, pins) and
  /// everything cached from it, back to the first-run screen: the app lock's
  /// "erase after N failed attempts" and its forgotten-passcode reset. The
  /// device has to be paired again.
  Future<void> forgetConnection() async {
    _reconnect?.cancel();
    _epoch++;
    await _sub?.cancel();
    _sub = null;
    await _mesh?.stop();
    _mesh = null;
    _client?.dispose();
    _client = null;
    await prefs.resetMeshGrantsForPairing();
    await prefs.setOnboarded(false);
    config = ConnectionConfig.defaults();
    _activeConfig = null;
    await prefs.setConnection(config);
    MeshForegroundController.notifyReconfigure();
    chats.clear();
    _messages.clear();
    _turns.clear();
    _loadedHistory.clear();
    models = [];
    selectedChatId = null;
    conn = ConnState.idle;
    connError = null;
    AppLog.info('app_state', 'connection forgotten');
    notifyListeners();
  }

  /// Local approval for mesh device-control commands (the app lock's
  /// "require unlock for elevated commands"). Set by main; while unset, a
  /// gated command is refused rather than run unapproved.
  CommandApprover? commandApprover;

  Future<String?> _approveCommand(String name) {
    final approver = commandApprover;
    if (approver != null) return approver(name);
    return MeshService.defaultApproval(prefs, name);
  }

  /// Look at the certificate [candidate]'s bridge presents without sending
  /// its token — the connect screen's first step for a hand-typed TLS host,
  /// so the user can confirm the fingerprint before [applyConfig] hands the
  /// token to it (and to the background mesh isolate).
  Future<CertificateProbe> probeCertificate(ConnectionConfig candidate) {
    AppLog.info('app_state', 'probing certificate at ${candidate.baseUrl}');
    return BridgeClient.probeCertificate(candidate);
  }

  /// Apply a new connection profile and reconnect from scratch.
  Future<void> applyConfig(ConnectionConfig next) async {
    config = next;
    _activeConfig = null;
    await prefs.setConnection(next);
    // The background mesh isolate (Android) dials the bridge itself — hand it
    // the new profile immediately, not only after this UI connect succeeds.
    MeshForegroundController.notifyReconfigure();
    chats.clear();
    _messages.clear();
    _turns.clear();
    _loadedHistory.clear();
    models = [];
    selectedChatId = null;
    AppLog.info('app_state', 'connection config applied; stores reset');
    await start();
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  Future<void> selectChat(String chatId) async {
    final previous = selectedChatId;
    if (chatId != selectedChatId) unawaited(_reapUnusedChats(keep: chatId));
    selectedChatId = chatId;
    if (previous != null && previous != chatId) trimHistory(previous);
    markRead(chatId);
    notifyListeners();
    if (!_loadedHistory.contains(chatId)) await _loadHistory(chatId);
  }

  // ── Unread tracking ────────────────────────────────────────────────────────

  /// A chat is unread when it saw activity newer than the user's last look
  /// and it isn't the one currently on screen.
  bool hasUnread(ClientChat chat) =>
      chat.id != selectedChatId && chat.lastActive > prefs.lastReadOf(chat.id);

  void markRead(String chatId) {
    final chat = _chatById(chatId);
    final ts = chat?.lastActive ?? DateTime.now().millisecondsSinceEpoch;
    unawaited(prefs.setLastRead(chatId, ts));
  }

  // ── History pagination + search ───────────────────────────────────────────

  /// Drop all but the newest [_historyInitialSize] messages of a chat that
  /// is no longer on screen. Scrollback pages loaded with [loadOlderMessages]
  /// otherwise stay in memory for the life of the process — and a tray-
  /// resident desktop app rarely restarts (#1062/#1063). The chat is marked
  /// as having more history again, so scrolling up re-fetches on demand.
  void trimHistory(String chatId) {
    final msgs = _messages[chatId];
    if (msgs == null || msgs.length <= _historyInitialSize) return;
    msgs.removeRange(0, msgs.length - _historyInitialSize);
    _historyExhausted.remove(chatId);
  }

  /// Fetch the page of messages older than the oldest one currently loaded.
  /// Returns how many new messages were prepended (0 when exhausted/offline).
  Future<int> loadOlderMessages(String chatId) async {
    if (_loadingOlder.contains(chatId) ||
        _historyExhausted.contains(chatId) ||
        conn != ConnState.connected) {
      return 0;
    }
    final msgs = _messages[chatId];
    if (msgs == null || msgs.isEmpty) return 0;
    // Oldest server-assigned id (local system notes have non-numeric ids).
    // The minimum, not the first: the first numeric id is only the oldest
    // when the list is in order.
    int? oldest;
    for (final m in msgs) {
      final n = int.tryParse(m.id);
      if (n != null && (oldest == null || n < oldest)) oldest = n;
    }
    if (oldest == null) return 0;

    _loadingOlder.add(chatId);
    notifyListeners();
    try {
      final page = await _client?.history(
            chatId,
            before: oldest,
            limit: _historyPageSize,
          ) ??
          const <ClientMessage>[];
      if (page.length < _historyPageSize) _historyExhausted.add(chatId);
      final existing = msgs.map((m) => m.id).toSet();
      final fresh = page.where((m) => !existing.contains(m.id)).toList();
      msgs
        ..insertAll(0, fresh)
        ..sort(compareMessageOrder);
      return fresh.length;
    } catch (e) {
      AppLog.warn('app_state', 'older-history fetch failed', e);
      return 0;
    } finally {
      _loadingOlder.remove(chatId);
      notifyListeners();
    }
  }

  /// Daemon-side full-text search across all chats. Empty on failure so the
  /// quick switcher can fall back to local title matches silently.
  Future<List<SearchHit>> searchMessages(String query) async {
    if (conn != ConnState.connected || query.trim().isEmpty) return const [];
    try {
      return await _client?.search(query.trim()) ?? const [];
    } catch (e) {
      AppLog.warn('app_state', 'search failed', e);
      return const [];
    }
  }

  /// Narrow layout: return to the chat list.
  void clearSelection() {
    unawaited(_reapUnusedChats());
    selectedChatId = null;
    notifyListeners();
  }

  /// Pull-to-refresh: re-sync chats + models from the daemon when connected,
  /// or restart the connection attempt when it isn't. Completes when the
  /// refresh is done so a RefreshIndicator can spin honestly.
  Future<void> refresh() async {
    if (conn == ConnState.connected) {
      await _refreshChats();
      await _refreshModels(selectedChatId);
    } else {
      await start();
    }
  }

  /// Chats this client created that have never carried a message. Tapping
  /// "New chat" creates a real chat on the daemon immediately, so opening one
  /// and backing out used to leave an empty row in the list forever. Leaving
  /// such a chat deletes it (see [_reapUnusedChats]); the daemon sweeps any
  /// that outlive the app as a backstop.
  ///
  /// Scoped to chats THIS client created on purpose: another client's fresh
  /// chat is none of our business, and a chat whose history simply hasn't been
  /// fetched yet must never be mistaken for an empty one.
  final Set<String> _unusedChats = {};

  Future<void> newChat() async {
    final c = await _client?.createChat();
    if (c == null) return;
    // chat_created event will also arrive; select eagerly for snappiness.
    _upsertChat(c);
    _unusedChats.add(c.id);
    // Leaving the previous untouched chat for a brand-new one still counts as
    // leaving it — otherwise tapping "New chat" twice strands the first.
    unawaited(_reapUnusedChats(keep: c.id));
    selectedChatId = c.id;
    _loadedHistory.add(c.id);
    notifyListeners();
  }

  /// Delete every untouched chat except [keep]. Called whenever the user
  /// leaves a conversation (selecting another, or backing out to the list).
  ///
  /// A chat only qualifies while it is still in [_unusedChats] — anything that
  /// has sent, queued, or received a message has already been struck off, so
  /// nothing with content can be reached from here.
  Future<void> _reapUnusedChats({String? keep}) async {
    final doomed = _unusedChats.where((id) => id != keep).toList();
    if (doomed.isEmpty) return;
    for (final id in doomed) {
      _unusedChats.remove(id);
      if (isTurnRunning(id) || queuedFor(id) != null) continue;
      if (messagesFor(id).isNotEmpty) continue;
      // Best-effort: a failed delete just leaves the row for the daemon's
      // own sweep, so it never needs to surface as an error in the chat.
      try {
        await _client?.deleteChat(id);
      } catch (e) {
        AppLog.warn('app_state', 'auto-delete of empty chat failed', e);
      }
    }
  }

  ClientChat? _chatById(String chatId) {
    for (final c in chats) {
      if (c.id == chatId) return c;
    }
    return null;
  }

  /// Run a chat-scoped daemon command, surfacing failure as a system note in
  /// that chat instead of an unhandled async exception in a UI callback.
  Future<void> _command(String chatId, String what, Future<void> future) async {
    try {
      await future;
    } catch (e) {
      AppLog.warn('app_state', '$what failed', e);
      _appendSystem(chatId, '$what failed: $e');
    }
  }

  Future<void> renameChat(String chatId, String title) async {
    // Optimistic: reflect immediately; the chat_updated event reconciles.
    final chat = _chatById(chatId);
    if (chat != null && chat.title != title) {
      chat.title = title;
      notifyListeners();
    }
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Rename', client.renameChat(chatId, title));
  }

  Future<void> deleteChat(String chatId) async {
    _unusedChats.remove(chatId);
    final client = _client;
    if (client == null) return;
    // chat_deleted event reconciles state.
    await _command(chatId, 'Delete', client.deleteChat(chatId));
  }

  /// Returns whether the daemon accepted the message — false lets the
  /// composer hand the draft back instead of silently losing it.
  Future<bool> sendMessage(
    String text, {
    List<Attachment> attachments = const [],
  }) async {
    final chatId = selectedChatId;
    final client = _client;
    if (chatId == null || client == null) return false;
    // Text may be empty when files are attached.
    if (text.trim().isEmpty && attachments.isEmpty) return false;
    // The user committed to this chat: it is no longer an untouched one, even
    // if the send fails or the reply is slow to arrive.
    _unusedChats.remove(chatId);
    // Always hand it to the daemon: if a turn is already running for this chat
    // the daemon parks it as the queued follow-up (synced to every client) and
    // auto-sends it at turn end, rather than interrupting. So the app doesn't
    // need to decide — it just sends.
    try {
      await client.send(chatId, text.trim(), attachments: attachments);
      return true;
    } catch (e) {
      _appendSystem(chatId, 'Failed to send: $e');
      return false;
    }
  }

  // ── Queued follow-up (server-authoritative, one slot per chat) ────────────--

  /// The queued follow-up for a chat, or null when nothing is queued. Sourced
  /// from the chat's synced state so it's identical on every device.
  QueuedMessage? queuedFor(String chatId) => _chatById(chatId)?.queued;

  /// Set / replace / clear (empty text) the chat's queued follow-up. The daemon
  /// broadcasts the change back, so every client — including this one — updates
  /// from the authoritative chat_updated rather than a local guess.
  Future<void> editQueued(String chatId, String text) async {
    try {
      await _client?.queue(chatId, text);
    } catch (e) {
      AppLog.warn('app_state', 'queue edit failed', e);
    }
  }

  /// Stream a staged file up to the daemon and return its record, or null on
  /// failure (a system note is appended so the user sees what happened).
  /// [onProgress] reports bytes sent so the composer can show a real bar.
  Future<Attachment?> uploadAttachment(
    Stream<List<int>> bytes,
    int length,
    String filename,
    String contentType, {
    void Function(int sent)? onProgress,
  }) async {
    final client = _client;
    if (client == null) return null;
    try {
      return await client.uploadAttachment(
        bytes,
        length,
        filename,
        contentType,
        onProgress: onProgress,
      );
    } catch (e) {
      final chatId = selectedChatId;
      if (chatId != null) _appendSystem(chatId, 'Upload failed: $e');
      return null;
    }
  }

  Future<void> setModel(String chatId, String model) async {
    // Optimistic: the header chip and sheet update instantly instead of
    // waiting a round-trip for chat_updated.
    final chat = _chatById(chatId);
    if (chat != null && chat.model != model) {
      chat.model = model;
      notifyListeners();
    }
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Model change', client.setModel(chatId, model));
  }

  /// Backends selectable for a chat + the chat's active backend id. Returns
  /// empty on any failure (e.g. an older daemon without the endpoint) so the
  /// sheet simply hides the backend row.
  Future<(String, List<BackendOption>)> backends(String chatId) async {
    try {
      return await _client?.backends(chatId) ?? ('', const <BackendOption>[]);
    } catch (e) {
      AppLog.warn('app_state', 'backends fetch failed', e);
      return ('', const <BackendOption>[]);
    }
  }

  /// Switch a chat's backend. Returns the daemon result so the UI can toast a
  /// failure (e.g. "Backend not available") instead of silently no-op'ing.
  Future<({bool ok, String? error})> setBackend(
    String chatId,
    String backend,
  ) async {
    try {
      final r = await _client?.setBackend(chatId, backend);
      if (r?.ok == true) {
        final chat = _chatById(chatId);
        if (chat != null && chat.backend != backend) {
          chat.backend = backend;
          notifyListeners();
        }
        // The new backend exposes a different model catalog, so re-pull the
        // models for this chat from the gateway. Without this the picker keeps
        // showing the previous backend's models until the next manual refresh.
        await _refreshModels(chatId);
      }
      return r ?? (ok: false, error: 'Not connected');
    } catch (e) {
      AppLog.warn('app_state', 'backend switch failed', e);
      return (ok: false, error: e.toString());
    }
  }

  Future<void> setEffort(String chatId, String effort) async {
    final chat = _chatById(chatId);
    if (chat != null && chat.effort != effort) {
      chat.effort = effort;
      notifyListeners();
    }
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Effort change', client.setEffort(chatId, effort));
  }

  /// Effort levels for a chat; empty on failure so the row hides.
  Future<(String, List<String>)> effortLevels(String chatId) async {
    try {
      return await _client?.effortLevels(chatId) ??
          ('adaptive', const <String>[]);
    } catch (e) {
      AppLog.warn('app_state', 'effort fetch failed', e);
      return ('adaptive', const <String>[]);
    }
  }

  Future<void> resetChat(String chatId) async {
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Reset', client.resetChat(chatId));
  }

  /// Whether a turn is currently running for [chatId] — drives the composer's
  /// send↔stop affordance.
  bool isTurnRunning(String chatId) => turnFor(chatId).active;

  /// Ask the daemon to interrupt the chat's in-flight turn. Best-effort: does
  /// nothing when the backend can't interrupt or no turn is running.
  Future<void> interruptTurn(String chatId) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.interruptTurn(chatId);
    } catch (e) {
      AppLog.warn('app_state', 'interrupt failed', e);
    }
  }

  // Mesh pref setters notify TWICE: once right after the (local, fast) pref
  // write so the toggle flips instantly, and again after `_meshPrefsChanged`
  // — which can spend seconds syncing the Android foreground service — so
  // the derived background-health row settles too. Notifying only at the
  // end left the switch visually stuck for the whole sync.

  Future<void> setMeshSharing(bool on) async {
    await prefs.setMeshSharing(on);
    notifyListeners();
    await _meshPrefsChanged();
    notifyListeners();
  }

  Future<void> setMeshPeriodic(bool on) async {
    await prefs.setMeshPeriodic(on);
    notifyListeners();
    await _meshPrefsChanged();
    notifyListeners();
  }

  Future<void> setMeshIntervalSeconds(int seconds) async {
    await prefs.setMeshIntervalSeconds(seconds);
    notifyListeners();
    await _meshPrefsChanged();
    notifyListeners();
  }

  Future<void> setMeshDeviceControl(bool on) async {
    await prefs.setMeshDeviceControl(on);
    notifyListeners();
    // Re-register so the daemon sees the exec/fs capabilities appear/disappear.
    await _meshPrefsChanged();
    notifyListeners();
  }

  /// Let device control use root/Shizuku (Android). On by default.
  Future<void> setMeshElevated(bool on) async {
    await prefs.setMeshElevated(on);
    notifyListeners();
    await _meshPrefsChanged();
    notifyListeners();
  }

  /// Opt-in: start every new pairing without device control or elevation.
  Future<void> setMeshGrantsPerPairing(bool on) async {
    await prefs.setMeshGrantsPerPairing(on);
    notifyListeners();
    await _meshPrefsChanged();
    notifyListeners();
  }

  /// Override one of the mesh command limits (null leaves it unchanged).
  Future<void> setMeshLimits({
    int? concurrent,
    int? queued,
    int? writeGiB,
  }) async {
    if (concurrent != null) await prefs.setMeshMaxConcurrent(concurrent);
    if (queued != null) await prefs.setMeshMaxQueued(queued);
    if (writeGiB != null) await prefs.setMeshMaxWriteGiB(writeGiB);
    notifyListeners();
    await _meshPrefsChanged();
    notifyListeners();
  }

  /// Propagate a mesh pref change to whichever isolate owns the mesh loop:
  /// the Android foreground service (start/stop it to mirror the sharing
  /// toggle, poke a reconfigure when it's already up) or the in-process
  /// MeshService everywhere else.
  Future<void> _meshPrefsChanged() async {
    if (MeshForegroundController.isSupported) {
      try {
        final foregroundOk = await MeshForegroundController.syncFromPrefs(
          prefs,
        );
        await _refreshMeshBackgroundHealth();
        if (!foregroundOk && prefs.meshSharing && _client != null) {
          await _startUiMeshFallback(_client!);
        }
      } catch (e) {
        AppLog.warn('app_state', 'mesh foreground sync failed', e);
        if (prefs.meshSharing && _client != null) {
          await _startUiMeshFallback(_client!);
        }
      }
      return;
    }
    _mesh?.reconfigure();
    if (MeshForegroundController.isResidentDesktop) {
      await _refreshMeshBackgroundHealth();
    }
  }

  Future<void> refreshMeshDevices() async {
    final client = _client;
    if (client == null || conn != ConnState.connected) return;
    try {
      final r = await client.devices();
      meshDevices = r.$1;
      meshLocations = r.$2;
      notifyListeners();
    } catch (e) {
      AppLog.warn('app_state', 'mesh refresh failed', e);
    }
  }

  Future<ConfigSnapshot?> loadConfig() async {
    final c = await _client?.getConfig();
    if (c != null) {
      appConfig = c;
      notifyListeners();
    }
    return c;
  }

  Future<ConfigSnapshot?> updateConfig(Map<String, dynamic> update) async {
    try {
      final c = await _client?.setConfig(update);
      if (c != null) {
        appConfig = c;
        notifyListeners();
      }
      return c;
    } catch (e) {
      AppLog.warn('app_state', 'config update failed', e);
      return null;
    }
  }

  /// Desktop only: restart the managed daemon, then reconnect.
  Future<({bool ok, String? detail})> restartDaemon() async {
    if (!config.canManageDaemon) {
      return (ok: false, detail: 'Restart needs a local managed daemon');
    }
    _setConn(ConnState.connecting, null);
    final result = await DaemonSupervisor(config).restart();
    if (result.ok) {
      // Give the old process a moment to release the port before reattaching.
      await Future<void>.delayed(const Duration(seconds: 2));
      await start();
    } else {
      _setConn(ConnState.error, result.detail);
    }
    return result;
  }

  /// Seeded extension lists for widget tests / the screenshot gallery —
  /// [listPlugins]/[listSkills] serve these instead of hitting the bridge.
  List<PluginInfo>? _debugPlugins;
  List<SkillInfo>? _debugSkills;

  /// Installed plugins for the settings sub-menu. Throws on transport
  /// failure — the screen owns the error presentation.
  Future<List<PluginInfo>> listPlugins() async {
    final seeded = _debugPlugins;
    if (seeded != null) return seeded;
    final client = _client;
    if (client == null) throw BridgeException('Not connected');
    return client.listPlugins();
  }

  Future<({bool ok, String? error})> togglePlugin(
    String name,
    bool enabled,
  ) async {
    final client = _client;
    if (client == null) return (ok: false, error: 'Not connected');
    try {
      return await client.togglePlugin(name, enabled);
    } catch (e) {
      AppLog.warn('app_state', 'plugin toggle failed', e);
      return (ok: false, error: e.toString());
    }
  }

  /// Installed skills for the settings sub-menu. Throws on transport
  /// failure — the screen owns the error presentation.
  Future<List<SkillInfo>> listSkills() async {
    final seeded = _debugSkills;
    if (seeded != null) return seeded;
    final client = _client;
    if (client == null) throw BridgeException('Not connected');
    return client.listSkills();
  }

  Future<({bool ok, String? error})> toggleSkill(
    String name,
    bool enabled,
  ) async {
    final client = _client;
    if (client == null) return (ok: false, error: 'Not connected');
    try {
      return await client.toggleSkill(name, enabled);
    } catch (e) {
      AppLog.warn('app_state', 'skill toggle failed', e);
      return (ok: false, error: e.toString());
    }
  }

  /// Newest daemon log entries for the log viewer. Throws on transport
  /// failure — the screen owns the error presentation.
  Future<List<DaemonLogEntry>> daemonLogs({
    int lines = 300,
    String? level,
    String? component,
  }) async {
    final client = _client;
    if (client == null) throw BridgeException('Not connected');
    return client.logs(lines: lines, level: level, component: component);
  }

  /// Fire a daemon-level control action over the bridge ("restart", "dream").
  /// Unlike [restartDaemon] (which drives a locally-managed process), this asks
  /// the *running* daemon to act on itself, so it works over a remote bridge
  /// too — the app can restart a Talon running on another machine.
  Future<({bool ok, String message})> daemonControl(String action) async {
    final client = _client;
    if (client == null) return (ok: false, message: 'Not connected');
    try {
      return await client.control(action);
    } catch (e) {
      AppLog.warn('app_state', 'control "$action" failed', e);
      return (ok: false, message: '$e');
    }
  }

  Future<void> _startMesh(BridgeClient client) async {
    if (MeshForegroundController.isSupported) {
      // Android: the mesh loop lives entirely in the foreground service's
      // isolate (mesh_background.dart) so teleport/exec/locate survive this
      // UI engine being backgrounded, swiped away, or killed. Running a
      // second MeshService here would execute every command twice.
      await _mesh?.stop();
      _mesh = null;
      try {
        final foregroundOk = await MeshForegroundController.syncFromPrefs(
          prefs,
        );
        await _refreshMeshBackgroundHealth();
        if (!foregroundOk && prefs.meshSharing) {
          await _startUiMeshFallback(client);
        }
      } catch (e) {
        AppLog.warn('app_state', 'mesh foreground sync failed', e);
        if (prefs.meshSharing) {
          await _startUiMeshFallback(client);
        }
      }
      return;
    }
    await _mesh?.stop();
    final resident = MeshForegroundController.isResidentDesktop;
    if (resident && prefs.meshSharing) {
      await prefs.setMeshBgStartedAt(DateTime.now().millisecondsSinceEpoch);
    }
    final mesh = MeshService(
      prefs,
      client,
      approver: _approveCommand,
      // macOS stays resident in the menu bar, so this in-app mesh IS the
      // background mesh — stamp registrations so health reads healthy/stale.
      onRegistered: resident ? _stampResidentMeshAlive : null,
    );
    _mesh = mesh;
    try {
      await mesh.start();
    } catch (e) {
      AppLog.warn('app_state', 'mesh start failed', e);
    }
    if (resident) await _refreshMeshBackgroundHealth();
  }

  Future<void> _stampResidentMeshAlive() async {
    if (!prefs.meshSharing) return;
    // A tiny file, not a prefs write: on Windows every SharedPreferences set
    // rewrites the whole store, once a minute for as long as the tray icon
    // lives (#1060/#1063).
    await MeshLiveness.stamp(prefs, DateTime.now().millisecondsSinceEpoch);
  }

  Future<void> _startUiMeshFallback(BridgeClient client) async {
    AppLog.warn('app_state', 'starting UI-isolate mesh fallback');
    await _mesh?.stop();
    final mesh = MeshService(prefs, client, approver: _approveCommand);
    _mesh = mesh;
    try {
      await mesh.start();
    } catch (e) {
      AppLog.warn('app_state', 'UI mesh fallback start failed', e);
    }
  }

  Future<void> refreshMeshBackgroundHealth() => _refreshMeshBackgroundHealth();

  Future<void> _refreshMeshBackgroundHealth() async {
    meshBackgroundHealth = await MeshForegroundController.healthFromPrefs(
      prefs,
      residentMeshRunning: _mesh != null,
    );
    _updateMenuBar();
    notifyListeners();
  }

  /// Short live status for the macOS menu bar item (no-op elsewhere).
  void _updateMenuBar() {
    if (!MenuBarStatus.isSupported) return;
    final connLabel = switch (conn) {
      ConnState.connected => 'Connected',
      ConnState.connecting => 'Connecting…',
      ConnState.error => 'Disconnected',
      ConnState.idle => 'Not connected',
    };
    final meshLabel = !prefs.meshSharing
        ? 'mesh off'
        : switch (meshBackgroundHealth.kind) {
            MeshForegroundHealthKind.healthy => 'mesh active',
            MeshForegroundHealthKind.starting => 'mesh starting',
            MeshForegroundHealthKind.stale => 'mesh stale',
            MeshForegroundHealthKind.off => 'mesh off',
            MeshForegroundHealthKind.unsupported => 'mesh in-app',
          };
    unawaited(MenuBarStatus.set('$connLabel · $meshLabel'));
  }

  // ── Event handling ───────────────────────────────────────────────────────--

  void _onEvent(Map<String, dynamic> e) {
    try {
      final kind = e['kind'];
      if (kind == 'delta' || kind == 'reasoning') {
        _onStreamEvent(e);
        return;
      }
      if (_applyEvent(e)) {
        notifyListeners();
        if (_snapshotKinds.contains(kind)) _scheduleSnapshotSave();
      }
    } catch (err) {
      AppLog.warn('app_state', 'ignored malformed event', err);
    }
  }

  /// Events that change what the offline snapshot holds (chats, delivered
  /// messages). Token-level and presence events never trigger a save.
  static const Set<String> _snapshotKinds = {
    'hello',
    'chat_created',
    'chat_updated',
    'chat_deleted',
    'message',
    'message_edited',
    'message_deleted',
    'reaction',
    'turn_end',
  };

  /// The per-token hot path. Only the turn's own listeners hear about it
  /// (coalesced per frame) — unless this token changes the *shape* of the
  /// chat view: the first reply text or reasoning of a stretch (which makes
  /// the live row appear or swaps "still working" for text), in which case a
  /// normal app-wide notify goes out once.
  void _onStreamEvent(Map<String, dynamic> e) {
    final chatId = _string(e['chatId']);
    if (chatId == null) return;
    final t = turnFor(chatId);
    final shapeChange =
        t.continuing || (!t.hasDraft && t.reasoning.isEmpty);
    if (!_applyEvent(e)) return;
    if (shapeChange) {
      notifyListeners();
    } else {
      t.changed();
    }
  }

  bool _applyEvent(Map<String, dynamic> e) {
    switch (e['kind'] as String?) {
      case 'hello':
        final rawStatus = _map(e['status']);
        if (rawStatus == null) return false;
        status = BridgeStatus.fromJson(rawStatus);
        _setChats(_list(e['chats']));
        return true;
      case 'status':
        final rawStatus = _map(e['status']);
        if (rawStatus == null) return false;
        status = BridgeStatus.fromJson(rawStatus);
        return true;
      case 'chat_created':
      case 'chat_updated':
        final rawChat = _map(e['chat']);
        if (rawChat == null) return false;
        _upsertChat(ClientChat.fromJson(rawChat));
        return true;
      case 'chat_deleted':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        _removeChat(chatId);
        return true;
      case 'message':
        final chatId = _string(e['chatId']);
        final rawMessage = _map(e['message']);
        if (chatId == null || rawMessage == null) return false;
        _onMessage(chatId, ClientMessage.fromJson(rawMessage));
        return true;
      case 'message_edited':
        final chatId = _string(e['chatId']);
        final messageId = _string(e['messageId']);
        if (chatId == null || messageId == null) return false;
        _editMessage(chatId, messageId, _string(e['text']) ?? '');
        return true;
      case 'message_deleted':
        final chatId = _string(e['chatId']);
        final messageId = _string(e['messageId']);
        if (chatId == null || messageId == null) return false;
        _deleteMessage(chatId, messageId);
        return true;
      case 'reaction':
        final chatId = _string(e['chatId']);
        final messageId = _string(e['messageId']);
        final emoji = _string(e['emoji']);
        if (chatId == null || messageId == null || emoji == null) {
          return false;
        }
        _addReaction(chatId, messageId, emoji);
        return true;
      case 'turn_start':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        _continuingTimers.remove(chatId)?.cancel();
        turnFor(chatId).reset();
        return true;
      case 'reasoning':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        final t = turnFor(chatId);
        _clearContinuing(t, chatId);
        t.reasoning.add(_string(e['text']) ?? '');
        return true;
      case 'delta':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        final t = turnFor(chatId);
        _clearContinuing(t, chatId);
        t.appendDraft(_string(e['text']) ?? '');
        return true;
      case 'tool':
        return _onTool(e);
      case 'typing':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        turnFor(chatId).typing = e['on'] == true;
        return true;
      case 'turn_end':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        final t = turnFor(chatId);
        // Guarantee all tools in the most recent assistant message are done.
        // Tool result events can race against the message snapshot — this is
        // the definitive point where the turn is finished. Also attach the
        // turn's stats (duration + token usage) to that message so the bubble
        // can show a quiet footer.
        final usage = _map(e['usage']);
        final durationMs = e['durationMs'];
        final msgs = _messages[chatId];
        if (msgs != null) {
          for (final msg in msgs.reversed) {
            if (msg.role == Role.assistant) {
              for (final tool in msg.tools) {
                if (!tool.done) {
                  tool.done = true;
                  tool.finishedAt ??= DateTime.now();
                }
              }
              if (durationMs is num) msg.durationMs = durationMs.toInt();
              if (usage != null) {
                final inTok = usage['input'];
                final outTok = usage['output'];
                if (inTok is num) msg.tokensIn = inTok.toInt();
                if (outTok is num) msg.tokensOut = outTok.toInt();
              }
              break;
            }
          }
        }
        t.active = false;
        t.typing = false;
        t.draft = '';
        t.reasoning.clear();
        t.tools.clear();
        _clearContinuing(t, chatId);
        return true;
      case 'error':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        _appendSystem(chatId, _string(e['message']) ?? '');
        return true;
    }
    return false;
  }

  void _onMessage(String chatId, ClientMessage m) {
    // It has content now — never a candidate for auto-cleanup again.
    _unusedChats.remove(chatId);
    final list = _messages.putIfAbsent(chatId, () => []);
    if (list.any((x) => x.id == m.id)) return; // dedupe re-delivery
    list.add(m);
    // The visible chat is by definition read up to now.
    if (chatId == selectedChatId) markRead(chatId);
    // A delivered assistant message supersedes the live streaming state, but
    // NOT necessarily the turn: the model may have called send_message and
    // kept working (no end_turn yet). So fold the streamed draft/tools into
    // this bubble and clear the transient state, but leave the turn `active`
    // and let the definitive `turn_end` end it. To avoid flashing a "working"
    // indicator on a normal single-reply turn (where turn_end lands right
    // behind the message), arm a short grace timer: only if the turn is still
    // active when it fires do we promote to the `continuing` state.
    if (m.role == Role.assistant) {
      final t = turnFor(chatId);
      // Hand the live tools to the message so the bubble can show a history.
      m.tools.addAll(t.tools);
      t.typing = false;
      t.draft = '';
      t.reasoning.clear();
      t.tools.clear();
      t.continuing = false;
      _continuingTimers.remove(chatId)?.cancel();
      if (t.active) {
        _continuingTimers[chatId] = Timer(_continuingGrace, () {
          _continuingTimers.remove(chatId);
          final cur = turnFor(chatId);
          // Still mid-turn with nothing newer streaming → show "still working".
          if (cur.active && !cur.hasDraft && cur.tools.isEmpty) {
            cur.continuing = true;
            notifyListeners();
          }
        });
      }
    }
  }

  /// Drop any pending "still working" promotion for a chat and clear the flag.
  /// Called whenever fresh content streams or the turn ends.
  void _clearContinuing(TurnState t, String chatId) {
    _continuingTimers.remove(chatId)?.cancel();
    t.continuing = false;
  }

  bool _onTool(Map<String, dynamic> e) {
    final chatId = _string(e['chatId']);
    final id = _string(e['id']);
    if (chatId == null || id == null) return false;
    final name = _string(e['name']) ?? 'tool';
    // No name-based filtering here: the daemon owns tool classification and
    // never emits reply-delivery tools (end_turn / send_message / react) in
    // `tool` events or history — their effect arrives as the message itself.
    final t = turnFor(chatId);
    final phase = _string(e['phase']);
    final output = _string(e['output']);
    final existing = t.tools.where((x) => x.id == id);
    if (phase == 'result') {
      if (existing.isNotEmpty) {
        existing.first.done = true;
        existing.first.finishedAt = DateTime.now();
        existing.first.error = _string(e['error']);
        if (output != null) existing.first.output = output;
      } else {
        // The assistant message already arrived and tools were snapshotted into
        // it before this result event landed — update the historical copy too so
        // the chip doesn't spin forever in the message history.
        for (final msg in _messages[chatId] ?? <ClientMessage>[]) {
          for (final tool in msg.tools) {
            if (tool.id == id) {
              tool.done = true;
              tool.finishedAt ??= DateTime.now();
              tool.error = _string(e['error']);
              if (output != null) tool.output = output;
            }
          }
        }
      }
      return true;
    }
    if (existing.isEmpty) {
      _clearContinuing(t, chatId);
      t.tools.add(
        ToolActivity(id: id, name: name, input: _map(e['input']) ?? const {}),
      );
    }
    return true;
  }

  /// Seed the stores directly — for widget tests and the screenshot gallery,
  /// where rendering real content matters but a live bridge doesn't exist.
  @visibleForTesting
  void debugSeed({
    List<ClientChat>? chats,
    Map<String, List<ClientMessage>>? messages,
    String? select,
    ConnState? connState,
    BridgeStatus? bridgeStatus,
    List<PluginInfo>? plugins,
    List<SkillInfo>? skills,
  }) {
    if (chats != null) {
      this.chats
        ..clear()
        ..addAll(chats);
      _sortChats();
    }
    if (messages != null) {
      _messages
        ..clear()
        ..addAll(messages);
      _loadedHistory.addAll(messages.keys);
      _historyExhausted.addAll(messages.keys);
    }
    if (select != null) selectedChatId = select;
    if (connState != null) conn = connState;
    if (bridgeStatus != null) status = bridgeStatus;
    if (plugins != null) _debugPlugins = plugins;
    if (skills != null) _debugSkills = skills;
    notifyListeners();
  }

  // ── Store helpers ────────────────────────────────────────────────────────--

  Future<void> _refreshChats() async {
    final list = await _client?.listChats() ?? const [];
    chats
      ..clear()
      ..addAll(list);
    _sortChats();
    _reconcileSelection();
    // This runs on every (re)connect. History may have advanced while we were
    // disconnected (a heartbeat/cron reply, another client, a network blip or
    // laptop sleep), so drop the "already loaded" marks — otherwise a chat we'd
    // viewed before would keep its stale message list forever. Re-fetch the
    // visible chat now; the rest reload lazily when next opened.
    _loadedHistory.clear();
    _historyExhausted.clear();
    if (selectedChatId != null) {
      await _loadHistory(selectedChatId!);
    }
    notifyListeners();
    _scheduleSnapshotSave();
  }

  /// Public: re-fetch the model catalog (optionally for a specific chat, so the
  /// active-model hint reflects that chat's backend). Used after a backend
  /// switch, where the newly-selected backend exposes a different model set.
  Future<void> refreshModels([String? chatId]) => _refreshModels(chatId);

  Future<void> _refreshModels([String? chatId]) async {
    try {
      final r = await _client?.models(chatId);
      if (r != null && !_disposed) {
        models = r.$2;
        // The gateway also reports the chat's active model — sync it so the
        // header chip is right immediately after a backend switch, even if
        // the daemon's chat_updated event is late or missing.
        if (chatId != null && r.$1.isNotEmpty) {
          final chat = _chatById(chatId);
          if (chat != null) chat.model = r.$1;
        }
        notifyListeners();
      }
    } catch (e) {
      AppLog.warn('app_state', 'model refresh failed', e);
    }
  }

  Future<void> _loadHistory(String chatId) async {
    _loadingHistory.add(chatId);
    notifyListeners();
    try {
      final hist = await _client?.history(chatId, limit: _historyInitialSize) ??
          const <ClientMessage>[];
      if (hist.length < _historyInitialSize) {
        _historyExhausted.add(chatId);
      } else {
        _historyExhausted.remove(chatId);
      }
      // Merge rather than overwrite: a live `message` event can land while this
      // fetch is in flight, and a blind assignment would drop it (it isn't in
      // the server snapshot yet). History is authoritative for order; append
      // any newer live messages not already present, deduped by id.
      //
      // System notices need one extra rule. They're client/broadcast-only
      // ("Switched to codex — starting a fresh conversation.", send failures)
      // and never appear in server history, so a plain id-dedupe keeps them
      // forever — and this append re-pinned them BELOW the fresh history on
      // every reconnect, resurrecting a days-old "backend switched" notice at
      // the bottom of the chat each time the app was reopened. Keep a system
      // notice only while it's genuinely the newest thing in the conversation;
      // once real history has moved past it, it has expired.
      //
      // Since the first fetch is a bounded window (the newest
      // [_historyInitialSize]), "not in the window" also matches OLDER
      // scrollback paged in earlier and old snapshot rows, and appending them
      // pinned week-old messages below the newest on every reconnect. Only
      // messages genuinely newer than the window survive the merge; older
      // ones are dropped (scrolling up pages them back in, in order).
      final histIds = hist.map((m) => m.id).toSet();
      final newestTs = hist.isEmpty ? 0 : hist.last.ts;
      final newestId = _maxServerId(hist);
      final extras = (_messages[chatId] ?? const <ClientMessage>[]).where((m) {
        if (histIds.contains(m.id)) return false;
        final n = int.tryParse(m.id);
        if (n != null && newestId != null) return n > newestId;
        return m.ts >= newestTs;
      });
      _messages[chatId] = [...hist, ...extras]..sort(compareMessageOrder);
      _loadedHistory.add(chatId);
    } catch (_) {
      /* leave existing messages; stream will fill in */
    } finally {
      _loadingHistory.remove(chatId);
      notifyListeners();
      _scheduleSnapshotSave();
    }
  }

  void _setChats(List<dynamic> raw) {
    chats
      ..clear()
      ..addAll(
        raw
            .map(_map)
            .whereType<Map<String, dynamic>>()
            .map(ClientChat.fromJson),
      );
    _sortChats();
    _reconcileSelection();
  }

  /// Keep the selection valid against the freshly-set chat list: a chat
  /// deleted while we were away must not stay selected (it would render an
  /// empty conversation and fetch history for a dead id), and with nothing
  /// selected we default to the most recent chat.
  void _reconcileSelection() {
    if (selectedChatId != null && !chats.any((c) => c.id == selectedChatId)) {
      selectedChatId = null;
    }
    // Auto-selecting is a two-pane (desktop) convenience only. In the narrow
    // layout "nothing selected" IS the chat-list screen — defaulting here
    // would silently navigate the user into a conversation (and un-do a
    // back-gesture return to the list on the next reconnect).
    if (!_narrowLayout) {
      selectedChatId ??= chats.isNotEmpty ? chats.first.id : null;
    }
  }

  void _upsertChat(ClientChat c) {
    final i = chats.indexWhere((x) => x.id == c.id);
    if (i >= 0) {
      chats[i] = c;
    } else {
      chats.add(c);
    }
    _sortChats();
  }

  void _removeChat(String chatId) {
    chats.removeWhere((c) => c.id == chatId);
    _messages.remove(chatId);
    _turns.remove(chatId);
    _loadedHistory.remove(chatId);
    _historyExhausted.remove(chatId);
    unawaited(prefs.clearLastRead(chatId));
    if (selectedChatId == chatId) {
      selectedChatId = chats.isNotEmpty ? chats.first.id : null;
    }
  }

  void _sortChats() =>
      chats.sort((a, b) => b.lastActive.compareTo(a.lastActive));

  void _editMessage(String chatId, String messageId, String text) {
    for (final m in _messages[chatId] ?? const <ClientMessage>[]) {
      if (m.id == messageId) m.text = text;
    }
  }

  void _deleteMessage(String chatId, String messageId) {
    _messages[chatId]?.removeWhere((m) => m.id == messageId);
  }

  void _addReaction(String chatId, String messageId, String emoji) {
    for (final m in _messages[chatId] ?? const <ClientMessage>[]) {
      if (m.id == messageId && !m.reactions.contains(emoji)) {
        m.reactions.add(emoji);
      }
    }
  }

  void _appendSystem(String chatId, String text) {
    final list = _messages.putIfAbsent(chatId, () => []);
    // A repeating failure (rate limit, dead bridge, session cap) fires the
    // same error event over and over; stacking identical notices buries the
    // conversation. Collapse into the existing row instead of appending.
    if (list.isNotEmpty &&
        list.last.role == Role.system &&
        list.last.text == text) {
      notifyListeners();
      return;
    }
    list.add(
      ClientMessage(
        id: 'sys-${DateTime.now().microsecondsSinceEpoch}',
        chatId: chatId,
        role: Role.system,
        text: text,
        ts: DateTime.now().millisecondsSinceEpoch,
      ),
    );
    // Callers outside the event loop (send/upload/command failures) rely on
    // this notify — without it the note only appears on the next repaint.
    notifyListeners();
  }

  void _setConn(ConnState s, String? err) {
    conn = s;
    // Shown in the connection banner: never let a request URL's token ride
    // along in exception text.
    connError = err == null ? null : redactSecrets(err);
    _updateMenuBar();
    notifyListeners();
  }

  // ── Offline snapshot (instant cold-start) ─────────────────────────────────

  /// Restore last-known chats + recent messages so the app renders content
  /// immediately on launch, before (or without) a bridge connection. The
  /// live connect replaces everything with authoritative server state.
  void _hydrateFromSnapshot() {
    final snap = prefs.snapshot;
    if (snap == null) return;
    _hydrateFrom(snap);
  }

  /// Hydrate from a snapshot released after construction — the app lock's
  /// sealed snapshot, opened on the first unlock. Ignored once live data has
  /// arrived (the connection keeps running while locked, and the bridge is
  /// authoritative and newer).
  void restoreSnapshot(Map<String, dynamic> snap) {
    if (_disposed || chats.isNotEmpty) return;
    _hydrateFrom(snap);
    notifyListeners();
  }

  void _hydrateFrom(Map<String, dynamic> snap) {
    try {
      final rawChats = snap['chats'];
      if (rawChats is List) {
        chats.addAll(
          rawChats
              .map(_map)
              .whereType<Map<String, dynamic>>()
              .map(ClientChat.fromJson),
        );
      }
      final rawMessages = snap['messages'];
      if (rawMessages is Map) {
        rawMessages.forEach((chatId, list) {
          if (list is List) {
            _messages['$chatId'] = list
                .map(_map)
                .whereType<Map<String, dynamic>>()
                .map(ClientMessage.fromJson)
                .toList()
              // Snapshots written before the merge fix can hold rows out of
              // order; restoring them sorted heals those chats.
              ..sort(compareMessageOrder);
          }
        });
      }
      _sortChats();
      _reconcileSelection();
      AppLog.info('app_state', 'hydrated ${chats.length} chats from snapshot');
    } catch (e) {
      AppLog.warn('app_state', 'snapshot hydration failed', e);
    }
  }

  /// Debounced persist of a bounded snapshot (all chats, last 30 messages
  /// each, system notes excluded — they're transient).
  void _scheduleSnapshotSave() {
    if (_disposed || _snapshotTimer != null) return;
    _snapshotTimer = Timer(const Duration(seconds: 2), () {
      _snapshotTimer = null;
      if (_disposed) return;
      _saveSnapshot();
    });
  }

  Future<void> _saveSnapshot() async {
    final snapshot = <String, dynamic>{
      'chats': chats.map((c) => c.toSnapshotJson()).toList(),
      'messages': {
        for (final entry in _messages.entries)
          entry.key: entry.value
              .where((m) => m.role != Role.system)
              .toList()
              .reversed
              .take(30)
              .toList()
              .reversed
              .map((m) => m.toSnapshotJson())
              .toList(),
      },
    };
    // Encoded and written off the UI isolate, to its own file (Prefs).
    await prefs.saveSnapshot(snapshot);
  }

  /// Flush the offline snapshot immediately and await completion (for clean
  /// termination / exit without truncation or loss).
  Future<void> flushSnapshot() async {
    if (_disposed) return;
    _snapshotTimer?.cancel();
    _snapshotTimer = null;
    await _saveSnapshot();
  }

  /// Write the offline snapshot now (app paused/hidden), instead of waiting
  /// for the debounce.
  void persistSnapshot() {
    unawaited(flushSnapshot());
  }

  @override
  void notifyListeners() {
    // In-flight async work (history fetches, reconnects) can complete after
    // dispose; notifying then is an assertion error, so drop it quietly.
    if (_disposed) return;
    super.notifyListeners();
    // No snapshot save here: this used to arm one on every notify — every
    // streamed token — and re-encode every chat on the UI isolate every 2 s
    // during activity. Saves now follow the events that change what the
    // snapshot holds (see _snapshotKinds), history loads, and app pause.
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /// Render a conversation as portable markdown (for copy/share).
  String exportMarkdown(String chatId) {
    final chat = _chatById(chatId);
    final buf = StringBuffer('# ${chat?.title ?? 'Talon chat'}\n\n');
    for (final m in messagesFor(chatId)) {
      if (m.role == Role.system) continue;
      final who = m.role == Role.user ? 'User' : status.botName;
      final when = m.time.toLocal().toString().split('.').first;
      buf
        ..writeln('**$who** — $when')
        ..writeln()
        ..writeln(m.text.trim())
        ..writeln();
    }
    return buf.toString();
  }

  static String? _string(Object? value) {
    if (value == null) return null;
    if (value is String) return value;
    return value.toString();
  }

  static Map<String, dynamic>? _map(Object? value) =>
      value is Map ? value.cast<String, dynamic>() : null;

  static List<dynamic> _list(Object? value) =>
      value is List ? value : const <dynamic>[];

  /// Highest server-assigned (numeric) id in [msgs], or null if none.
  static int? _maxServerId(List<ClientMessage> msgs) {
    int? max;
    for (final m in msgs) {
      final n = int.tryParse(m.id);
      if (n != null && (max == null || n > max)) max = n;
    }
    return max;
  }

  bool _uiStreamPaused = false;

  /// Whether the UI isolate's streaming connection is currently paused while
  /// running in the background.
  bool get uiStreamPaused => _uiStreamPaused;

  /// Pause the UI isolate's streaming connection when the app is placed in
  /// the background on Android, avoiding redundant network traffic and battery
  /// drain while the foreground service maintains notifications and mesh connectivity.
  void pauseUiStream() {
    if (_uiStreamPaused || _disposed) return;
    _uiStreamPaused = true;
    _reconnect?.cancel();
    _reconnect = null;
    _sub?.cancel();
    _sub = null;
    _client?.dispose();
    _client = null;
    _setConn(ConnState.idle, null);
    AppLog.info('app_state', 'UI stream paused for background battery savings');
  }

  /// Resume the UI isolate's connection when the app returns to the foreground.
  void resumeUiStream() {
    if (!_uiStreamPaused || _disposed) return;
    _uiStreamPaused = false;
    AppLog.info('app_state', 'UI stream resuming from background');
    unawaited(start());
  }

  @override
  void dispose() {
    _disposed = true;
    _uiStreamPaused = false;
    _reconnect?.cancel();
    _networkDebounce?.cancel();
    _networkWatch?.cancel();
    _snapshotTimer?.cancel();
    for (final t in _continuingTimers.values) {
      t.cancel();
    }
    _continuingTimers.clear();
    _sub?.cancel();
    _mesh?.stop();
    _updates?.dispose();
    _client?.dispose();
    super.dispose();
  }
}
