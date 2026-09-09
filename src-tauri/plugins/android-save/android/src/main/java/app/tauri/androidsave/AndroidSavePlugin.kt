package app.tauri.androidsave

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

@InvokeArg
class SaveArgs {
    lateinit var fileName: String
    lateinit var mimeType: String
    lateinit var base64: String
    /** Open the saved file in a viewer afterwards (used by Print). */
    var openAfterSave: Boolean = false
}

@InvokeArg
class PrintArgs {
    lateinit var fileName: String
    lateinit var base64: String
}

@InvokeArg
class SecureSetArgs {
    lateinit var key: String
    lateinit var value: String
}

@InvokeArg
class SecureKeyArgs {
    lateinit var key: String
}

@TauriPlugin
class AndroidSavePlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Writes the bytes into the device's public Downloads folder.
     *
     * API 29+ : MediaStore.Downloads insert + OutputStream (no permission needed,
     *           and unlike direct filesystem writes it is not silently blocked,
     *           which is what left 0-byte files behind).
     * API 24-28: legacy direct write to the public Downloads directory.
     */
    @Command
    fun saveToDownloads(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveArgs::class.java)
            val bytes = Base64.decode(args.base64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                invoke.reject("refusing to save an empty file")
                return
            }

            val uriString: String
            var written = 0L

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val resolver = activity.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, args.fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, args.mimeType)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: run {
                        invoke.reject("MediaStore refused to create the file")
                        return
                    }
                resolver.openOutputStream(uri)?.use { out ->
                    out.write(bytes)
                    out.flush()
                    written = bytes.size.toLong()
                } ?: run {
                    resolver.delete(uri, null, null)
                    invoke.reject("could not open an output stream for the new file")
                    return
                }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                uriString = uri.toString()

                if (args.openAfterSave) openUri(uri.toString(), args.mimeType, false)
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS
                )
                if (!dir.exists()) {
                    dir.mkdirs()
                }
                val file = File(dir, args.fileName)
                file.outputStream().use { out ->
                    out.write(bytes)
                    out.flush()
                }
                written = bytes.size.toLong()
                uriString = Uri.fromFile(file).toString()

                if (args.openAfterSave) openFile(file, args.mimeType)
            }

            val result = JSObject()
            result.put("uri", uriString)
            result.put("bytesWritten", written)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("failed to save file: ${e.message}")
        }
    }

    /**
     * Hands the already-rendered PDF to Android's own print framework, which
     * opens the system print dialog (printer picker, copies, page range,
     * "Save as PDF", plus any installed Wi-Fi/Bluetooth/cloud print service).
     *
     * The PDF is already fully rendered on the JS side (jsPDF) — this adapter
     * doesn't lay anything out itself, it just hands the fixed byte content to
     * whatever destination the user picks in `onWrite`, which is the standard
     * way to print a pre-built PDF via `PrintManager`.
     */
    @Command
    fun printPdf(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(PrintArgs::class.java)
            val bytes = Base64.decode(args.base64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                invoke.reject("refusing to print an empty file")
                return
            }

            val printManager = activity.getSystemService(Activity.PRINT_SERVICE) as? PrintManager
            if (printManager == null) {
                invoke.reject("no printing support: PRINT_SERVICE unavailable")
                return
            }

            val jobName = args.fileName.removeSuffix(".pdf").ifBlank { "Receipt" }

            // PrintManager.print() creates a Handler bound to the *calling*
            // thread's Looper and shows the print dialog, so it must run on
            // the UI thread. Tauri dispatches plugin commands on the WebView
            // bridge thread, which has no Looper prepared — calling print()
            // straight from here throws ("Can't create handler inside thread
            // ... that has not called Looper.prepare()"), the catch below
            // rejects, and the app falls back to save-and-open, so the print
            // dialog never appears. Hopping to the UI thread is what actually
            // makes the printer picker open.
            activity.runOnUiThread {
                try {
                    printManager.print(jobName, PdfPrintAdapter(jobName, bytes), null)

                    // `print()` only opens the system dialog — it doesn't block
                    // until the user finishes picking a printer/copies, so
                    // "resolved" here means "the dialog was shown", matching how
                    // the TS caller reads a resolved invoke as `{ printed: true }`.
                    val result = JSObject()
                    result.put("printed", true)
                    invoke.resolve(result)
                } catch (e: Exception) {
                    invoke.reject("failed to print file: ${e.message}")
                }
            }
        } catch (e: Exception) {
            invoke.reject("failed to print file: ${e.message}")
        }
    }

    /**
     * Serves a fixed, already-rendered PDF to whatever destination
     * `PrintManager` hands it (the physical printer, "Save as PDF", etc).
     * No layout work happens here — the byte content never changes per
     * print attributes, so `onLayout` always reports one unpaginated
     * document and `onWrite` just copies the bytes to the given fd.
     */
    private class PdfPrintAdapter(
        private val jobName: String,
        private val bytes: ByteArray,
    ) : PrintDocumentAdapter() {
        override fun onLayout(
            oldAttributes: PrintAttributes?,
            newAttributes: PrintAttributes?,
            cancellationSignal: CancellationSignal?,
            callback: LayoutResultCallback?,
            extras: Bundle?,
        ) {
            if (cancellationSignal?.isCanceled == true) {
                callback?.onLayoutCancelled()
                return
            }
            val info = PrintDocumentInfo.Builder(jobName)
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                .build()
            // Second arg reports "layout hasn't changed since last time" —
            // always false here since layout is only ever computed once.
            callback?.onLayoutFinished(info, false)
        }

        override fun onWrite(
            pages: Array<out PageRange>?,
            destination: ParcelFileDescriptor?,
            cancellationSignal: CancellationSignal?,
            callback: WriteResultCallback?,
        ) {
            if (destination == null) {
                callback?.onWriteFailed("no destination for the print job")
                return
            }
            try {
                FileOutputStream(destination.fileDescriptor).use { out ->
                    out.write(bytes)
                    out.flush()
                }
                callback?.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
            } catch (e: IOException) {
                callback?.onWriteFailed(e.message)
            }
        }
    }

    @Command
    fun secureSet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureSetArgs::class.java)
            if (!isAllowedSecureKey(args.key)) {
                invoke.reject("unknown secure store key: ${args.key}")
                return
            }
            securePrefs.edit().putString(args.key, args.value).apply()
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject("failed to store secure value: ${e.message}")
        }
    }

    @Command
    fun secureGet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureKeyArgs::class.java)
            if (!isAllowedSecureKey(args.key)) {
                invoke.reject("unknown secure store key: ${args.key}")
                return
            }
            val result = JSObject()
            result.put("value", securePrefs.getString(args.key, null))
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("failed to read secure value: ${e.message}")
        }
    }

    @Command
    fun secureDelete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureKeyArgs::class.java)
            if (!isAllowedSecureKey(args.key)) {
                invoke.reject("unknown secure store key: ${args.key}")
                return
            }
            securePrefs.edit().remove(args.key).apply()
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject("failed to delete secure value: ${e.message}")
        }
    }

    /**
     * Fixed allowlist of keys the secure store will read/write, rather than
     * trusting an arbitrary caller-supplied name (see `android-secure-store.ts`).
     */
    private fun isAllowedSecureKey(key: String): Boolean =
        key == "telegram-backup-token" || key == "backup-passphrase"

    private val securePrefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(activity)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            activity,
            "android_save_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /**
     * Opens a URI directly. Used for the MediaStore `content://` URI on
     * API 29+, which already grants the receiving app read access without
     * needing a FileProvider.
     */
    private fun openUri(uriString: String, mimeType: String, grantPermission: Boolean) {
        try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(Uri.parse(uriString), mimeType)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (grantPermission) {
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            }
            if (intent.resolveActivity(activity.packageManager) != null) {
                activity.startActivity(intent)
            }
        } catch (e: Exception) {
            // Opening is best-effort — the save itself already succeeded.
        }
    }

    /**
     * Opens a file saved via the legacy (API <= 28) path. Wraps it in a
     * FileProvider `content://` URI so the receiving app can read it without
     * sharing storage permissions; falls back to a bare `file://` URI if the
     * provider isn't set up correctly.
     */
    private fun openFile(file: File, mimeType: String) {
        try {
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.androidsave.fileprovider",
                file
            )
            openUri(uri.toString(), mimeType, true)
        } catch (e: Exception) {
            openUri(Uri.fromFile(file).toString(), mimeType, false)
        }
    }
}