package dev.swarmz.phone.proto

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PaletteTest {
    @Test
    fun colours() {
        assertNull(Palette.argb(null))
        assertEquals(0xFF25BF35, Palette.argb(JsonPrimitive("#25bf35")))
        assertEquals(0xFFCD3131, Palette.argb(JsonPrimitive(1)))      // standard red
        assertEquals(0xFFF14C4C, Palette.argb(JsonPrimitive(9)))      // bright red
        assertEquals(0xFF5F87AF, Palette.argb(JsonPrimitive(67)))     // 6x6x6 cube: 1,2,3
        assertEquals(0xFF808080, Palette.argb(JsonPrimitive(244)))    // grey ramp: 8 + 10*(244-232)
        assertNull(Palette.argb(JsonPrimitive("nonsense")))
        assertNull(Palette.argb(JsonPrimitive(300)))
    }
}
