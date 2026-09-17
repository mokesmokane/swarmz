package dev.swarmz.phone.proto

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** Span colours: `#rrggbb` strings or xterm-256 palette indexes. */
object Palette {
    private val basic = longArrayOf(
        0xFF000000, 0xFFCD3131, 0xFF0DBC79, 0xFFE5E510, 0xFF2472C8, 0xFFBC3FBC, 0xFF11A8CD, 0xFFE5E5E5,
        0xFF666666, 0xFFF14C4C, 0xFF23D18B, 0xFFF5F543, 0xFF3B8EEA, 0xFFD670D6, 0xFF29B8DB, 0xFFFFFFFF,
    )
    private val cube = intArrayOf(0, 95, 135, 175, 215, 255)

    fun argb(color: JsonPrimitive?): Long? {
        if (color == null) return null
        if (color.isString) {
            val s = color.content
            if (s.length != 7 || s[0] != '#') return null
            val rgb = s.substring(1).toLongOrNull(16) ?: return null
            return 0xFF000000 or rgb
        }
        val i = color.intOrNull ?: return null
        return when (i) {
            in 0..15 -> basic[i]
            in 16..231 -> {
                val n = i - 16
                rgb(cube[n / 36], cube[(n / 6) % 6], cube[n % 6])
            }
            in 232..255 -> {
                val g = 8 + 10 * (i - 232)
                rgb(g, g, g)
            }
            else -> null
        }
    }

    private fun rgb(r: Int, g: Int, b: Int): Long = 0xFF000000 or (r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong()
}
