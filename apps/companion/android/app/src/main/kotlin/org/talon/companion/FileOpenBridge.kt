package org.talon.companion

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
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
 *   - saveToDownloads {path, name, mimeType} → copies the cached file into
 *                                 the public Downloads collection through
 *                                 MediaStore (Android 10+; no storage
 *                                 permission needed) and returns
 *                                 "Download/<name>", or null when it can't.
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
            "saveToDownloads" -> {
                val path = call.argument<String>("path")
                if (path.isNullOrEmpty()) {
                    result.error("no-path", "No file path given.", null)
                } else {
                    result.success(
                        saveToDownloads(
                            path,
                            call.argument<String>("name"),
                            call.argument<String>("mimeType"),
                        ),
                    )
                }
            }
            else -> result.notImplemented()
        }
    }

    /**
     * MediaStore insert into Downloads. Before Android 10 writing there needs
     * the legacy storage permission, which the app doesn't hold — return null
     * and let Dart report it (the file can still be opened).
     */
    private fun saveToDownloads(path: String, name: String?, mimeType: String?): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val file = File(path)
        if (!file.isFile) return null
        val displayName = if (name.isNullOrBlank()) file.name else name
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(
                MediaStore.MediaColumns.MIME_TYPE,
                if (mimeType.isNullOrBlank()) "application/octet-stream" else mimeType,
            )
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = try {
            resolver.insert(collection, values)
        } catch (e: Exception) {
            Log.w(TAG, "could not create the download entry", e)
            null
        }
        if (uri == null) return null
        return try {
            resolver.openOutputStream(uri)?.use { out ->
                file.inputStream().use { it.copyTo(out) }
            } ?: throw IllegalStateException("no output stream")
            resolver.update(
                uri,
                ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
                null,
                null,
            )
            // MediaStore may have renamed it to avoid a clash ("name (1).pdf").
            val saved = resolver.query(
                uri,
                arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: displayName
            "${Environment.DIRECTORY_DOWNLOADS}/$saved"
        } catch (e: Exception) {
            Log.w(TAG, "could not save the attachment to Downloads", e)
            try {
                resolver.delete(uri, null, null)
            } catch (ignored: Exception) {
                // Best effort: a pending row is hidden and gets cleaned up.
            }
            null
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
