/// Settings → App lock (#1051): turn the optional passcode lock on or off,
/// biometrics, the lock timeout, the wipe-after-failures safety net, and the
/// on-device approval for mesh device-control commands.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../security/app_lock/app_lock_controller.dart';
import '../../security/app_lock/lock_record.dart';
import '../../services/log.dart';
import '../../theme.dart';
import 'settings_widgets.dart';

class AppLockCard extends StatefulWidget {
  final AppLockController controller;
  const AppLockCard({super.key, required this.controller});

  @override
  State<AppLockCard> createState() => _AppLockCardState();
}

class _AppLockCardState extends State<AppLockCard> {
  bool _busy = false;

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

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  Future<void> _run(Future<void> Function() op) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await op();
    } catch (e) {
      AppLog.warn('app_lock', 'settings change failed', e);
      _toast('Couldn\u2019t update the app lock: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _turnOn() async {
    final setup = await showDialog<_PasscodeSetup>(
      context: context,
      builder: (_) => _SetPasscodeDialog(
        title: 'Set an app passcode',
        offerBiometrics: _c.biometricsAvailable,
        biometricsLabel: _c.biometricsLabel,
      ),
    );
    if (setup == null) return;
    await _run(() async {
      await _c.enable(setup.passcode);
      if (setup.biometrics && !await _c.setBiometrics(true)) {
        _toast('${_c.biometricsLabel} wasn’t enabled — the passcode '
            'still works.');
      }
    });
  }

  Future<void> _turnOff() async {
    final passcode = await _askPasscode(
      'Turn off the app lock',
      'Enter your passcode. Cached chats are decrypted back into the normal '
          'offline cache.',
    );
    if (passcode == null) return;
    await _run(() async {
      final result = await _c.disable(passcode);
      if (!result.ok) _toast(_failure(result));
    });
  }

  Future<void> _changePasscode() async {
    final current = await _askPasscode(
      'Change passcode',
      'Enter your current passcode.',
    );
    if (current == null || !mounted) return;
    final setup = await showDialog<_PasscodeSetup>(
      context: context,
      builder: (_) => const _SetPasscodeDialog(
        title: 'New passcode',
        offerBiometrics: false,
        biometricsLabel: '',
      ),
    );
    if (setup == null) return;
    await _run(() async {
      final result = await _c.changePasscode(current, setup.passcode);
      _toast(result.ok ? 'Passcode changed.' : _failure(result));
    });
  }

  String _failure(UnlockResult r) => switch (r.outcome) {
        UnlockOutcome.wrongPasscode => 'Wrong passcode.',
        UnlockOutcome.throttled =>
          'Too many attempts — try again in ${r.retryAfter.inSeconds + 1}s.',
        UnlockOutcome.wiped => 'Too many attempts — the connection was erased.',
        _ => 'The app lock is busy — try again.',
      };

  Future<String?> _askPasscode(String title, String message) =>
      showDialog<String>(
        context: context,
        builder: (_) => _EnterPasscodeDialog(
          title: title,
          message: message,
          numeric: _c.numericPasscode,
        ),
      );

  static String _timeoutLabel(int seconds) => switch (seconds) {
        0 => 'Immediately',
        < 3600 => '${seconds ~/ 60} min',
        _ => '${seconds ~/ 3600} h',
      };

  @override
  Widget build(BuildContext context) {
    final on = _c.enabled;
    final ready = _c.ready || !on;
    return SettingsSection(
      title: 'App lock',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: settingsSwitchRow(
                  'Require a passcode',
                  'Lock the app on launch and after it has been away. Chats '
                      'cached on this device are encrypted while it’s on. '
                      'The mesh keeps running while locked.',
                  on,
                  _busy || !ready ? null : (v) => v ? _turnOn() : _turnOff(),
                ),
              ),
              if (_busy)
                const Padding(
                  padding: EdgeInsets.only(left: 8),
                  child: SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
            ],
          ),
          if (on && _c.ready) ...[
            if (_c.biometricsAvailable)
              settingsSwitchRow(
                'Unlock with ${_c.biometricsLabel}',
                'The passcode always works too.',
                _c.biometricsEnabled,
                _busy
                    ? null
                    : (v) => _run(() async {
                          final result = await _c.setBiometrics(v);
                          if (v && !result) {
                            _toast('${_c.biometricsLabel} wasn’t enabled.');
                          }
                        }),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 7),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Lock after',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                  ),
                  DropdownButton<int>(
                    alignment: AlignmentDirectional.centerEnd,
                    value: AppLockController.timeoutChoices
                            .contains(_c.timeout.inSeconds)
                        ? _c.timeout.inSeconds
                        : AppLockRecord.defaultTimeoutSeconds,
                    underline: const SizedBox.shrink(),
                    items: [
                      for (final s in AppLockController.timeoutChoices)
                        DropdownMenuItem(value: s, child: Text(_timeoutLabel(s))),
                    ],
                    onChanged: _busy
                        ? null
                        : (s) {
                            if (s != null) _run(() => _c.setTimeoutSeconds(s));
                          },
                  ),
                ],
              ),
            ),
            settingsSwitchRow(
              'Erase connection after ${AppLockController.wipeThreshold} '
                  'failed attempts',
              'Forget the bridge credentials and cached chats; the device '
                  'must be paired again.',
              _c.wipeAfter != null,
              _busy
                  ? null
                  : (v) => _run(() => _c.setWipeAfter(
                        v ? AppLockController.wipeThreshold : null,
                      )),
            ),
            settingsSwitchRow(
              'Require unlock for elevated commands',
              'Shell, file and install commands from the mesh (root and '
                  'Shizuku included) wait for your passcode or '
                  '${_c.biometricsAvailable ? _c.biometricsLabel : 'biometrics'} '
                  'on this device; one approval covers '
                  '${AppLockController.approvalWindow.inMinutes} minutes. With '
                  'the app closed they are refused.',
              _c.requireUnlockForElevated,
              _busy ? null : (v) => _run(() => _c.setRequireUnlockForElevated(v)),
            ),
            const Divider(height: 18),
            ControlButton(
              icon: Icons.password,
              label: 'Change passcode',
              subtitle: 'Needs the current one.',
              pending: false,
              onTap: _busy ? null : _changePasscode,
            ),
            ControlButton(
              icon: Icons.lock_outline,
              label: 'Lock now',
              subtitle: 'Cover the app until you unlock it again.',
              pending: false,
              onTap: _busy ? null : _c.lockNow,
            ),
          ],
        ],
      ),
    );
  }
}

class _PasscodeSetup {
  final String passcode;
  final bool biometrics;
  const _PasscodeSetup(this.passcode, this.biometrics);
}

/// New passcode, entered twice.
class _SetPasscodeDialog extends StatefulWidget {
  final String title;
  final bool offerBiometrics;
  final String biometricsLabel;
  const _SetPasscodeDialog({
    required this.title,
    required this.offerBiometrics,
    required this.biometricsLabel,
  });

  static const Key firstKey = ValueKey('app-lock-new-passcode');
  static const Key secondKey = ValueKey('app-lock-confirm-passcode');

  @override
  State<_SetPasscodeDialog> createState() => _SetPasscodeDialogState();
}

class _SetPasscodeDialogState extends State<_SetPasscodeDialog> {
  final _first = TextEditingController();
  final _second = TextEditingController();
  bool _biometrics = true;
  String? _error;

  @override
  void dispose() {
    _first.dispose();
    _second.dispose();
    super.dispose();
  }

  void _submit() {
    final problem = validatePasscode(_first.text);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    if (_first.text != _second.text) {
      setState(() => _error = 'The passcodes don’t match.');
      return;
    }
    Navigator.of(context).pop(
      _PasscodeSetup(_first.text, widget.offerBiometrics && _biometrics),
    );
  }

  @override
  Widget build(BuildContext context) {
    InputDecoration deco(String label) => InputDecoration(
          labelText: label,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        );
    return AlertDialog(
      backgroundColor: TalonColors.surface,
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'At least 6 digits, or a password. It never leaves this device '
              'and can’t be recovered — forgetting it means pairing again.',
              style: TextStyle(color: TalonColors.textDim, fontSize: 13),
            ),
            const SizedBox(height: 14),
            TextField(
              key: _SetPasscodeDialog.firstKey,
              controller: _first,
              obscureText: true,
              autofocus: true,
              autocorrect: false,
              enableSuggestions: false,
              keyboardType: TextInputType.visiblePassword,
              decoration: deco('Passcode'),
            ),
            const SizedBox(height: 10),
            TextField(
              key: _SetPasscodeDialog.secondKey,
              controller: _second,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              keyboardType: TextInputType.visiblePassword,
              decoration: deco('Repeat passcode'),
              onSubmitted: (_) => _submit(),
            ),
            if (widget.offerBiometrics)
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _biometrics,
                onChanged: (v) => setState(() => _biometrics = v),
                title: Text('Also unlock with ${widget.biometricsLabel}'),
              ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(color: TalonColors.bad)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Save')),
      ],
    );
  }
}

/// Current passcode, for turning the lock off or changing it.
class _EnterPasscodeDialog extends StatefulWidget {
  final String title;
  final String message;
  final bool numeric;
  const _EnterPasscodeDialog({
    required this.title,
    required this.message,
    required this.numeric,
  });

  @override
  State<_EnterPasscodeDialog> createState() => _EnterPasscodeDialogState();
}

class _EnterPasscodeDialogState extends State<_EnterPasscodeDialog> {
  final _field = TextEditingController();

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  void _submit() {
    if (_field.text.isEmpty) return;
    Navigator.of(context).pop(_field.text);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: TalonColors.surface,
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            widget.message,
            style: TextStyle(color: TalonColors.textDim, fontSize: 13),
          ),
          const SizedBox(height: 14),
          TextField(
            key: const ValueKey('app-lock-current-passcode'),
            controller: _field,
            obscureText: true,
            autofocus: true,
            autocorrect: false,
            enableSuggestions: false,
            keyboardType: widget.numeric
                ? TextInputType.number
                : TextInputType.visiblePassword,
            inputFormatters:
                widget.numeric ? [FilteringTextInputFormatter.digitsOnly] : null,
            decoration: InputDecoration(
              labelText: 'Passcode',
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onSubmitted: (_) => _submit(),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Continue')),
      ],
    );
  }
}
