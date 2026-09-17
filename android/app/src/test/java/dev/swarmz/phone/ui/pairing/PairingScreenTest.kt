package dev.swarmz.phone.ui.pairing

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.swarmz.phone.data.MemorySettings
import dev.swarmz.phone.pairing.QrScanSheet
import dev.swarmz.phone.ssh.HostKeyPins
import dev.swarmz.phone.ui.PairingUi
import dev.swarmz.phone.ui.components.QuietButton
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val FP_ED = "SHA256:r1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD/hh6U"
private const val FP_RSA = "SHA256:7CQ/ldJqhjJfG5HDFdkweMu4jkmliY+CecbtNbpO8J0"
private val CODE =
    "swarmz://pair?host=mini&user=me" +
        "&fp=${FP_ED.replace(":", "%3A").replace("/", "%2F")}" +
        "&fp=${FP_RSA.replace(":", "%3A").replace("/", "%2F").replace("+", "%2B")}" +
        "&v=1"

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h1200dp")
class PairingScreenTest {
    @get:Rule val compose = createComposeRule()

    /** The camera's stand-in: a button that hands the screen one payload. */
    private fun sheetOf(payload: String): QrScanSheet = { onResult, onCancel ->
        // A Column, not a Box: the sheet's children must not sit on top of each other, or a tap
        // on one would land on another.
        Column {
            Text("Scanning")
            QuietButton("Fake scan", { onResult(payload) })
            QuietButton("Fake cancel", onCancel)
        }
    }

    private fun screen(payload: String, pins: HostKeyPins) {
        compose.setContent {
            PairingScreen(
                PairingUi(),
                defaultDevice = "Fold",
                onPair = { _, _, _, _ -> },
                pins = pins,
                scanSheet = sheetOf(payload),
            )
        }
    }

    /** Add mode: the Mac being paired is already named, and asking for a device name is off. */
    private fun addMac(host: String, payload: String, pins: HostKeyPins) {
        compose.setContent {
            PairingScreen(
                PairingUi(),
                defaultDevice = "",
                onPair = { _, _, _, _ -> },
                title = "Pair $host",
                initialHost = host,
                initialUser = "me",
                askDevice = false,
                onCancel = {},
                pins = pins,
                scanSheet = sheetOf(payload),
            )
        }
    }

    @Test
    fun aScannedCodeFillsInTheMacAndPinsItsHostKeys() {
        val settings = MemorySettings()
        screen(CODE, settings)
        compose.onNodeWithText("Scan QR").performClick()
        compose.onNodeWithText("Scanning").assertIsDisplayed()
        compose.onNodeWithText("Fake scan").performClick()
        // Back on the form, filled in, with the password left to type.
        compose.onNodeWithText("mini").assertIsDisplayed()
        compose.onNodeWithText("me").assertIsDisplayed()
        compose.onNodeWithText("Password").assertIsFocused()
        assertEquals("$FP_ED $FP_RSA", settings.get("mini:22"))
    }

    @Test
    fun aCodeThatIsNotAPairingCodeSaysSo() {
        val settings = MemorySettings()
        screen("https://example.com/", settings)
        compose.onNodeWithText("Scan QR").performClick()
        compose.onNodeWithText("Fake scan").performClick()
        compose.onNodeWithText("That isn't a swarmz pairing code").assertIsDisplayed()
        assertNull(settings.get("mini:22"))
    }

    @Test
    fun cancellingTheScannerLeavesTheFormAlone() {
        val settings = MemorySettings()
        screen(CODE, settings)
        compose.onNodeWithText("Scan QR").performClick()
        compose.onNodeWithText("Fake cancel").performClick()
        compose.onNodeWithText("Scanning").assertDoesNotExist()
        compose.onNodeWithText("Scan QR").assertIsDisplayed()
        assertNull(settings.get("mini:22"))
    }

    @Test
    fun aMacPinnedToADifferentKeyIsReportedRatherThanRepinned() {
        val settings = MemorySettings()
        settings.put("mini:22", "SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA")
        screen(CODE, settings)
        compose.onNodeWithText("Scan QR").performClick()
        compose.onNodeWithText("Fake scan").performClick()
        compose.onNodeWithText("mini showed a different host key than the one this phone trusts. Pair it again only if you know why it changed.").assertIsDisplayed()
        assertEquals("SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA", settings.get("mini:22"))
    }

    @Test
    fun inAddModeACodeForAnotherMacIsRefusedRatherThanSwappingWhichMacIsPaired() {
        val settings = MemorySettings()
        addMac("studio", CODE, settings)
        compose.onNodeWithText("Scan QR").performClick()
        compose.onNodeWithText("Fake scan").performClick()
        compose.onNodeWithText("That code is for mini, not studio.").assertIsDisplayed()
        // The Mac being paired is unchanged, and the other one's keys are not pinned.
        compose.onNodeWithText("studio").assertIsDisplayed()
        assertNull(settings.get("mini:22"))
        assertNull(settings.get("studio:22"))
    }

    @Test
    fun inAddModeTheSameMacUnderItsLongNameIsAccepted() {
        val settings = MemorySettings()
        addMac("mini.tailnet.ts.net", CODE, settings)
        compose.onNodeWithText("Scan QR").performClick()
        compose.onNodeWithText("Fake scan").performClick()
        compose.onNodeWithText("mini").assertIsDisplayed()
        assertEquals("$FP_ED $FP_RSA", settings.get("mini:22"))
    }
}
