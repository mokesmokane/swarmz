package dev.swarmz.phone.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.compose.CameraXViewfinder
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import dev.swarmz.phone.ui.components.QuietButton
import dev.swarmz.phone.ui.theme.Sw
import java.util.concurrent.Executors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first

/**
 * The scanner the pairing screen opens over itself: it reports the text of the first code it
 * reads, or nothing if it is cancelled. A test passes a fake in place of the camera one.
 */
typealias QrScanSheet = @Composable (onResult: (String) -> Unit, onCancel: () -> Unit) -> Unit

/**
 * The camera, with the QR codes in its frames decoded on a background thread. The camera
 * permission is asked for when this appears (so, when Scan QR is tapped) and a refusal is said
 * out loud rather than left as a black rectangle: pairing can always be typed in instead.
 *
 * The decoding is ZXing's, which is pure Java and carries no model with it, so scanning works with
 * no network and on a phone with no Google Play services.
 */
@Composable
fun CameraQrScanner(onResult: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var refused by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        granted = allowed
        refused = !allowed
    }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }
    // Allowing the camera in Settings and coming back starts the scanner, without cancelling first.
    LifecycleResumeEffect(Unit) {
        if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            granted = true
            refused = false
        }
        onPauseOrDispose {}
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Scan the code on your Mac", style = MaterialTheme.typography.titleMedium)
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            when {
                granted -> CameraFrames(onResult)
                refused -> Text(
                    "swarmz can't use the camera. Allow it in Settings, or type the Mac's name and username in instead.",
                    color = Sw.ErrorLine,
                    style = MaterialTheme.typography.bodyMedium,
                )
                else -> Text("Waiting for permission to use the camera…", style = MaterialTheme.typography.bodyMedium)
            }
        }
        QuietButton("Cancel", onCancel, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun CameraFrames(onResult: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val current by rememberUpdatedState(onResult)
    var surfaceRequest by remember { mutableStateOf<SurfaceRequest?>(null) }
    // The first code read wins: frames keep arriving until the camera is unbound, and the screen
    // must not be filled in twice.
    val found = remember { MutableStateFlow<String?>(null) }
    val frames = remember { Executors.newSingleThreadExecutor() }
    // One reader for the whole scan, used only on the analyser thread.
    val reader = remember { QrFrames() }
    DisposableEffect(frames) { onDispose { frames.shutdown() } }

    LaunchedEffect(Unit) { current(found.filterNotNull().first()) }

    LaunchedEffect(Unit) {
        val preview = Preview.Builder().build().apply { setSurfaceProvider { request -> surfaceRequest = request } }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(frames) { image -> reader.readFrame(image)?.let { found.compareAndSet(null, it) } }
        val provider = try {
            ProcessCameraProvider.awaitInstance(context)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return@LaunchedEffect // No camera to bind: the screen already says how to pair by hand.
        }
        try {
            provider.unbindAll()
            provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            // Holds the camera until this leaves the composition, then hands it back.
            awaitCancellation()
        } finally {
            provider.unbindAll()
        }
    }

    surfaceRequest?.let { CameraXViewfinder(it, modifier = Modifier.fillMaxSize()) }
}

/**
 * ZXing's reader keeps state between calls and must be reset between frames, and it is not thread
 * safe: one of these per scanner, used only on the analyser thread.
 */
internal class QrFrames {
    private val reader = QRCodeReader()

    /** The code in one camera frame, closing the frame whatever happens. */
    fun readFrame(image: ImageProxy): String? = image.use {
        val plane = it.planes.firstOrNull() ?: return@use null
        val buffer = plane.buffer
        val luminance = ByteArray(buffer.remaining())
        buffer.get(luminance)
        decode(luminance, plane.rowStride, it.width, it.height)
    }

    /**
     * The QR code in a frame's luminance plane (a camera's Y plane: 0 is black), or null when
     * there is none. [rowStride] is how many bytes a row takes, which the hardware may pad out
     * beyond [width]; the last row usually is not padded, so the plane holds
     * `rowStride * (height - 1) + width` bytes rather than `rowStride * height`.
     */
    fun decode(luminance: ByteArray, rowStride: Int, width: Int, height: Int): String? {
        val usable = minOf(width, rowStride)
        // Exactly what PlanarYUVLuminanceSource reads: full rows, then `usable` bytes of the last.
        if (usable < 1 || height < 1 || luminance.size < rowStride * (height - 1) + usable) return null
        val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, usable, height, false)
        // A QR code's own finder patterns say which way up it is, so the frame's rotation is not
        // applied; a frame with no code in it, or one too blurred to read, simply throws.
        return try {
            reader.decode(BinaryBitmap(HybridBinarizer(source))).text
        } catch (_: Exception) {
            null
        } finally {
            reader.reset()
        }
    }
}
