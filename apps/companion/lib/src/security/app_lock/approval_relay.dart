import 'dart:async';

import 'package:uuid/uuid.dart';

import '../../services/prefs.dart';
import 'app_lock_controller.dart';

/// Carries "approve this device command?" between the Android background
/// mesh isolate (which receives the command) and the UI isolate (which can
/// prompt), over flutter_foreground_task's data channel.
///
/// Fail-closed at every step: no UI in front → refused; no answer within the
/// timeout (UI engine gone, prompt ignored) → refused.
class ApprovalMessages {
  ApprovalMessages._();

  static const String request = 'talon.approval.request.v1';
  static const String result = 'talon.approval.result.v1';

  static Map<String, Object> requestOf(String id, String command) =>
      {'type': request, 'id': id, 'command': command};

  static Map<String, Object> resultOf(String id, bool ok) =>
      {'type': result, 'id': id, 'ok': ok};

  static ({String id, String command})? parseRequest(Object? data) {
    if (data is! Map || data['type'] != request) return null;
    final id = data['id'];
    final command = data['command'];
    if (id is! String || command is! String) return null;
    return (id: id, command: command);
  }

  static ({String id, bool ok})? parseResult(Object? data) {
    if (data is! Map || data['type'] != result) return null;
    final id = data['id'];
    final ok = data['ok'];
    if (id is! String || ok is! bool) return null;
    return (id: id, ok: ok);
  }
}

/// Background-isolate side: asks the UI and waits for the answer.
class BackgroundCommandApprover {
  BackgroundCommandApprover({
    required this.send,
    Duration? timeout,
    String Function()? newId,
  })  : _timeout = timeout ??
            AppLockController.approvalTimeout + const Duration(seconds: 5),
        _newId = newId ?? (() => const Uuid().v4());

  /// Posts a message to the UI isolate (FlutterForegroundTask.sendDataToMain).
  final void Function(Object data) send;
  final Duration _timeout;
  final String Function() _newId;
  final Map<String, Completer<bool>> _pending = {};

  /// Same contract as [CommandApprover]: null to allow, else the refusal.
  Future<String?> approve(Prefs prefs, String command) async {
    try {
      // Written by the UI isolate; this isolate's cache may be stale.
      await prefs.reload();
    } catch (_) {
      // Stale flags at worst — the checks below still fail closed.
    }
    if (!prefs.appLockElevatedGate) return null;
    if (!prefs.uiForeground) return AppLockController.deniedInBackground;
    final id = _newId();
    final waiter = Completer<bool>();
    _pending[id] = waiter;
    try {
      send(ApprovalMessages.requestOf(id, command));
      final ok = await waiter.future.timeout(_timeout, onTimeout: () => false);
      return ok ? null : AppLockController.deniedByUser;
    } finally {
      _pending.remove(id);
    }
  }

  /// Feed every message from the UI isolate through here. Returns whether it
  /// was an approval answer.
  bool handle(Object? data) {
    final result = ApprovalMessages.parseResult(data);
    if (result == null) return false;
    final waiter = _pending.remove(result.id);
    if (waiter != null && !waiter.isCompleted) waiter.complete(result.ok);
    return true;
  }
}

/// UI-isolate side: answers background requests by prompting through the
/// [AppLockController].
class UiApprovalResponder {
  UiApprovalResponder(this.controller, {required this.reply});

  final AppLockController controller;

  /// Posts a message to the background isolate (sendDataToTask).
  final void Function(Object data) reply;

  /// Register this with FlutterForegroundTask.addTaskDataCallback.
  void onTaskData(Object data) {
    final request = ApprovalMessages.parseRequest(data);
    if (request == null) return;
    unawaited(_answer(request.id, request.command));
  }

  Future<void> _answer(String id, String command) async {
    var ok = false;
    try {
      ok = await controller.approveCommand(command) == null;
    } catch (_) {
      ok = false;
    }
    reply(ApprovalMessages.resultOf(id, ok));
  }
}
