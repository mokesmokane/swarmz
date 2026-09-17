package dev.swarmz.phone.ui.dictation

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

/**
 * Replaces the selection with [text], adding a space on either side only where the neighbour is
 * not whitespace. The cursor lands right after [text], before any space added after it.
 */
fun insertAt(value: TextFieldValue, text: String): TextFieldValue {
    if (text.isEmpty()) return value
    val s = value.text
    val start = value.selection.min
    val end = value.selection.max
    val before = if (start > 0 && !s[start - 1].isWhitespace()) " " else ""
    val after = if (end < s.length && !s[end].isWhitespace()) " " else ""
    val inserted = before + text + after
    val next = s.substring(0, start) + inserted + s.substring(end)
    val cursor = start + before.length + text.length
    return TextFieldValue(next, TextRange(cursor))
}

sealed interface Talk {
    data object Idle : Talk
    data class Listening(val partial: String, val cancelling: Boolean) : Talk
    data object Finishing : Talk
}

/** The pure press / slide / release machine behind the mic. */
class HoldToTalk(private val cancelDistancePx: Float) {
    var state: Talk = Talk.Idle
        private set

    fun press() {
        state = Talk.Listening("", cancelling = false)
    }

    /** [totalDy] is the drag since the press; negative is upwards. */
    fun drag(totalDy: Float) {
        val s = state as? Talk.Listening ?: return
        state = s.copy(cancelling = totalDy < -cancelDistancePx)
    }

    fun partial(text: String) {
        val s = state as? Talk.Listening ?: return
        state = s.copy(partial = text)
    }

    /** True when the text should be inserted, false when the hold was cancelled. */
    fun release(): Boolean {
        val s = state as? Talk.Listening ?: return false
        return if (s.cancelling) {
            state = Talk.Idle
            false
        } else {
            state = Talk.Finishing
            true
        }
    }

    fun finish() {
        state = Talk.Idle
    }
}
