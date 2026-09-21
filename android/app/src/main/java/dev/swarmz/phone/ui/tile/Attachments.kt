package dev.swarmz.phone.ui.tile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.components.QuietButton
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw
import java.io.ByteArrayOutputStream

/** One chip per attachment above the composer (phone attachments spec §4.3). */
@Composable
fun AttachmentChips(items: List<Attachment>, onRetry: (Long) -> Unit, onRemove: (Long) -> Unit) {
    if (items.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items.forEach { a ->
            Row(Modifier.fillMaxWidth().testTag("attachment-${a.id}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    val status = when (val s = a.state) {
                        is AttachState.Uploading -> "sending · ${percent(s.sent, a.size)}%"
                        is AttachState.Done -> "sent"
                        is AttachState.Failed -> s.message
                    }
                    Text("${a.name} · $status", style = MonoSmall, maxLines = 1, color = if (a.state is AttachState.Failed) Sw.ErrorLine else Sw.Body)
                    (a.state as? AttachState.Uploading)?.let { LinearProgressIndicator(progress = { fraction(it.sent, a.size) }, modifier = Modifier.fillMaxWidth()) }
                }
                if (a.state is AttachState.Failed) QuietButton("Retry", { onRetry(a.id) })
                QuietButton("✕", { onRemove(a.id) })
            }
        }
    }
}

internal fun fraction(sent: Long, size: Long): Float = if (size <= 0) 1f else (sent.toFloat() / size).coerceIn(0f, 1f)
internal fun percent(sent: Long, size: Long): Int = (fraction(sent, size) * 100).toInt()

/** A file read from a content URI: its display name and bytes, fitted under [MAX_ATTACHMENT] when it is an image. */
data class Picked(val name: String, val bytes: ByteArray)

/**
 * Reads a picked or shared item (spec §4.3): the display name from the resolver, the bytes in full; an image over
 * the limit is re-encoded as JPEG, halving its long side until it fits; anything else over it is refused.
 */
fun readPicked(context: Context, uri: Uri): Result<Picked> = runCatching {
    val resolver = context.contentResolver
    var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (i >= 0 && c.moveToFirst()) c.getString(i)?.let { name = it }
    }
    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("could not read $name")
    val mime = resolver.getType(uri) ?: ""
    if (bytes.size > MAX_ATTACHMENT) {
        if (!mime.startsWith("image/")) error("too large (limit 25 MiB)")
        Picked(name.substringBeforeLast('.') + ".jpg", shrinkImage(bytes) ?: error("too large (limit 25 MiB)"))
    } else {
        Picked(name, bytes)
    }
}

/** JPEG at quality 85, halving the long side until under the limit; null when even a small one does not fit. */
internal fun shrinkImage(bytes: ByteArray): ByteArray? {
    var sample = 2
    while (sample <= 64) {
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
        bitmap.recycle()
        if (out.size() <= MAX_ATTACHMENT) return out.toByteArray()
        sample *= 2
    }
    return null
}
