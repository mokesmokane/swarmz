package dev.swarmz.phone.state

import dev.swarmz.phone.proto.Line
import dev.swarmz.phone.proto.OutputEvent

/**
 * @param dropped The running count of lines dropped from the top of [lines] since the last [OutputEvent.First].
 * With `lines.size` it gives each row a stable absolute line number, and unlike `lines.size` alone it keeps
 * changing once the window is full (`output --follow` then drops and appends the same count each update).
 */
data class ScreenState(val lines: List<Line> = emptyList(), val cursor: List<Int>? = null, val exited: Boolean = false, val dropped: Long = 0)

/** `output --follow`: drop `drop` lines from the top, keep `from` of the rest, append `lines`. */
fun ScreenState.apply(event: OutputEvent): ScreenState = when (event) {
    is OutputEvent.First -> ScreenState(event.screen.lines, event.screen.cursor, exited = false)
    is OutputEvent.Update -> {
        val u = event.update
        val drop = u.drop.coerceAtLeast(0)
        val kept = lines.drop(drop).take(u.from.coerceAtLeast(0))
        copy(lines = kept + u.lines, cursor = u.cursor, dropped = dropped + minOf(drop, lines.size))
    }
    OutputEvent.Exit -> copy(exited = true)
    OutputEvent.Ping -> this
}
