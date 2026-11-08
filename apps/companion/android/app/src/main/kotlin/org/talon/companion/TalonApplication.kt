package org.talon.companion

import android.app.Application
import com.pravera.flutter_foreground_task.FlutterForegroundTaskLifecycleListener
import com.pravera.flutter_foreground_task.FlutterForegroundTaskPlugin
import com.pravera.flutter_foreground_task.FlutterForegroundTaskStarter
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Registers the `talon/shizuku`, `talon/root` and `talon/wake` platform
 * channels on the FOREGROUND SERVICE's Flutter engine.
 *
 * The mesh loop (SSE + exec) runs inside the foreground service's own isolate
 * so teleport keeps working after the activity is gone — but that engine is
 * created by flutter_foreground_task, not by MainActivity, so
 * MainActivity.configureFlutterEngine never runs for it. Without this hook,
 * background exec would silently lose Shizuku elevation and fall back to app
 * UID. Registered from the Application (not the activity) because after a
 * reboot or a START_STICKY restart the service comes up with NO activity ever
 * having existed.
 *
 * Pub plugins (shared_preferences, geolocator, …) don't need this — the
 * FlutterEngine constructor auto-registers them via GeneratedPluginRegistrant.
 * Only this hand-rolled channel must be attached manually.
 */
class TalonApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        FlutterForegroundTaskPlugin.addTaskLifecycleListener(
            object : FlutterForegroundTaskLifecycleListener {
                private var shizuku: ShizukuBridge? = null
                private var root: RootBridge? = null
                private var wake: WakeBridge? = null

                override fun onEngineCreate(flutterEngine: FlutterEngine?) {
                    val engine = flutterEngine ?: return
                    val channel = MethodChannel(
                        engine.dartExecutor.binaryMessenger,
                        ShizukuBridge.CHANNEL,
                    )
                    shizuku = ShizukuBridge(channel, applicationContext)
                    val rootChannel = MethodChannel(
                        engine.dartExecutor.binaryMessenger,
                        RootBridge.CHANNEL,
                    )
                    root = RootBridge(rootChannel, applicationContext)
                    // Per-command wake/Wi-Fi locks for the mesh loop, which
                    // runs in this engine (#1060).
                    wake = WakeBridge(
                        MethodChannel(
                            engine.dartExecutor.binaryMessenger,
                            WakeBridge.CHANNEL,
                        ),
                        applicationContext,
                    )
                }

                override fun onTaskStart(starter: FlutterForegroundTaskStarter) {}

                override fun onTaskRepeatEvent() {}

                override fun onTaskDestroy() {}

                override fun onEngineWillDestroy() {
                    shizuku = null
                    // The su shell itself is process-wide (RootShell) and
                    // deliberately survives this — the service engine is torn
                    // down and rebuilt on restarts, and re-prompting for root
                    // each time would defeat the point.
                    root = null
                    wake?.release()
                    wake = null
                }
            },
        )
    }
}
