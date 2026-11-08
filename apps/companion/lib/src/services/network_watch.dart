import 'dart:io' show Platform;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';

/// A stable key for a connectivity reading: the set of active transports,
/// order-independent (`mobile,wifi`). Two readings with different keys mean
/// the device moved to another interface, and any socket opened on the old
/// one may now be half-open.
String networkKey(List<ConnectivityResult> results) {
  final names = results.map((r) => r.name).toSet().toList()..sort();
  return names.join(',');
}

/// Whether to subscribe to connectivity changes at all. Off under
/// `flutter test`: no plugin is registered there, and the platform event
/// channel fails its `listen` call outside any handler we could catch.
bool get connectivityWatchAvailable {
  if (kIsWeb) return true;
  try {
    return !Platform.environment.containsKey('FLUTTER_TEST');
  } catch (_) {
    return true;
  }
}
