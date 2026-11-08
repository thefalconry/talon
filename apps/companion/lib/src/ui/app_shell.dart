import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/app_state.dart';
import '../theme.dart';
import 'chat_view.dart';
import 'glass.dart';
import 'quick_switcher.dart';
import 'sidebar.dart';
import 'voice_mode_screen.dart';

/// The main two-pane layout. Side-by-side on desktop/tablet; on a phone the
/// chat list is the base screen and the conversation is a real pushed route —
/// which is what makes Android's predictive back gesture animate properly
/// (an in-place pane swap guarded by PopScope can't be peeled away by the
/// system; a route can).
class AppShell extends StatefulWidget {
  final AppState state;
  const AppShell({super.key, required this.state});

  static const double _wideBreakpoint = 820;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with WidgetsBindingObserver {
  /// Last layout mode reported by the LayoutBuilder.
  bool _narrow = false;

  /// The pushed conversation route while one is open on the narrow layout.
  Route<void>? _convRoute;

  /// A sync is already scheduled for the end of this frame.
  bool _syncScheduled = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.state.addListener(_scheduleSync);
    // Route syncing pauses while voice mode covers the app; when the orb
    // closes, reconcile whatever selection changes happened during it.
    VoiceModeScreen.open.addListener(_scheduleSync);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.state.removeListener(_scheduleSync);
    VoiceModeScreen.open.removeListener(_scheduleSync);
    super.dispose();
  }

  /// While a conversation route covers this shell (narrow layout), the
  /// two-pane LayoutBuilder below is offstage and never sees a resize — so
  /// growing the window back past the breakpoint would strand the user on
  /// the pushed route with no sidebar. Watch the window metrics directly:
  /// crossing the breakpoint re-runs the route sync, which pops the
  /// conversation and lands on the two-pane layout with the chat still
  /// selected. The LayoutBuilder keeps owning the onstage transitions.
  @override
  void didChangeMetrics() {
    if (!mounted) return;
    final view = View.of(context);
    final wide = view.physicalSize.width / view.devicePixelRatio >=
        AppShell._wideBreakpoint;
    if (_narrow == !wide) return;
    widget.state.setNarrowLayout(!wide);
    _narrow = !wide;
    _scheduleSync();
  }

  /// Selection/layout changes can arrive mid-build — reconcile the navigator
  /// after the frame settles. Idempotent, so over-scheduling is harmless.
  void _scheduleSync() {
    if (_syncScheduled) return;
    _syncScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _syncScheduled = false;
      _syncConversationRoute();
    });
  }

  /// Keep the navigator in step with the app state: a selected chat on the
  /// narrow layout means a conversation route is open; no selection (or the
  /// wide layout, where the pane shows it) means it isn't.
  void _syncConversationRoute() {
    if (!mounted) return;
    // Voice mode owns the screen: a chat selected from inside the session
    // (e.g. its first send created a chat) must not push a conversation
    // route over the orb. The open-flag listener re-syncs on close.
    if (VoiceModeScreen.open.value) return;
    final wantOpen = _narrow && widget.state.selectedChatId != null;
    final route = _convRoute;
    if (wantOpen && route == null) {
      final newRoute = MaterialPageRoute<void>(
        builder: (_) => _ConversationScreen(state: widget.state),
      );
      _convRoute = newRoute;
      Navigator.of(context).push(newRoute).whenComplete(() {
        _convRoute = null;
        // Popped by the user (system back, predictive gesture, or the header
        // back button): return the list to no-selection. Guarded so a
        // programmatic pop after clearSelection doesn't double-clear.
        if (_narrow && widget.state.selectedChatId != null) {
          widget.state.clearSelection();
        }
      });
    } else if (!wantOpen && route != null) {
      // Selection vanished (chat deleted, layout went wide): close the
      // conversation. pop() when it's on top for the animation; remove it
      // in place if something (e.g. Settings) is stacked above.
      final nav = Navigator.of(context);
      if (route.isCurrent) {
        nav.pop();
      } else if (route.isActive) {
        nav.removeRoute(route);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // A Scaffold (not present anywhere above this in the tree -- RootView
    // is a Stack/Material, not a Scaffold) is what makes
    // resizeToAvoidBottomInset happen: without it, nothing shrinks for the
    // keyboard, so the message list never collapses and the Composer (in
    // ChatView, at the bottom of this subtree) doesn't get pushed up --
    // the keyboard just overlaps it. backgroundColor is transparent so
    // RootView's gradient backdrop still shows through underneath.
    return Scaffold(
      backgroundColor: Colors.transparent,
      resizeToAvoidBottomInset: true,
      // Global keyboard shortcuts: Cmd/Ctrl+K quick switcher, Cmd/Ctrl+N new
      // chat. CallbackShortcuts sees keys bubbling from any focused
      // descendant (composer included).
      body: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyK, meta: true): () =>
              openQuickSwitcher(context, widget.state),
          const SingleActivator(LogicalKeyboardKey.keyK, control: true): () =>
              openQuickSwitcher(context, widget.state),
          const SingleActivator(LogicalKeyboardKey.keyN, meta: true):
              widget.state.newChat,
          const SingleActivator(LogicalKeyboardKey.keyN, control: true):
              widget.state.newChat,
        },
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= AppShell._wideBreakpoint;
            // Let selection logic know which layout it's driving: narrow
            // treats the chat list as its own screen (no auto-selection).
            widget.state.setNarrowLayout(!wide);
            if (_narrow != !wide) {
              _narrow = !wide;
              // Crossing the breakpoint may need a route pushed or popped
              // (e.g. resizing a desktop window with a chat selected).
              _scheduleSync();
            }
            if (wide) {
              // Desktop/tablet keeps the inset two-pane card look, safely
              // inside the system insets.
              return SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 308,
                        child: Sidebar(state: widget.state, onSelect: null),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: ChatView(state: widget.state, showBack: false),
                      ),
                    ],
                  ),
                ),
              );
            }

            // Narrow: the chat list is the base screen — full-bleed on the
            // backdrop rather than a glass card inset from every edge, which
            // is a docked-pane idiom borrowed from the desktop layout and
            // spends a frame's worth of margin on a screen that IS the pane.
            // Selecting a chat pushes the conversation route (see
            // _syncConversationRoute).
            // bottom:false — the list is meant to run UNDER the navigation
            // bar (Android draws it transparent over the app), so consuming
            // the bottom inset here would stop the scroll dead at a solid
            // band. Sidebar pads its own list and floats its FAB above the
            // inset instead, which is what "edge to edge" actually means:
            // content behind the bar, targets clear of it.
            return SafeArea(
              bottom: false,
              child: Sidebar(
                state: widget.state,
                onSelect: (id) => widget.state.selectChat(id),
                mobile: true,
              ),
            );
          },
        ),
      ),
    );
  }
}

/// The phone conversation as its own route: full-bleed ChatView over the app
/// backdrop (a pushed route covers RootView's, so it paints its own), with
/// its own Scaffold for keyboard insets. Being a real route is what lets the
/// predictive back gesture peel it away to reveal the chat list.
class _ConversationScreen extends StatelessWidget {
  final AppState state;
  const _ConversationScreen({required this.state});

  @override
  Widget build(BuildContext context) {
    // Subscribe to palette changes like the Settings route — pushed routes
    // sit outside the root's theme rebuild chain.
    return ValueListenableBuilder<int>(
      valueListenable: TalonTheme.revision,
      builder: (context, _, __) => TalonBackdrop(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          resizeToAvoidBottomInset: true,
          body: CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.escape): () =>
                  Navigator.of(context).maybePop(),
            },
            child: ChatView(
              state: state,
              showBack: true,
              onBack: () => Navigator.of(context).maybePop(),
              fullBleed: true,
            ),
          ),
        ),
      ),
    );
  }
}
