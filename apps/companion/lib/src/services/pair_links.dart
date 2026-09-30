import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'log.dart';

/// Incoming `talon://pair` links — the last hop of the daemon's `/mesh link`.
///
/// The native side (PairBridge) holds whatever arrived until Dart asks,
/// because a cold start delivers the intent long before any of this is
/// listening. [consume] hands a link over exactly once: reapplying it on every
/// rebuild would fight whatever the user changed afterwards.
class PairLinks {
  PairLinks({MethodChannel? channel, bool Function()? isSupported})
      : _channel = channel ?? const MethodChannel('talon/pair'),
        _isSupported = isSupported ??
            (() => !kIsWeb && (Platform.isAndroid || Platform.isMacOS));

  final MethodChannel _channel;
  final bool Function() _isSupported;

  /// Android registers the `talon://pair` intent filter and macOS the URL
  /// scheme (Info.plist CFBundleURLTypes); nothing else does.
  bool get supported => _isSupported();

  /// The pending pairing link, or null when none arrived.
  Future<String?> consume() async {
    if (!supported) return null;
    try {
      return await _channel.invokeMethod<String>('consume');
    } catch (e) {
      // An older build (or an engine without the handler) has no such channel. Not an
      // error: it just means links can't arrive this way.
      AppLog.debug('pair', 'no pair-link channel', e);
      return null;
    }
  }
}
