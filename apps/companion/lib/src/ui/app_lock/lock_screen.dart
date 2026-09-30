import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../security/app_lock/app_lock_controller.dart';
import '../../theme.dart';
import '../brand.dart';

/// The lock screen's canvas: the palette's backdrop gradient with one soft,
/// static accent bloom — the look of a blurred screenshot, painted once.
///
/// Deliberately *not* a live BackdropFilter over the animated ambient glow
/// (#1058): the app underneath is offstage with its tickers stopped while
/// locked, so the lock screen costs one static paint, not a blur per frame.
class LockBackdrop extends StatelessWidget {
  final Widget? child;
  const LockBackdrop({super.key, this.child});

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(gradient: TalonColors.backdrop),
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: const Alignment(-0.55, -0.75),
            radius: 1.25,
            colors: [
              TalonColors.accent.withValues(alpha: 0.22),
              TalonColors.accent.withValues(alpha: 0.0),
            ],
          ),
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              center: const Alignment(0.8, 0.9),
              radius: 1.1,
              colors: [
                TalonColors.accent2.withValues(alpha: 0.16),
                TalonColors.accent2.withValues(alpha: 0.0),
              ],
            ),
          ),
          child: child ?? const SizedBox.expand(),
        ),
      ),
    );
  }
}

/// What the app-switcher / recents thumbnail shows while the app lock is on
/// and the app is leaving the foreground: the backdrop and the mark, no
/// content.
class PrivacyCover extends StatelessWidget {
  const PrivacyCover({super.key});

  @override
  Widget build(BuildContext context) {
    return const LockBackdrop(child: Center(child: BrandMark(size: 64)));
  }
}

/// The unlock (and command-approval) surface. Rendered by AppLockGate above
/// the whole navigator, so no route — a dialog, a pairing prompt, voice mode —
/// can sit on top of it.
class LockScreen extends StatefulWidget {
  final AppLockController controller;
  const LockScreen({super.key, required this.controller});

  static const Key passcodeFieldKey = ValueKey('app-lock-passcode');
  static const Key submitKey = ValueKey('app-lock-submit');
  static const Key biometricsKey = ValueKey('app-lock-biometrics');
  static const Key denyKey = ValueKey('app-lock-deny');
  static const Key forgotKey = ValueKey('app-lock-forgot');
  static const Key resetConfirmKey = ValueKey('app-lock-reset-confirm');
  static const Key retryKey = ValueKey('app-lock-retry');

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  final _field = TextEditingController();
  final _focus = FocusNode();
  String? _message;
  Duration _wait = Duration.zero;
  Timer? _countdown;
  bool _confirmReset = false;
  bool _autoPrompted = false;

  AppLockController get _c => widget.controller;

  @override
  void initState() {
    super.initState();
    _c.addListener(_onController);
    final wait = _c.retryAfter;
    if (wait > Duration.zero) {
      _wait = wait;
      _runCountdown();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _focus.requestFocus();
      _maybeAutoBiometrics();
    });
  }

  @override
  void dispose() {
    _c.removeListener(_onController);
    _countdown?.cancel();
    _field.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onController() {
    if (!mounted) return;
    setState(() {});
    _maybeAutoBiometrics();
  }

  /// Offer biometrics once per appearance, without making anyone tap for it.
  void _maybeAutoBiometrics() {
    if (_autoPrompted || !_c.ready || !_c.locked) return;
    if (!_c.biometricsEnabled || !_c.biometricsAvailable) return;
    _autoPrompted = true;
    unawaited(_biometrics());
  }

  void _startCountdown(Duration wait) {
    setState(() => _wait = wait);
    _runCountdown();
  }

  /// Once a second, and only while a wait is actually running.
  void _runCountdown() {
    _countdown?.cancel();
    _countdown = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      final left = _c.retryAfter;
      setState(() => _wait = left);
      if (left == Duration.zero) t.cancel();
    });
  }

  Future<void> _submit() async {
    final passcode = _field.text;
    if (passcode.isEmpty || _c.verifying || _wait > Duration.zero) return;
    final approving = _c.pendingApproval != null;
    final result = approving
        ? await _c.approveWithPasscode(passcode)
        : await _c.unlockWithPasscode(passcode);
    if (!mounted) return;
    _field.clear();
    switch (result.outcome) {
      case UnlockOutcome.success:
        setState(() => _message = null);
      case UnlockOutcome.wrongPasscode:
        final left = result.attemptsLeft;
        setState(() {
          _message = left == null
              ? 'Wrong passcode.'
              : 'Wrong passcode. $left '
                  '${left == 1 ? 'attempt' : 'attempts'} left before this '
                  "device's connection is erased.";
        });
        if (result.retryAfter > Duration.zero) {
          _startCountdown(result.retryAfter);
        }
      case UnlockOutcome.throttled:
        _startCountdown(result.retryAfter);
      case UnlockOutcome.wiped:
        setState(() => _message = 'Too many attempts — the connection was '
            'erased. Pair this device again.');
      case UnlockOutcome.busy:
        break;
      case UnlockOutcome.unavailable:
        setState(() => _message = 'The app lock is still loading.');
    }
    if (mounted) _focus.requestFocus();
  }

  Future<void> _biometrics() async {
    final approving = _c.pendingApproval != null;
    final ok = approving
        ? await _c.approveWithBiometrics()
        : await _c.unlockWithBiometrics();
    if (!mounted || ok) return;
    setState(() => _message = '${_c.biometricsLabel} didn’t unlock — '
        'use your passcode.');
  }

  Future<void> _reset() async {
    await _c.reset(wipeConnection: true);
  }

  @override
  Widget build(BuildContext context) {
    final pending = _c.pendingApproval;
    final approving = pending != null;
    final waiting = _wait > Duration.zero;
    final busy = _c.verifying;
    final title = approving ? 'Approve device command?' : 'Talon is locked';

    final Widget body;
    if (!_c.ready) {
      body = const Padding(
        padding: EdgeInsets.all(24),
        child: SizedBox.square(
          dimension: 28,
          child: CircularProgressIndicator(strokeWidth: 2.5),
        ),
      );
    } else if (_c.storeError) {
      body = _resetPanel(
        'Talon couldn’t read its app lock from the system keychain. If the '
        'system asked whether Talon may use its saved data and it was '
        'dismissed or denied, try again and choose Always Allow.\n\n'
        'If that doesn’t work, resetting erases the cached chats and this '
        'device’s connection; you’ll pair it again.',
        onRetry: _c.retryLoad,
      );
    } else if (_confirmReset) {
      body = _resetPanel(
        'Forgetting the passcode resets the lock, erases the cached chats and '
        'this device’s connection. You’ll need to pair it with Talon '
        'again.',
        cancellable: true,
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_c.recovering) ...[
            Text(
              'Talon couldn’t open its keychain entry (this happens after '
              'some updates). Enter your passcode to restore it.',
              textAlign: TextAlign.center,
              style: TextStyle(color: TalonColors.textDim, height: 1.4),
            ),
            const SizedBox(height: 14),
          ],
          TextField(
            key: LockScreen.passcodeFieldKey,
            controller: _field,
            focusNode: _focus,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            enabled: !waiting,
            keyboardType: _c.numericPasscode
                ? TextInputType.number
                : TextInputType.visiblePassword,
            inputFormatters: _c.numericPasscode
                ? [FilteringTextInputFormatter.digitsOnly]
                : null,
            textInputAction: TextInputAction.go,
            onSubmitted: (_) => _submit(),
            decoration: InputDecoration(
              labelText: 'Passcode',
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
              ),
            ),
          ),
          const SizedBox(height: 10),
          if (waiting)
            Text(
              'Try again in ${_wait.inSeconds + (_wait.inMilliseconds % 1000 > 0 ? 1 : 0)}s',
              textAlign: TextAlign.center,
              style: TextStyle(color: TalonColors.warn, fontSize: 13),
            )
          else if (_message != null)
            Text(
              _message!,
              textAlign: TextAlign.center,
              style: TextStyle(color: TalonColors.bad, fontSize: 13),
            ),
          const SizedBox(height: 14),
          FilledButton(
            key: LockScreen.submitKey,
            onPressed: waiting || busy ? null : _submit,
            child: busy
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(approving ? 'Approve' : 'Unlock'),
          ),
          if (_c.biometricsEnabled && _c.biometricsAvailable) ...[
            const SizedBox(height: 6),
            TextButton.icon(
              key: LockScreen.biometricsKey,
              onPressed: busy ? null : _biometrics,
              icon: const Icon(Icons.fingerprint),
              label: Text('Use ${_c.biometricsLabel}'),
            ),
          ],
          if (approving) ...[
            const SizedBox(height: 6),
            TextButton(
              key: LockScreen.denyKey,
              onPressed: _c.denyPending,
              child: const Text('Deny'),
            ),
          ] else ...[
            const SizedBox(height: 6),
            TextButton(
              key: LockScreen.forgotKey,
              onPressed: () => setState(() => _confirmReset = true),
              child: const Text('Forgot passcode?'),
            ),
          ],
        ],
      );
    }

    return Material(
      type: MaterialType.transparency,
      child: LockBackdrop(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 360),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Center(child: BrandMark(size: 56)),
                    const SizedBox(height: 18),
                    Text(
                      title,
                      textAlign: TextAlign.center,
                      style: TalonType.title,
                    ),
                    if (pending != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        'The connected Talon wants to run '
                        '“${pending.command}” on this device. '
                        'Approving allows device commands for the next '
                        '${AppLockController.approvalWindow.inMinutes} minutes.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: TalonColors.textDim),
                      ),
                    ],
                    const SizedBox(height: 22),
                    body,
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _resetPanel(
    String explanation, {
    bool cancellable = false,
    Future<void> Function()? onRetry,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          explanation,
          textAlign: TextAlign.center,
          style: TextStyle(color: TalonColors.textDim, height: 1.4),
        ),
        const SizedBox(height: 16),
        if (onRetry != null) ...[
          FilledButton(
            key: LockScreen.retryKey,
            onPressed: () => unawaited(onRetry()),
            child: const Text('Try again'),
          ),
          const SizedBox(height: 8),
        ],
        FilledButton(
          key: LockScreen.resetConfirmKey,
          style: FilledButton.styleFrom(backgroundColor: TalonColors.bad),
          onPressed: _reset,
          child: const Text('Reset and erase'),
        ),
        if (cancellable)
          TextButton(
            onPressed: () => setState(() => _confirmReset = false),
            child: const Text('Cancel'),
          ),
      ],
    );
  }
}
