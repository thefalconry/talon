package org.talon.companion

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * Opens a downloaded chat attachment with whatever app handles its type.
 *
 * Dart (`AttachmentOpener`) fetches the file with the bridge's Authorization
 * header into `cacheDir/attachments/`, then calls:
 *   - openFile {path, mimeType} → ACTION_VIEW through the app's FileProvider
 *                                 (the `talon-attachments` path). A raw
 *                                 file:// URI would throw
 *                                 FileUriExposedException on N+.
 *
 * Returns false when the file is missing or no installed app handles it, so
 * Dart can say so instead of failing silently.
 */
class FileOpenBridge(channel: MethodChannel, private val context: Context) :
    MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "talon/files"
        private const val TAG = "TalonFiles"
    }

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "openFile" -> {
                val path = call.argument<String>("path")
                if (path.isNullOrEmpty()) {
                    result.error("no-path", "No file path given.", null)
                } else {
                    result.success(openFile(path, call.argument<String>("mimeType")))
                }
            }
            else -> result.notImplemented()
        }
    }

    private fun openFile(path: String, mimeType: String?): Boolean = try {
        val file = File(path)
        if (!file.isFile) {
            Log.w(TAG, "no file at the given path")
            false
        } else {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.updates",
                file,
            )
            val type = if (mimeType.isNullOrBlank()) "*/*" else mimeType
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, type)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }
    } catch (e: ActivityNotFoundException) {
        Log.w(TAG, "no app handles this attachment type")
        false
    } catch (e: Exception) {
        Log.w(TAG, "could not open the attachment", e)
        false
    }
}
