package dev.swarmz.phone.pairing

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private class Frame(val luminance: ByteArray, val rowStride: Int, val width: Int, val height: Int)

/** The Mac draws its code at whatever size the dialog is; the phone sees a camera frame of it. */
private fun frame(text: String, scale: Int = 4, rowStride: Int = -1, pad: Int = 0, padLastRow: Boolean = true): Frame {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0)
    val width = matrix.width * scale + pad * 2
    val height = matrix.height * scale + pad * 2
    val stride = if (rowStride < 0) width else rowStride
    // A camera's Y plane: 0 is black, 255 is white, and the row stride can be wider than the
    // frame. The last row is often not padded out to the stride, so the plane is that much short.
    val size = if (padLastRow) stride * height else stride * (height - 1) + width
    val luminance = ByteArray(size) { -1 }
    for (y in 0 until height) {
        for (x in 0 until width) {
            val at = y * stride + x
            if (at >= size) continue
            val mx = (x - pad) / scale
            val my = (y - pad) / scale
            val dark = mx in 0 until matrix.width && my in 0 until matrix.height && matrix.get(mx, my)
            luminance[at] = if (dark) 0 else -1
        }
    }
    return Frame(luminance, stride, width, height)
}

class QrDecodeTest {
    private val uri = pairUriFixture()

    /** One reader for every frame, as the scanner uses it: it must read the next frame as well as the first. */
    private val frames = QrFrames()

    private fun decode(f: Frame) = frames.decode(f.luminance, f.rowStride, f.width, f.height)

    @Test
    fun readsAPairingCodeOutOfAFrame() {
        assertEquals(uri, decode(frame(uri)))
        // And out of the next one, with the reader reset in between.
        assertEquals(uri, decode(frame(uri, scale = 3)))
    }

    @Test
    fun readsItWhenTheRowStrideIsWiderThanTheFrame() {
        // CameraX hands back a Y plane whose rows are padded out to the hardware's alignment.
        assertEquals(uri, decode(frame(uri, scale = 4, rowStride = 400, pad = 8)))
    }

    @Test
    fun readsItWhenTheLastRowIsNotPaddedOutToTheStride() {
        // On many devices the Y plane is rowStride * (height - 1) + width bytes, not
        // rowStride * height: a guard that insists on the latter rejects every frame.
        val f = frame(uri, scale = 4, rowStride = 400, pad = 8, padLastRow = false)
        assertEquals(f.rowStride * (f.height - 1) + f.width, f.luminance.size)
        assertEquals(uri, decode(f))
    }

    @Test
    fun aFrameWithNoCodeInItReadsAsNothing() {
        val blank = ByteArray(200 * 200) { -1 }
        assertNull(frames.decode(blank, 200, 200, 200))
        // Noise, and a frame smaller than the data it claims, are not errors either.
        val noise = ByteArray(200 * 200) { ((it * 2654435761u.toInt()) shr 13).toByte() }
        assertNull(frames.decode(noise, 200, 200, 200))
        assertNull(frames.decode(ByteArray(10), 200, 200, 200))
        // One byte short of what the last row needs.
        assertNull(frames.decode(ByteArray(200 * 199 + 199), 200, 200, 200))
    }
}

private fun pairUriFixture(): String =
    "swarmz://pair?host=mini&user=me" +
        "&fp=SHA256%3Ar1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD%2Fhh6U" +
        "&fp=SHA256%3A7CQ%2FldJqhjJfG5HDFdkweMu4jkmliY%2BCecbtNbpO8J0" +
        "&v=1"
