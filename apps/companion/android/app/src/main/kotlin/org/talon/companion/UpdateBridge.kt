package org.talon.companion

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.MessageDigest

/**
 * MethodChannel bridge for the companion's own updater — the fallback tier of
 * [org.talon.companion] self-update.
 *
 * Talon prefers to install its own APK silently through [DeviceExec]'s
 * elevated `pm install` (root or Shizuku), exactly as the daemon's remote
 * `update_device` does. Neither is available on an ordinary phone, so this
 * bridge covers the ordinary case: hand the downloaded APK to Android's own
 * package installer and let the user tap Install.
 *
 * Dart (`PlatformUpdateInstaller`) calls:
 *   - stageDir                 → where a download may be written: the app's
 *                                external files dir, which needs no storage
 *                                permission AND is readable by the shell UID,
 *                                which is what the Shizuku install path needs
 *                                (it cannot read /data/data).
 *   - canInstallPackages       → whether "install unknown apps" is granted
 *                                (always true below API 26).
 *   - requestInstallPermission → open that settings page for this package.
 *   - installApk {path}        → ACTION_VIEW the APK through the FileProvider
 *                                declared in the manifest. A raw file:// URI
 *                                would throw FileUriExposedException on N+,
 *                                so the content:// URI plus a read grant is
 *                                the only working shape.
 *   - checkSelfUpdateApk {path} → {ok, message}: the downloaded APK must be
 *                                this package and signed by the key this
 *                                install runs under (or a v3 rotation of it).
 *                                Self-update only; the mesh's install_apk
 *                                installs arbitrary apps and never asks.
 *
 * Nothing here can install anything by itself: the system dialog, the user's
 * tap, and Android's signature check on `-r` reinstall all still apply.
 */
class UpdateBridge(channel: MethodChannel, private val context: Context) :
    MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "talon/update"
        private const val TAG = "TalonUpdate"
        private const val APK_MIME = "application/vnd.android.package-archive"
    }

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "stageDir" -> result.success(stageDir().absolutePath)
            "canInstallPackages" -> result.success(canInstallPackages())
            "requestInstallPermission" -> {
                result.success(requestInstallPermission())
            }
            "installApk" -> {
                val path = call.argument<String>("path")
                if (path.isNullOrEmpty()) {
                    result.error("no-path", "No APK path given.", null)
                } else {
                    result.success(installApk(path))
                }
            }
            "checkSelfUpdateApk" -> {
                val path = call.argument<String>("path")
                if (path.isNullOrEmpty()) {
                    result.error("no-path", "No APK path given.", null)
                } else {
                    result.success(checkSelfUpdateApk(path))
                }
            }
            else -> result.notImplemented()
        }
    }

    /** `…/Android/data/<pkg>/files/updates`, created on demand. */
    private fun stageDir(): File {
        val base = context.getExternalFilesDir(null) ?: context.cacheDir
        val dir = File(base, "updates")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun canInstallPackages(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            context.packageManager.canRequestPackageInstalls()

    private fun requestInstallPermission(): Boolean = try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            false
        } else {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }
    } catch (e: Exception) {
        Log.w(TAG, "could not open the unknown-sources settings", e)
        false
    }

    /**
     * Compare the downloaded APK against the running app before anything
     * installs it: same package name, and every certificate this install is
     * currently signed with appears among the APK's signers (its v3 rotation
     * lineage included, so a legitimate key rotation still updates). Android
     * would refuse a same-package signer mismatch anyway, but only after the
     * user tapped Install, with a vague "package conflicts" error; and a
     * *different* package would install cleanly beside us. Fails closed: an
     * unreadable signer is a refusal.
     */
    private fun checkSelfUpdateApk(path: String): Map<String, Any> = try {
        val pm = context.packageManager
        val archive = packageInfo(pm, archivePath = path)
        val installed = packageInfo(pm, archivePath = null)
        val ours = installed?.let { signerDigests(it, withHistory = false) }.orEmpty()
        val theirs = archive?.let { signerDigests(it, withHistory = true) }.orEmpty()
        when {
            archive == null -> verdict(false, "The downloaded update is not a readable APK.")
            archive.packageName != context.packageName -> verdict(
                false,
                "The downloaded APK is ${archive.packageName}, not ${context.packageName} — " +
                    "refusing to install it as an update.",
            )
            ours.isEmpty() -> verdict(false, "Could not read this app's own signing certificate.")
            theirs.isEmpty() -> verdict(false, "Could not read the update's signing certificate.")
            !theirs.containsAll(ours) -> verdict(
                false,
                "The update is signed by a different key (${shortFingerprints(theirs)}) than this " +
                    "app (${shortFingerprints(ours)}) — refusing to install it. If you switched " +
                    "between a self-built and an official build, reinstall from the release page.",
            )
            else -> verdict(true, "Signer matches (${shortFingerprints(ours)}).")
        }
    } catch (e: Exception) {
        Log.w(TAG, "could not check the update's signer", e)
        verdict(false, "Could not check the update's signer: ${e.message}")
    }

    private fun verdict(ok: Boolean, message: String): Map<String, Any> =
        mapOf("ok" to ok, "message" to message)

    /** The installed package ([archivePath] null) or an APK file, with its signers. */
    @Suppress("DEPRECATION")
    private fun packageInfo(pm: PackageManager, archivePath: String?): PackageInfo? {
        // GET_SIGNATURES alongside GET_SIGNING_CERTIFICATES: some releases
        // leave signingInfo null for archives, and signatures is the fallback.
        var flags = PackageManager.GET_SIGNATURES
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            flags = flags or PackageManager.GET_SIGNING_CERTIFICATES
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val f = PackageManager.PackageInfoFlags.of(flags.toLong())
            if (archivePath == null) {
                pm.getPackageInfo(context.packageName, f)
            } else {
                pm.getPackageArchiveInfo(archivePath, f)
            }
        } else if (archivePath == null) {
            pm.getPackageInfo(context.packageName, flags)
        } else {
            pm.getPackageArchiveInfo(archivePath, flags)
        }
    }

    /**
     * SHA-256 of each signing certificate. [withHistory] includes the v3
     * rotation lineage (the older certificates the package proved it succeeds).
     */
    @Suppress("DEPRECATION")
    private fun signerDigests(info: PackageInfo, withHistory: Boolean): Set<String> {
        val signing = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo else null
        val signatures: Array<Signature>? = when {
            signing == null -> info.signatures
            signing.hasMultipleSigners() -> signing.apkContentsSigners
            withHistory -> signing.signingCertificateHistory
            else -> signing.apkContentsSigners
        }
        return signatures.orEmpty().map { sha256Hex(it.toByteArray()) }.toSet()
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun shortFingerprints(digests: Set<String>): String =
        digests.sorted().joinToString(", ") { it.take(16) }

    private fun installApk(path: String): Boolean = try {
        val apk = File(path)
        if (!apk.isFile) {
            Log.w(TAG, "no APK at the given path")
            false
        } else {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.updates",
                apk,
            )
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }
    } catch (e: Exception) {
        Log.w(TAG, "could not start the package installer", e)
        false
    }
}
