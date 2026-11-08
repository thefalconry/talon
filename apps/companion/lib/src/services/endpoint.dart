import '../models/connection.dart';
import 'bridge_client.dart';
import 'log.dart';

/// Automatic LAN ↔ internet switching — the way Immich's app does it.
///
/// A profile can carry two addresses: the one the user connects with (often
/// the reverse proxy's website address, which demands a client certificate)
/// and [ConnectionConfig.localUrl], the bridge's address on the home
/// network. Whenever the LAN address answers, it's used: faster, no trip
/// through the proxy, and no certificate needed there. Otherwise the app
/// falls back to the main address.
///
/// Immich decides by Wi-Fi name, which needs location permission and misses
/// Ethernet, VPNs and Tailscale. Asking the bridge directly — a /health probe
/// with a short deadline — answers the question that actually matters.
Future<ConnectionConfig> resolveEndpoint(
  ConnectionConfig config, {
  Duration probeTimeout = const Duration(milliseconds: 1500),
}) async {
  final local = config.localEndpoint();
  if (local == null) return config;
  final probe = BridgeClient(local);
  try {
    if (await probe.health(timeout: probeTimeout) != null) {
      AppLog.info('endpoint', 'using LAN address ${local.baseUrl}');
      return local;
    }
  } catch (e) {
    // A changed LAN certificate, a refused client certificate… whatever it
    // is, the internet address may still work — and the error resurfaces if
    // the user ever lands back on the LAN.
    AppLog.warn('endpoint', 'LAN probe failed', e);
  } finally {
    probe.dispose();
  }
  final remote = config.remoteEndpoint();
  AppLog.info('endpoint', 'using ${remote.baseUrl}');
  return remote;
}
