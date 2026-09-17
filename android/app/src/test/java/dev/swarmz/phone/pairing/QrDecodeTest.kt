package dev.swarmz.phone.pairing

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Mac draws its code at whatever size the dialog is; the phone sees a camera frame of it. */
private fun frame(text: String, scale: Int = 4, rowStride: Int = -1, pad: Int = 0): Triple<ByteArray, Int, Int> {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0)
    val width = matrix.width * scale + pad * 2
    val height = matrix.height * scale + pad * 2
    val stride = if (rowStride < 0) width else rowStride
    // A camera's Y plane: 0 is black, 255 is white, and the row stride can be wider than the frame.
    val luminance = ByteArray(stride * height) { -1 }
    for (y in 0 until height) {
        for (x in 0 until width) {
            val mx = (x - pad) / scale
            val my = (y - pad) / scale
            val dark = mx in 0 until matrix.width && my in 0 until matrix.height && matrix.get(mx, my)
            luminance[y * stride + x] = if (dark) 0 else -1
        }
    }
    return Triple(luminance, stride, height)
}

class QrDecodeTest {
    private val uri = pairUriFixture()

    @Test
    fun readsAPairingCodeOutOfAFrame() {
        val (luminance, stride, height) = frame(uri)
        assertEquals(uri, decodeQr(luminance, stride, stride, height))
    }

    @Test
    fun readsItWhenTheRowStrideIsWiderThanTheFrame() {
        // CameraX hands back a Y plane whose rows are padded out to the hardware's alignment.
        val (luminance, stride, height) = frame(uri, scale = 4, rowStride = 400, pad = 8)
        assertEquals(uri, decodeQr(luminance, stride, 380, height))
    }

    @Test
    fun aFrameWithNoCodeInItReadsAsNothing() {
        val blank = ByteArray(200 * 200) { -1 }
        assertNull(decodeQr(blank, 200, 200, 200))
        // Noise, and a frame smaller than the data it claims, are not errors either.
        val noise = ByteArray(200 * 200) { ((it * 2654435761u.toInt()) shr 13).toByte() }
        assertNull(decodeQr(noise, 200, 200, 200))
        assertNull(decodeQr(ByteArray(10), 200, 200, 200))
    }
}

private fun pairUriFixture(): String =
    "swarmz://pair?host=mini&user=me" +
        "&fp=SHA256%3Ar1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD%2Fhh6U" +
        "&fp=SHA256%3A7CQ%2FldJqhjJfG5HDFdkweMu4jkmliY%2BCecbtNbpO8J0" +
        "&v=1"
