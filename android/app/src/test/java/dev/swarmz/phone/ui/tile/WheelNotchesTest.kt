package dev.swarmz.phone.ui.tile

import org.junit.Assert.assertEquals
import org.junit.Test

class WheelNotchesTest {
    private val step = 100f

    @Test
    fun oneNotchPerStepOfLeftoverDrag() {
        val w = WheelNotches(step)
        assertEquals(0, w.drag(60f, 0))
        assertEquals(1, w.drag(60f, 10))
        assertEquals("20 left over is not a notch", 0, w.drag(10f, 200))
        assertEquals(1, w.drag(70f, 300))
    }

    @Test
    fun downwardDragSendsDownNotches() {
        val w = WheelNotches(step)
        assertEquals(-1, w.drag(-120f, 0))
    }

    @Test
    fun throttledToTheMinimumInterval() {
        val w = WheelNotches(step)
        assertEquals(1, w.drag(150f, 0))
        assertEquals("too soon", 0, w.drag(150f, 50))
        assertEquals(1, w.drag(1f, 125))
        // Kept drag is capped at two notches, so a long fast drag leaves no backlog.
        assertEquals(1, w.drag(1f, 250))
        assertEquals(0, w.drag(1f, 375))
    }

    @Test
    fun reversingDirectionStartsOver() {
        val w = WheelNotches(step)
        assertEquals(0, w.drag(90f, 0))
        assertEquals(0, w.drag(-50f, 10))
        assertEquals(-1, w.drag(-50f, 20))
    }

    @Test
    fun resetDropsGatheredDrag() {
        val w = WheelNotches(step)
        w.drag(90f, 0)
        w.reset()
        assertEquals(0, w.drag(20f, 10))
    }

    @Test
    fun flingsBecomeAFewNotches() {
        val w = WheelNotches(step)
        assertEquals("slow fling", 0, w.fling(300f))
        assertEquals(2, w.fling(800f))
        assertEquals(-3, w.fling(-1200f))
        assertEquals("capped", 6, w.fling(100_000f))
        assertEquals(-6, w.fling(-100_000f))
    }
}
