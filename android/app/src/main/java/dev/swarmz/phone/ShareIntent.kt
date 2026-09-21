package dev.swarmz.phone

import android.content.Intent
import android.net.Uri

/** What a share intent carried (phone attachments spec §4.4): files by URI, and any text. */
data class Shared(val uris: List<Uri>, val text: String?)

/** The share in [intent], or null when it is not one. Text shares are text, never uploaded. */
fun sharedFrom(intent: Intent?): Shared? {
    val action = intent?.action ?: return null
    val uris: List<Uri> = when (action) {
        Intent.ACTION_SEND -> listOfNotNull(@Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)
        Intent.ACTION_SEND_MULTIPLE -> @Suppress("DEPRECATION") (intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.filterNotNull() ?: emptyList())
        else -> return null
    }
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }
    if (uris.isEmpty() && text == null) return null
    return Shared(uris, text)
}
