package dev.swarmz.phone.state

import dev.swarmz.phone.proto.Line
import dev.swarmz.phone.proto.OutputEvent

data class ScreenState(val lines: List<Line> = emptyList(), val cursor: List<Int>? = null, val exited: Boolean = false)

/** `output --follow`: drop `drop` lines from the top, keep `from` of the rest, append `lines`. */
fun ScreenState.apply(event: OutputEvent): ScreenState = when (event) {
    is OutputEvent.First -> ScreenState(event.screen.lines, event.screen.cursor, exited = false)
    is OutputEvent.Update -> {
        val u = event.update
        val kept = lines.drop(u.drop.coerceAtLeast(0)).take(u.from.coerceAtLeast(0))
        copy(lines = kept + u.lines, cursor = u.cursor)
    }
    OutputEvent.Exit -> copy(exited = true)
    OutputEvent.Ping -> this
}
