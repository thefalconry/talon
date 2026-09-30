import 'dart:io' show Platform;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/connection.dart';
import '../services/bridge_client.dart' show CertificateProbe;
import '../services/log.dart';
import '../services/secure_window.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'brand.dart';
import 'certificate_confirm_dialog.dart';
import 'glass.dart';

/// First-run onboarding and the Settings page for the connection profile.
///
/// Two modes: connect to a Talon on *this computer* (desktop can also launch
/// it), or to a *remote bridge* by host/IP + token — the path a phone takes to
/// reach a Talon running on your desktop or server.
class ConnectScreen extends StatefulWidget {
  final AppState state;
  final bool firstRun;
  const ConnectScreen({super.key, required this.state, required this.firstRun});

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  late bool _remote;
  late final TextEditingController _host;
  late final TextEditingController _port;
  late final TextEditingController _token;
  late final TextEditingController _localUrl;
  bool _tls = false;

  /// Imported client certificate (.p12/.pfx as base64) and its password,
  /// for servers behind a reverse proxy that demands one.
  String? _clientP12;
  String? _clientP12Password;

  /// Inline validation messages for the remote fields. Set only by [_connect];
  /// cleared as soon as the offending field is edited, so the error never
  /// outlives the mistake.
  String? _hostError;
  String? _portError;

  /// The profile from the last pasted pairing link: its fingerprint pins
  /// the bridge it names, so connecting to that same address needs no
  /// first-use confirmation.
  ConnectionConfig? _pairLink;

  /// Looking at the bridge's certificate before the token is sent.
  bool _probing = false;

  bool get _isDesktop {
    try {
      return Platform.isWindows || Platform.isMacOS || Platform.isLinux;
    } catch (_) {
      return false;
    }
  }

  @override
  void initState() {
    super.initState();
    // Shows the bridge token / pairing details: keep it out of the recents
    // thumbnail, screenshots and screen recordings (Android).
    SecureWindow.acquire();
    final c = widget.state.config;
    _remote = !c.isLoopback || !_isDesktop;
    _tls = c.tls;
    _clientP12 = c.clientP12;
    _clientP12Password = c.clientP12Password;
    _host = TextEditingController(text: c.isLoopback ? '' : c.host);
    _port = TextEditingController(text: c.port.toString());
    _token = TextEditingController(text: c.token ?? '');
    _localUrl = TextEditingController(text: c.localUrl ?? '');
    // The plain-HTTP warning follows what is typed.
    _host.addListener(_rebuild);
  }

  void _rebuild() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    SecureWindow.release();
    _host.removeListener(_rebuild);
    _host.dispose();
    _port.dispose();
    _token.dispose();
    _localUrl.dispose();
    super.dispose();
  }

  /// Checks the remote fields *before* dialling. Without this the commonest
  /// first-run mistakes — a blank host, a port outside 1-65535 — surface only
  /// as an opaque socket error after the connect attempt times out.
  bool _validate() {
    String? hostError;
    String? portError;
    if (_remote) {
      if (ConnectionConfig.parseHostInput(_host.text).host.isEmpty) {
        hostError = 'Enter the host or IP of your Talon bridge.';
      }
      // Blank is legal: it means "whatever the scheme implies" (443/80), which
      // is what a proxied bridge wants. Only a *typed* value has to be sane.
      final raw = _port.text.trim();
      if (raw.isNotEmpty) {
        final port = int.tryParse(raw);
        if (port == null || port < 1 || port > 65535) {
          portError = 'Port must be a number between 1 and 65535.';
        }
      }
    }
    if (hostError != _hostError || portError != _portError) {
      setState(() {
        _hostError = hostError;
        _portError = portError;
      });
    }
    return hostError == null && portError == null;
  }

  Future<void> _connect() async {
    if (!_validate()) return;
    var port = int.tryParse(_port.text.trim()) ?? 19880;
    final portWasTyped = _port.text.trim().isNotEmpty;
    final token = _token.text.trim();

    // Normalize whatever the user typed into the host box: strip a scheme,
    // path, or stray whitespace, and pull out an embedded `:port` or TLS hint.
    // This is what lets a reachable endpoint actually connect even when the
    // value was pasted as a full URL like https://host:19880/.
    var host = _remote ? _host.text.trim() : '127.0.0.1';
    var tls = _remote && _tls;
    if (_remote) {
      final parsed = ConnectionConfig.parseHostInput(_host.text);
      host = parsed.host;
      if (parsed.port != null) {
        port = parsed.port!;
        _port.text = port.toString();
      }
      if (parsed.tls != null) {
        tls = parsed.tls!;
        if (_tls != tls) setState(() => _tls = tls);
      }
      // A scheme with no port written after it means the scheme's own port —
      // that is what `https://mesh.example.org` says on every other client.
      // Honouring a stale 19880 left in the box here is how a proxied bridge
      // ends up dialled on the daemon port and dies the moment that port is
      // closed. A blank box falls back the same way.
      if (parsed.port == null && (parsed.tls != null || !portWasTyped)) {
        port = ConnectionConfig.defaultPortFor(tls);
        _port.text = port.toString();
      }
      if (host != _host.text.trim()) _host.text = host;
    } else {
      port = 19880;
    }

    final keepCert = _remote && tls && _clientP12 != null;
    final localUrl = _localUrl.text.trim();
    final config = ConnectionConfig(
      host: host,
      port: port,
      token: _remote && token.isNotEmpty ? token : null,
      tls: tls,
      clientP12: keepCert ? _clientP12 : null,
      clientP12Password: keepCert ? _clientP12Password : null,
      localUrl: _remote && localUrl.isNotEmpty ? localUrl : null,
      manageLocalDaemon: false,
      localAutoDiscover: !_remote && _isDesktop,
    );
    final confirmed = await _confirmCertificate(config);
    if (confirmed == null || !mounted) return;
    await widget.state.prefs.setOnboarded(true);
    await widget.state.applyConfig(confirmed);
    if (mounted && !widget.firstRun) Navigator.of(context).maybePop();
  }

  /// Trust on first use, confirmed: before a hand-typed TLS bridge that
  /// nothing has pinned gets the token, look at the certificate it presents
  /// (no token sent) and let the user compare the fingerprint. Returns the
  /// profile to apply, pinned to what the user accepted, or null when they
  /// cancelled.
  ///
  /// Skipped when the pin is already known: a pasted pairing link for the
  /// same address, or the certificate this profile already pinned. A
  /// certificate the platform already trusts (a CA-backed reverse proxy)
  /// needs no pin and no question.
  Future<ConnectionConfig?> _confirmCertificate(ConnectionConfig config) async {
    // With a LAN address the pin belongs to the bridge that address reaches.
    final target = config.localEndpoint() ?? config;
    if (!_remote || !target.tls) return config;
    final paired = _pairPinFor(target);
    if (paired != null) return config.copyWith(fingerprint: paired);

    setState(() => _probing = true);
    final CertificateProbe probe;
    try {
      probe = await widget.state.probeCertificate(target);
    } finally {
      if (mounted) setState(() => _probing = false);
    }
    if (!mounted) return null;
    final seen = probe.fingerprint;
    if (seen == null && probe.reached) return config;
    final previous = _savedPinFor(target);
    // The pin already held for this address stands: the certificate matches
    // it, or nothing answered (the pin is then enforced on connect).
    if (previous != null && (seen == previous || seen == null)) {
      return config.copyWith(fingerprint: previous);
    }
    final ok = await CertificateConfirmDialog.ask(
      context,
      address: target.baseUrl,
      fingerprint: seen,
      previous: seen == null ? null : previous,
    );
    if (!ok) {
      AppLog.info('connect', 'certificate not confirmed; nothing sent');
      return null;
    }
    return seen == null ? config : config.copyWith(fingerprint: seen);
  }

  /// The fingerprint a pasted pairing link pinned for [target]'s address.
  String? _pairPinFor(ConnectionConfig target) {
    final link = _pairLink;
    if (link == null || !link.tls) return null;
    return link.bridgeKey == target.bridgeKey ? link.fingerprint : null;
  }

  /// The pin the saved profile holds for [target]'s address, if any.
  String? _savedPinFor(ConnectionConfig target) {
    final saved = widget.state.config;
    final pinned = saved.localEndpoint() ?? saved;
    return pinned.tls && pinned.bridgeKey == target.bridgeKey
        ? saved.fingerprint
        : null;
  }

  /// A warning when the typed host is a public name or address and the
  /// connection would be plain HTTP. Advice only: connecting still works.
  String? get _plainHttpWarning {
    if (!_remote) return null;
    final parsed = ConnectionConfig.parseHostInput(_host.text);
    final host = parsed.host.toLowerCase();
    if (host.isEmpty || (parsed.tls ?? _tls)) return null;
    if (ConnectionConfig.isPrivateAddress(host)) return null;
    return 'Plain HTTP to $host: the token and your chats cross the network '
        'unencrypted. Turn on HTTPS unless this name only resolves on your '
        'own network.';
  }

  @override
  Widget build(BuildContext context) {
    final body = Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Glass(
            radius: 26,
            blur: 26,
            padding: const EdgeInsets.all(26),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const BrandMark(size: 44),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.firstRun ? 'Welcome to Talon' : 'Connection',
                            style: const TextStyle(
                                fontSize: 20, fontWeight: FontWeight.w700),
                          ),
                          Text(
                            'Connect your companion',
                            style: TextStyle(
                                color: TalonColors.textFaint, fontSize: 12.5),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 22),
                _modeToggle(),
                const SizedBox(height: 18),
                if (_remote) ..._remoteFields() else ..._localFields(),
                const SizedBox(height: 22),
                // Listen to AppState here: when pushed from Settings this
                // screen sits outside RootView's ListenableBuilder, so without
                // its own listener the error text and busy state never update.
                ListenableBuilder(
                  listenable: widget.state,
                  builder: (context, _) => Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _ConnectButton(
                        onTap: _connect,
                        busy: _probing ||
                            widget.state.conn == ConnState.connecting,
                      ),
                      if (widget.state.conn == ConnState.error &&
                          widget.state.connError != null) ...[
                        const SizedBox(height: 14),
                        Text(
                          widget.state.connError!,
                          style:
                              TextStyle(color: TalonColors.bad, fontSize: 12.5),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    if (widget.firstRun) return body;
    // Pushed route — repaint in place when the palette changes (see
    // SettingsScreen for the same pattern).
    return ValueListenableBuilder<int>(
      valueListenable: TalonTheme.revision,
      builder: (context, _, __) => TalonBackdrop(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            title: const Text('Settings'),
          ),
          body: body,
        ),
      ),
    );
  }

  Widget _modeToggle() {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: TalonColors.void0.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: TalonColors.glassStroke),
      ),
      child: Row(
        children: [
          _modeButton(
            label: 'This computer',
            icon: Icons.computer,
            selected: !_remote,
            enabled: _isDesktop,
            onTap: () => setState(() => _remote = false),
          ),
          _modeButton(
            label: 'Remote bridge',
            icon: Icons.lan_outlined,
            selected: _remote,
            enabled: true,
            onTap: () => setState(() => _remote = true),
          ),
        ],
      ),
    );
  }

  Widget _modeButton({
    required String label,
    required IconData icon,
    required bool selected,
    required bool enabled,
    required VoidCallback onTap,
  }) {
    return Expanded(
      child: Opacity(
        opacity: enabled ? 1 : 0.4,
        child: Semantics(
          button: true,
          enabled: enabled,
          selected: selected,
          child: GestureDetector(
            onTap: enabled ? onTap : null,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              padding: const EdgeInsets.symmetric(vertical: 11),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(11),
                gradient: selected ? TalonColors.accentGradient : null,
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon,
                      size: 16,
                      color: selected ? Colors.white : TalonColors.textDim),
                  const SizedBox(width: 7),
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: selected ? Colors.white : TalonColors.textDim,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _localFields() => [
        const _Hint(
          'Talon must be running on this computer. The app finds and connects '
          'to it automatically — no address or token needed.',
        ),
      ];

  /// Fill the form from a `talon://pair` link on the clipboard.
  ///
  /// The deep link normally arrives by tapping the pairing page's button, but
  /// that button is inert if the phone's browser hands the scheme nowhere —
  /// and on a car head unit "tap the link" is not always available at all. The
  /// values are printed on the same page, so long-pressing the link and
  /// pasting it here is the escape hatch that always works.
  Future<void> _pastePairLink() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text?.trim() ?? '';
    final link = ConnectionConfig.findPairLink(text);
    final config = link == null ? null : ConnectionConfig.fromPairLink(link);
    if (config == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            ConnectionConfig.isPairPageUrl(text)
                ? 'That is the pairing page. Open it in a browser, then use '
                    'its "Open in Talon" button or copy the talon://pair link '
                    'it shows.'
                : 'No usable talon://pair link on the clipboard.',
          ),
        ),
      );
      return;
    }
    setState(() {
      _remote = true;
      _pairLink = config;
      _host.text = config.host;
      _port.text = config.port.toString();
      _token.text = config.token ?? '';
      _tls = config.tls;
      _hostError = null;
      _portError = null;
    });
  }

  /// Import a client certificate (.p12/.pfx) for a server behind a reverse
  /// proxy that demands one — the same step Immich's app has.
  Future<void> _importCertificate() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.any,
      withData: true,
    );
    final files = result?.files ?? const <PlatformFile>[];
    final file = files.isEmpty ? null : files.first;
    final bytes = file?.bytes;
    if (file == null || bytes == null || !mounted) return;
    final password = await _askPassword(file.name);
    if (password == null || !mounted) return;
    try {
      final p12 = ConnectionConfig.importP12(bytes, password);
      setState(() {
        _clientP12 = p12;
        _clientP12Password = password;
        // A client certificate only means anything over TLS.
        _tls = true;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Certificate imported from ${file.name}.')),
      );
    } on FormatException catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.message)),
      );
    }
  }

  Future<String?> _askPassword(String fileName) {
    final controller = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Certificate password'),
        content: TextField(
          controller: controller,
          obscureText: true,
          autofocus: true,
          decoration: InputDecoration(hintText: 'Password for $fileName'),
          onSubmitted: (v) => Navigator.of(context).pop(v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(controller.text),
            child: const Text('Import'),
          ),
        ],
      ),
    );
  }

  List<Widget> _remoteFields() => [
        const _Hint(
          'Point at a Talon bridge running elsewhere — your desktop or a '
          'server. Set its host to 0.0.0.0 and a token to allow remote access.',
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: _pastePairLink,
            icon: const Icon(Icons.link, size: 16),
            label: const Text('Paste a pairing link'),
          ),
        ),
        const SizedBox(height: 6),
        _field(_host, 'Host or IP',
            hint: '192.168.1.20',
            errorText: _hostError,
            onChanged: _hostError == null
                ? null
                : (_) => setState(() => _hostError = null)),
        const SizedBox(height: 12),
        _field(_port, 'Port (optional)',
            hint: 'blank = 443 for https, 80 for http',
            number: true,
            errorText: _portError,
            onChanged: _portError == null
                ? null
                : (_) => setState(() => _portError = null)),
        const SizedBox(height: 12),
        _field(_token, 'Token', hint: 'shared secret', obscure: true),
        const SizedBox(height: 12),
        _field(_localUrl, 'Local network address (optional)',
            hint: 'https://192.168.1.20:19880 — used whenever it answers'),
        const SizedBox(height: 4),
        if (_clientP12 != null)
          Row(
            children: [
              const Expanded(
                child: _Hint(
                  'Client certificate installed — presented to servers '
                  'behind a reverse proxy that requires one.',
                ),
              ),
              TextButton(
                onPressed: () => setState(() {
                  _clientP12 = null;
                  _clientP12Password = null;
                }),
                child: const Text('Remove'),
              ),
            ],
          )
        else
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: _importCertificate,
              icon: const Icon(Icons.verified_user_outlined, size: 16),
              label: const Text('Import certificate (.p12 / .pfx)'),
            ),
          ),
        const SizedBox(height: 6),
        // Wrapped in a transparent Material: the nearest ancestor is Glass's
        // DecoratedBox, which would swallow the tile's ink splash (Flutter
        // asserts on exactly this).
        Material(
          type: MaterialType.transparency,
          child: SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            value: _tls,
            onChanged: (v) => setState(() => _tls = v),
            thumbColor: WidgetStateProperty.resolveWith((s) =>
                s.contains(WidgetState.selected) ? TalonColors.accent : null),
            title: const Text('Use HTTPS / TLS', style: TextStyle(fontSize: 14)),
            subtitle: Text(
                'On by default when the daemon binds off-loopback '
                '(its own certificate, pinned on first connect) — or turn on '
                'for a TLS reverse proxy. Auto-detected from an https:// host.',
                style: TextStyle(fontSize: 12, color: TalonColors.textFaint)),
          ),
        ),
        if (_plainHttpWarning case final warning?) ...[
          const SizedBox(height: 4),
          Row(
            key: const ValueKey('plain-http-warning'),
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.warning_amber_rounded,
                  size: 16, color: TalonColors.warn),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  warning,
                  style: TextStyle(
                      fontSize: 12.5, color: TalonColors.warn, height: 1.5),
                ),
              ),
            ],
          ),
        ],
        if (_pinnedFingerprint != null) ...[
          const SizedBox(height: 4),
          _Hint(
            'Pinned certificate ${_prettyFingerprint(_pinnedFingerprint!)}. '
            'Connecting from this screen checks the certificate again and '
            'asks before trusting a different one.',
          ),
        ],
      ];

  String? get _pinnedFingerprint => widget.state.config.fingerprint;

  /// First bytes of the pin in AA:BB:… form — enough to eyeball against the
  /// fingerprint the daemon logs, short enough for a settings row.
  static String _prettyFingerprint(String fingerprint) {
    final head = fingerprint.substring(0, 16).toUpperCase();
    final pairs = <String>[
      for (var i = 0; i < head.length; i += 2) head.substring(i, i + 2),
    ];
    return '${pairs.join(':')}…';
  }

  Widget _field(
    TextEditingController c,
    String label, {
    String? hint,
    bool number = false,
    bool obscure = false,
    bool mono = false,
    String? errorText,
    ValueChanged<String>? onChanged,
  }) {
    // The caption above the box IS the field's name, but visually — nothing
    // ties the two nodes together, so a screen reader lands on the input and
    // announces a bare "edit box". On the connect screen that leaves Host,
    // Port and Token indistinguishable on the very first screen of the app.
    // MergeSemantics folds the caption into the field's own node ("Host, edit
    // box, …") without touching the layout.
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: TextStyle(
                  fontSize: 12,
                  color: TalonColors.textDim,
                  fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          TextField(
          controller: c,
          onChanged: onChanged,
          obscureText: obscure,
          keyboardType: number ? TextInputType.number : null,
          inputFormatters:
              number ? [FilteringTextInputFormatter.digitsOnly] : null,
          style: TextStyle(
              fontSize: 14, fontFamily: mono ? 'JetBrains Mono' : null),
          decoration: InputDecoration(
            hintText: hint,
            errorText: errorText,
            errorStyle: TextStyle(fontSize: 12, color: TalonColors.bad),
            filled: true,
            fillColor: TalonColors.void0.withValues(alpha: 0.5),
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide(color: TalonColors.glassStroke),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide(color: TalonColors.glassStroke),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide(color: TalonColors.accent),
            ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);

  @override
  Widget build(BuildContext context) => Text(
        text,
        style: TextStyle(
            fontSize: 12.5, color: TalonColors.textFaint, height: 1.5),
      );
}

class _ConnectButton extends StatelessWidget {
  final VoidCallback onTap;
  final bool busy;
  const _ConnectButton({required this.onTap, this.busy = false});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: !busy,
      child: InkWell(
        onTap: busy ? null : onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            borderRadius: TalonRadius.rMd,
            gradient: TalonColors.accentGradient,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (busy)
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation(Colors.white),
                  ),
                )
              else
                const Icon(Icons.bolt, color: Colors.white, size: 19),
              const SizedBox(width: 8),
              Text(
                busy ? 'Connecting…' : 'Connect',
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w700,
                  fontSize: 15,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
