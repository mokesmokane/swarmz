package dev.swarmz.phone.ui.dictation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.theme.SwarmzTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MicButtonTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun holdingShowsTheOverlayAndSlidingUpCancels() {
        val rec = FakeRecognizer()
        val d = Dictation(rec, { null }, cancelDistancePx = 100f)
        val field = mutableStateOf(TextFieldValue(""))
        compose.setContent {
            SwarmzTheme {
                Column {
                    Text(field.value.text.ifEmpty { "(empty)" })
                    DictationMic(d, hasPermission = { true }, requestPermission = {}).Content(field, Modifier.size(52.dp))
                    DictationOverlay(d.talk.value, d.level.value)
                }
            }
        }
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { down(center) }
        compose.onNodeWithText("Release to insert · slide up to cancel").assertIsDisplayed()
        compose.runOnIdle { rec.listener!!.onPartial("hello") }
        compose.onNodeWithText("hello").assertIsDisplayed()
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { moveBy(Offset(0f, -300f)) }
        compose.onNodeWithText("Release to cancel").assertIsDisplayed()
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { up() }
        compose.onNodeWithText("(empty)").assertIsDisplayed()
        compose.onNodeWithText("Release to cancel").assertDoesNotExist()
        assertTrue("cancel" in rec.calls)
    }

    @Test
    fun missingPermissionAsksInsteadOfListening() {
        val rec = FakeRecognizer()
        val d = Dictation(rec, { null })
        var asked = 0
        compose.setContent {
            SwarmzTheme {
                DictationMic(d, hasPermission = { false }, requestPermission = { asked++ }).Content(remember { mutableStateOf(TextFieldValue("")) }, Modifier.size(52.dp))
            }
        }
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { down(center); up() }
        compose.waitForIdle()
        assertEquals(1, asked)
        assertTrue(rec.calls.isEmpty())
    }
}
