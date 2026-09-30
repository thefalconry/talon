/// Notifications: whether a reply that lands while Talon is in the
/// background posts a system notification. Its own section (it used to sit
/// at the bottom of Appearance, where nobody looks for it). Android only —
/// the only platform that posts them — so the section is absent elsewhere.
library;

import 'package:flutter/material.dart';

import '../../services/haptics.dart';
import '../../services/mesh_background.dart';
import '../../services/message_notifications.dart';
import '../../state/app_state.dart';
import 'settings_widgets.dart';

class NotificationsCard extends StatefulWidget {
  final AppState state;
  const NotificationsCard({super.key, required this.state});

  /// Whether this platform has anything to show in the section.
  static bool get supported => debugSupported ?? MessageNotifications.supported;

  /// Lets renders and tests show the Android-only section anywhere.
  @visibleForTesting
  static bool? debugSupported;

  @override
  State<NotificationsCard> createState() => _NotificationsCardState();
}

class _NotificationsCardState extends State<NotificationsCard> {
  /// Enabling asks for POST_NOTIFICATIONS first — a toggle that reads "on"
  /// while the OS silently drops every notification is worse than no toggle.
  Future<void> _setMessageNotifications(bool v) async {
    Haptics.selection();
    if (v && !await MessageNotifications.requestPermission()) {
      if (!mounted) return;
      setState(() {});
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Notifications are blocked in Android settings'),
        ),
      );
      return;
    }
    await widget.state.prefs.setMessageNotifications(v);
    MeshForegroundController.pushUiState(messageNotifications: v);
    if (!mounted) return;
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return SettingsSection(
      title: 'Notifications',
      child: settingsSwitchRow(
        'Message notifications',
        'Notify when a reply arrives while Talon is in the background',
        widget.state.prefs.messageNotifications,
        _setMessageNotifications,
      ),
    );
  }
}
