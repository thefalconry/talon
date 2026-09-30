import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'log.dart';

/// System notifications for assistant replies that land while the app is not
/// in front of the user.
///
/// This is deliberately separate from the mesh foreground service's own
/// notification. `flutter_foreground_task` owns the persistent `talon_mesh`
/// channel (importance LOW — it must stay silent; it is the "the mesh is
/// running" chrome, not a message). It has no API for posting an ad-hoc,
/// dismissible notification, so message alerts get their own HIGH-importance
/// channel here.
///
/// Posted from the **background isolate**: the foreground service already runs
/// a full mesh with its own SSE subscription, so an assistant reply reaches the
/// device even with the UI engine dead. Before this, those events were parsed
/// and dropped — nothing surfaced.
///
/// Android only for now. iOS needs an APNs/entitlement story and desktop has
/// its own affordances (tray/menu bar), so both are no-ops here.
class MessageNotifications {
  MessageNotifications._();

  /// Distinct from the foreground service's `talon_mesh` channel.
  static const String channelId = 'talon_messages';
  static const String channelName = 'Messages';
  static const String channelDescription =
      'Assistant replies that arrive while Talon is in the background.';

  /// Longest body we put in a notification. Android truncates anyway, but a
  /// whole streamed reply in a payload is pointless weight.
  static const int _maxBody = 240;

  /// Body used instead of the reply while the app lock is on (#1051).
  static const String lockedBody = 'New reply — unlock Talon to read it.';

  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  static bool _initialized = false;

  static bool get supported => !kIsWeb && Platform.isAndroid;

  /// Create the channel + wire the tap handler. Safe to call repeatedly.
  ///
  /// [onSelect] receives the payload (the chat id) when the user taps a
  /// notification. Only the UI isolate passes one — the background isolate
  /// initialises purely to be able to post.
  static Future<void> ensureInitialized({
    void Function(String chatId)? onSelect,
  }) async {
    if (!supported || _initialized) return;
    try {
      await _plugin.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        ),
        onDidReceiveNotificationResponse: (NotificationResponse r) {
          final payload = r.payload;
          if (payload != null && payload.isNotEmpty) onSelect?.call(payload);
        },
      );
      await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(
            const AndroidNotificationChannel(
              channelId,
              channelName,
              description: channelDescription,
              importance: Importance.high,
            ),
          );
      _initialized = true;
    } catch (e) {
      AppLog.warn('notify', 'notification init failed', e);
    }
  }

  /// Ask for POST_NOTIFICATIONS (Android 13+). Returns whether notifications
  /// are allowed afterwards — the caller uses it to refuse to flip the setting
  /// on when the user denied the grant, rather than silently enabling a
  /// feature that can't fire.
  static Future<bool> requestPermission() async {
    if (!supported) return false;
    await ensureInitialized();
    final android = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    if (android == null) return false;
    try {
      if (await android.areNotificationsEnabled() ?? false) return true;
      return await android.requestNotificationsPermission() ?? false;
    } catch (e) {
      AppLog.warn('notify', 'permission request failed', e);
      return false;
    }
  }

  /// One notification slot per chat: a second reply in the same conversation
  /// replaces the first rather than stacking. Keeps a long turn (or a chatty
  /// hour) from becoming a column of notifications.
  static int _idFor(String chatId) => chatId.hashCode & 0x7fffffff;

  /// Post (or replace) the notification for [chatId].
  ///
  /// [title] is the chat's name when the isolate can resolve one; [body] is the
  /// reply text, truncated. Never throws — a failed notification must not take
  /// down the mesh loop that called it.
  static Future<void> showMessage({
    required String chatId,
    required String title,
    required String body,
  }) async {
    if (!supported) return;
    await ensureInitialized();
    if (!_initialized) return;
    final text = condense(body);
    if (text.isEmpty) return;
    try {
      await _plugin.show(
        id: _idFor(chatId),
        title: title.isEmpty ? 'Talon' : title,
        body: text,
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            channelId,
            channelName,
            channelDescription: channelDescription,
            importance: Importance.high,
            priority: Priority.high,
            // Multi-line preview when the shade is expanded — replies are
            // rarely one line.
            styleInformation: BigTextStyleInformation(text),
            // A reply that has been superseded shouldn't buzz again.
            onlyAlertOnce: true,
            autoCancel: true,
            // Reply text is conversation content: on a locked screen show
            // only that a reply arrived, not what it says.
            visibility: NotificationVisibility.private,
          ),
        ),
        payload: chatId,
      );
    } catch (e) {
      AppLog.warn('notify', 'notification post failed', e);
    }
  }

  /// Slot for the "background mesh paused" notice — outside the per-chat id
  /// space in practice (a fixed small id), so it replaces itself.
  static const int meshPausedId = 7;

  /// Post a status notice that isn't a chat reply (no payload: tapping it
  /// just opens the app). Never throws.
  static Future<void> showNotice({
    required int id,
    required String title,
    required String body,
  }) async {
    if (!supported) return;
    await ensureInitialized();
    if (!_initialized) return;
    try {
      await _plugin.show(
        id: id,
        title: title,
        body: body,
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            channelId,
            channelName,
            channelDescription: channelDescription,
            importance: Importance.defaultImportance,
            priority: Priority.defaultPriority,
            styleInformation: BigTextStyleInformation(body),
            onlyAlertOnce: true,
            autoCancel: true,
          ),
        ),
      );
    } catch (e) {
      AppLog.warn('notify', 'notice post failed', e);
    }
  }

  /// Withdraw a notice posted with [showNotice].
  static Future<void> clearNotice(int id) async {
    if (!supported) return;
    await ensureInitialized();
    if (!_initialized) return;
    try {
      await _plugin.cancel(id: id);
    } catch (_) {
      // Nothing to cancel.
    }
  }

  /// Drop the notification for a chat — called when the user opens it, so a
  /// message they have now read stops sitting in the shade.
  static Future<void> clearChat(String chatId) async {
    if (!supported || !_initialized) return;
    try {
      await _plugin.cancel(id: _idFor(chatId));
    } catch (_) {
      // Cancelling a notification that isn't there is not worth a log line.
    }
  }

  /// Collapse whitespace and clip. Markdown is left as-is: stripping it
  /// properly needs the parser, and a stray `**` reads better than a body
  /// mangled by a regex approximation.
  @visibleForTesting
  static String condense(String raw) {
    final flat = raw.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (flat.length <= _maxBody) return flat;
    return '${flat.substring(0, _maxBody - 1).trimRight()}…';
  }
}
