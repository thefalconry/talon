import 'dart:async';

import 'package:flutter/material.dart';

import '../models/connection.dart';
import '../services/log.dart';
import '../services/pair_links.dart';
import '../state/app_state.dart';
import 'app_lock/app_lock_gate.dart';
import 'app_shell.dart';
import 'connect_screen.dart';
import 'glass.dart';
import 'pair_confirm_dialog.dart';

/// Decides between the first-run connect screen and the main app shell, and
/// paints the global backdrop + ambient glow behind everything.
///
/// Also the landing point for `talon://pair` deep links: the daemon's
/// `/mesh link` ends here, with the connection configuring itself instead of
/// someone copying a host, a port and a bearer token onto a phone keyboard.
class RootView extends StatefulWidget {
  final AppState state;
  final PairLinks? pairLinks;
  const RootView({super.key, required this.state, this.pairLinks});

  @override
  State<RootView> createState() => _RootViewState();
}

class _RootViewState extends State<RootView> with WidgetsBindingObserver {
  late final PairLinks _links = widget.pairLinks ?? PairLinks();

  /// Guards against two checks overlapping — a resume that lands while the
  /// confirmation dialog from the previous link is still open would otherwise
  /// stack a second dialog on top of it.
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    if (_links.supported) {
      WidgetsBinding.instance.addObserver(this);
      // A cold start delivers the intent before this widget exists, so the
      // first check has to happen here rather than only on resume.
      unawaited(_checkPairLink());
    }
  }

  @override
  void dispose() {
    if (_links.supported) WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Tapping the link in a browser brings the app forward with the intent
    // already delivered natively; resume is when Dart gets to hear about it.
    if (state == AppLifecycleState.resumed) unawaited(_checkPairLink());
  }

  Future<void> _checkPairLink() async {
    if (_checking) return;
    _checking = true;
    try {
      final link = await _links.consume();
      if (link == null || !mounted) return;
      final config = ConnectionConfig.fromPairLink(link);
      if (config == null) {
        AppLog.warn('pair', 'ignored an unusable pairing link');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Ignored a pairing link that does not pin its bridge.',
              ),
            ),
          );
        }
        return;
      }
      // A locked app shows nothing until it is unlocked — a pairing prompt
      // included (#1051). Hold the link until the user is back in.
      final lock = AppLockScope.peek(context);
      if (lock != null) await lock.whenUnlocked();
      if (!mounted) return;
      // Any app or web page can open a talon:// link, so it never changes
      // the connection on its own — first run included. Only an explicit
      // "Connect" in the dialog does.
      final replacing = widget.state.prefs.onboarded;
      final confirmed = await PairConfirmDialog.ask(
        context,
        config,
        replacing: replacing,
        deviceControl: widget.state.prefs.meshDeviceControlOnPairing,
      );
      if (!confirmed) {
        AppLog.info('pair', 'pairing link declined');
        return;
      }
      // Device control carries over to the new bridge unless the user
      // opted into per-pairing grants (Settings → Mesh).
      await widget.state.prefs.resetMeshGrantsForPairing();
      await widget.state.prefs.setOnboarded(true);
      await widget.state.applyConfig(config);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Paired with ${config.host}:${config.port}')),
      );
    } catch (e) {
      AppLog.warn('pair', 'pairing link failed', e);
    } finally {
      _checking = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    return TalonBackdrop(
      child: Material(
        type: MaterialType.transparency,
        child: ListenableBuilder(
          listenable: widget.state,
          builder: (context, _) {
            if (!widget.state.prefs.onboarded) {
              return ConnectScreen(state: widget.state, firstRun: true);
            }
            return AppShell(state: widget.state);
          },
        ),
      ),
    );
  }
}
