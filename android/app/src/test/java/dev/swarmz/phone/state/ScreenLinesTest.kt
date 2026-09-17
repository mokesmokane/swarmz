package dev.swarmz.phone.state

import dev.swarmz.phone.proto.LinesUpdate
import dev.swarmz.phone.proto.OutputEvent
import dev.swarmz.phone.proto.Screen
import dev.swarmz.phone.proto.Span
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenLinesTest {
    private fun l(s: String) = listOf(Span(s))

    @Test
    fun firstThenUpdatesThenExit() {
        var s = ScreenState().apply(OutputEvent.First(Screen(80, 24, listOf(1, 0), listOf(l("a"), l("b")))))
        assertEquals(listOf(l("a"), l("b")), s.lines)
        s = s.apply(OutputEvent.Update(LinesUpdate(drop = 1, from = 1, lines = listOf(l("c")), cursor = listOf(1, 1))))
        assertEquals(listOf(l("b"), l("c")), s.lines)
        assertEquals(listOf(1, 1), s.cursor)
        s = s.apply(OutputEvent.Update(LinesUpdate(drop = 0, from = 2, lines = emptyList(), cursor = null)))
        assertEquals(listOf(l("b"), l("c")), s.lines)
        s = s.apply(OutputEvent.Ping)
        assertEquals(listOf(l("b"), l("c")), s.lines)
        s = s.apply(OutputEvent.Exit)
        assertTrue(s.exited)
    }

    @Test
    fun outOfRangeUpdatesAreClamped() {
        val s = ScreenState(lines = listOf(l("a"))).apply(OutputEvent.Update(LinesUpdate(drop = 5, from = 5, lines = listOf(l("z")))))
        assertEquals(listOf(l("z")), s.lines)
    }
}
