package org.talon.companion

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * `talon/wake`: a CPU wake lock (plus a Wi-Fi lock) held only while a mesh
 * command or file transfer is actually running.
 *
 * The foreground service used to hold flutter_foreground_task's
 * allowWakeLock/allowWifiLock for its whole lifetime, so with mesh sharing on
 * the SoC and radio could never sleep (#1060). An open socket in a foreground
 * service doesn't need a held lock to *receive* — incoming packets wake the
 * CPU — but a command in flight (a shell, a multi-megabyte transfer) must not
 * be suspended halfway. The Dart side (CommandWakeLock) acquires on the first
 * concurrent command and releases after the last; both locks also carry a
 * timeout so a dead isolate can never pin them.
 */
class WakeBridge(channel: MethodChannel, context: Context) :
    MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "talon/wake"
        private const val TAG = "talon:mesh-command"
        private const val DEFAULT_TIMEOUT_MS = 10 * 60 * 1000L
    }

    private val appContext = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val releaseWifi = Runnable { releaseWifiLock() }

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "acquire" -> {
                val timeout =
                    call.argument<Number>("timeoutMs")?.toLong() ?: DEFAULT_TIMEOUT_MS
                acquire(timeout)
                result.success(true)
            }
            "release" -> {
                release()
                result.success(true)
            }
            else -> result.notImplemented()
        }
    }

    // WIFI_MODE_FULL_HIGH_PERF is deprecated on API 34+ (it maps to the
    // low-latency mode there) but is still the right request below it.
    @Suppress("DEPRECATION")
    private fun acquire(timeoutMs: Long) {
        val power = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager
        val wake = wakeLock
            ?: power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG).apply {
                setReferenceCounted(false)
            }.also { wakeLock = it }
        // Not reference-counted: re-acquiring just extends the timeout.
        wake.acquire(timeoutMs)
        try {
            val wifiManager =
                appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val wifi = wifiLock ?: wifiManager?.createWifiLock(
                WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                TAG,
            )?.apply { setReferenceCounted(false) }?.also { wifiLock = it }
            if (wifi != null && !wifi.isHeld) wifi.acquire()
            handler.removeCallbacks(releaseWifi)
            handler.postDelayed(releaseWifi, timeoutMs)
        } catch (e: Exception) {
            // No Wi-Fi service (some head units / emulators): the CPU lock
            // alone still keeps the command running.
        }
    }

    fun release() {
        wakeLock?.let { if (it.isHeld) it.release() }
        handler.removeCallbacks(releaseWifi)
        releaseWifiLock()
    }

    private fun releaseWifiLock() {
        wifiLock?.let { if (it.isHeld) it.release() }
    }
}
