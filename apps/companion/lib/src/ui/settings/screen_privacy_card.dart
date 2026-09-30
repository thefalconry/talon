/// Settings → Security → Screen privacy: the "Block screenshots and screen
/// recording" switch (Android FLAG_SECURE, app-wide, applied live by the
/// AppLockGate). Defaults to on with a passcode and off without one; the
/// lock screen blocks capture whatever this says. Other platforms have no
/// equivalent, so they get one line saying so instead of a dead switch.
library;

import 'package:flutter/material.dart';

import '../../security/app_lock/app_lock_controller.dart';
import '../../services/secure_window.dart';
import '../../theme.dart';
import 'settings_widgets.dart';

class ScreenPrivacyCard extends StatefulWidget {
  final AppLockController controller;
  const ScreenPrivacyCard({super.key, required this.controller});

  @override
  State<ScreenPrivacyCard> createState() => _ScreenPrivacyCardState();
}

class _ScreenPrivacyCardState extends State<ScreenPrivacyCard> {
  AppLockController get _c => widget.controller;

  @override
  void initState() {
    super.initState();
    _c.addListener(_changed);
  }

  @override
  void dispose() {
    _c.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return SettingsSection(
      title: 'Screen privacy',
      child: SecureWindow.supported
          ? settingsSwitchRow(
              'Block screenshots and screen recording',
              'Keeps Talon out of screenshots, recordings, screen sharing '
                  'and the recents thumbnail. '
                  '${_c.blockScreenshotsIsDefault ? 'On by default while a passcode is set. ' : ''}'
                  'Always blocked while locked.',
              _c.blockScreenshots,
              (v) => _c.setBlockScreenshots(v),
            )
          : Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text(
                'Screenshot blocking is Android-only — this platform can '
                'always capture the window.',
                style: TextStyle(
                  fontSize: 12,
                  height: 1.35,
                  color: TalonColors.textFaint,
                ),
              ),
            ),
    );
  }
}
