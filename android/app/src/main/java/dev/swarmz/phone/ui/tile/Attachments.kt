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
 * Reads a picked or shared item (spec §4.3) without ever holding more than the limit in memory: the size is
 * asked for first (`OpenableColumns.SIZE`) and an oversize non-image is refused unopened; a stream of unknown
 * size is read only up to the limit. An oversize image is decoded down from its bounds and re-encoded as JPEG
 * under the limit, each pass from a fresh stream.
 */
fun readPicked(context: Context, uri: Uri): Result<Picked> = runCatching {
    val resolver = context.contentResolver
    var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    var size = -1L
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (n >= 0) c.getString(n)?.let { name = it }
            val z = c.getColumnIndex(OpenableColumns.SIZE)
            if (z >= 0 && !c.isNull(z)) size = c.getLong(z)
        }
    }
    val mime = resolver.getType(uri) ?: ""
    val isImage = mime.startsWith("image/")
    val tooLarge = "too large (limit 25 MiB)"
    if (size > MAX_ATTACHMENT) {
        if (!isImage) error(tooLarge)
        return@runCatching Picked(jpegName(name), shrinkImage { resolver.openInputStream(uri) } ?: error(tooLarge))
    }
    val bytes = resolver.openInputStream(uri)?.use { readUpTo(it, MAX_ATTACHMENT + 1) } ?: error("could not read $name")
    if (bytes.size > MAX_ATTACHMENT) {
        if (!isImage) error(tooLarge)
        return@runCatching Picked(jpegName(name), shrinkImage { resolver.openInputStream(uri) } ?: error(tooLarge))
    }
    Picked(name, bytes)
}

internal fun jpegName(name: String): String = name.substringBeforeLast('.') + ".jpg"

/** At most [max] bytes of [input]; a longer stream yields exactly [max], so the caller can tell it was cut. */
internal fun readUpTo(input: java.io.InputStream, max: Long): ByteArray {
    val out = ByteArrayOutputStream()
    val chunk = ByteArray(64 * 1024)
    var total = 0L
    while (total < max) {
        val n = input.read(chunk, 0, minOf(chunk.size.toLong(), max - total).toInt())
        if (n < 0) break
        out.write(chunk, 0, n)
        total += n
    }
    return out.toByteArray()
}

/** The largest bitmap a shrink pass decodes: 16 megapixels, so the decode itself stays bounded. */
private const val MAX_DECODE_PIXELS = 16L * 1024 * 1024

/**
 * JPEG at quality 85 under the limit, decoding from [open] (a fresh stream each pass): the bounds are read
 * first, the sample size chosen so the decode stays under [MAX_DECODE_PIXELS], then doubled until the JPEG
 * fits. Null when even a small one does not, or the data is not an image.
 */
internal fun shrinkImage(open: () -> java.io.InputStream?): ByteArray? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open()?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth.toLong() * bounds.outHeight / (sample.toLong() * sample) > MAX_DECODE_PIXELS) sample *= 2
    while (sample <= 64) {
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val bitmap = open()?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
        bitmap.recycle()
        if (out.size() <= MAX_ATTACHMENT) return out.toByteArray()
        sample *= 2
    }
    return null
}
