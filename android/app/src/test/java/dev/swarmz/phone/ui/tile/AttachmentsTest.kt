package dev.swarmz.phone.ui.tile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

class AttachmentsTest {
    @Test
    fun readUpToStopsAtTheLimitSoACutIsVisible() {
        val data = ByteArray(300_000) { (it % 7).toByte() }
        assertTrue(readUpTo(ByteArrayInputStream(data), 1_000_000).contentEquals(data))
        val cut = readUpTo(ByteArrayInputStream(data), 100_000)
        assertEquals(100_000, cut.size)
        assertTrue(cut.contentEquals(data.copyOf(100_000)))
        assertEquals(0, readUpTo(ByteArrayInputStream(ByteArray(0)), 10).size)
    }

    @Test
    fun namesAndNonImagesShrinkToNothing() {
        assertEquals("IMG_1.jpg", jpegName("IMG_1.heic"))
        assertEquals("photo.jpg", jpegName("photo"))
        // Not an image: no bounds, so nothing to shrink.
        assertNull(shrinkImage { ByteArrayInputStream(ByteArray(1024) { 1 }) })
        assertNull(shrinkImage { null })
        assertEquals(0, percent(0, 10))
        assertEquals(100, percent(10, 10))
        assertEquals(1f, fraction(5, 0))
    }
}
