package dev.swarmz.phone.ui.dictation

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.semantics.SemanticsProperties
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
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MicButtonTest {
    @get:Rule val compose = createComposeRule()

    private fun holdable(d: Dictation, field: MutableState<TextFieldValue>) {
        compose.setContent {
            SwarmzTheme {
                Column {
                    Text(field.value.text.ifEmpty { "(empty)" }, Modifier.testTag("field"), maxLines = 1)
                    DictationMic(d, hasPermission = { true }, requestPermission = {}).Content(field, Modifier.size(52.dp))
                    DictationOverlay(d.talk.value, d.level.value)
                }
            }
        }
    }

    @Test
    fun holdingShowsTheOverlayAndSlidingUpCancels() {
        val rec = FakeRecognizer()
        val d = Dictation(rec, { null }, cancelDistancePx = 100f)
        val field = mutableStateOf(TextFieldValue(""))
        holdable(d, field)
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { down(center) }
        compose.onNodeWithText("Release to insert · slide up to cancel").assertIsDisplayed()
        compose.runOnIdle { rec.listener!!.onPartial("hello") }
        compose.onNodeWithTag("field").assertTextEquals("hello")
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { moveBy(Offset(0f, -300f)) }
        compose.onNodeWithText("Release to cancel").assertIsDisplayed()
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { up() }
        compose.onNodeWithText("(empty)").assertIsDisplayed()
        compose.onNodeWithText("Release to cancel").assertDoesNotExist()
        assertTrue("cancel" in rec.calls)
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE) // real text measurement, so the tail is actually cut
    fun thePartialShowsInTheOverlayWithTheNewestWordsKept() {
        val rec = FakeRecognizer()
        val d = Dictation(rec, { null })
        holdable(d, mutableStateOf(TextFieldValue("")))
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { down(center) }
        compose.runOnIdle { rec.listener!!.onPartial("run the tests") }
        compose.onNodeWithTag(PARTIAL_TAG).assertTextEquals("run the tests")
        val long = (1..200).joinToString(" ") { "word$it" }
        compose.runOnIdle { rec.listener!!.onPartial(long) }
        val shown = compose.onNodeWithTag(PARTIAL_TAG).fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("")
        assertTrue(shown, shown.startsWith("…"))
        assertTrue(shown, shown.endsWith("word199 word200"))
        assertTrue(shown, shown.length < long.length)
        compose.onNodeWithText("Release to insert · slide up to cancel").assertIsDisplayed()
    }

    @Test
    fun aSystemCancelRestoresTheFieldAndInsertsNothing() {
        val rec = FakeRecognizer()
        val d = Dictation(rec, { null })
        val field = mutableStateOf(TextFieldValue(""))
        holdable(d, field)
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { down(center) }
        compose.runOnIdle { rec.listener!!.onPartial("hello") }
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { cancel() }
        compose.onNodeWithText("(empty)").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf("start", "cancel"), rec.calls)
            assertEquals(Talk.Idle, d.talk.value)
        }
    }

    @Test
    fun theMicLeavingMidHoldRestoresTheField() {
        val rec = FakeRecognizer()
        val d = Dictation(rec, { null })
        val field = mutableStateOf(TextFieldValue(""))
        val shown = mutableStateOf(true)
        compose.setContent {
            SwarmzTheme {
                Column {
                    Text(field.value.text.ifEmpty { "(empty)" }, Modifier.testTag("field"))
                    Box(Modifier.size(60.dp).testTag("slot")) {
                        if (shown.value) DictationMic(d, { true }, {}).Content(field, Modifier.size(52.dp))
                    }
                }
            }
        }
        compose.onNodeWithContentDescription("Hold to talk").performTouchInput { down(center) }
        compose.runOnIdle { rec.listener!!.onPartial("hello") }
        compose.onNodeWithTag("field").assertTextEquals("hello")
        compose.runOnIdle { shown.value = false }
        compose.onNodeWithText("(empty)").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf("start", "cancel"), rec.calls)
            assertEquals(Talk.Idle, d.talk.value)
        }
    }

    @Test
    fun aSecondMicCannotTouchTheFirstHold() {
        val rec = FakeRecognizer()
        val d = Dictation(rec, { null }, cancelDistancePx = 100f)
        val one = mutableStateOf(TextFieldValue(""))
        val two = mutableStateOf(TextFieldValue("two"))
        compose.setContent {
            SwarmzTheme {
                Column {
                    DictationMic(d, { true }, {}).Content(one, Modifier.size(52.dp))
                    DictationMic(d, { true }, {}).Content(two, Modifier.padding(top = 20.dp).size(52.dp))
                }
            }
        }
        val mics = compose.onAllNodesWithContentDescription("Hold to talk")
        mics[0].performTouchInput { down(0, center) }
        compose.runOnIdle { rec.listener!!.onPartial("first") }
        mics[1].performTouchInput { down(1, center) }
        mics[1].performTouchInput { moveBy(1, Offset(0f, -300f)) }
        mics[1].performTouchInput { up(1) }
        compose.runOnIdle {
            assertEquals(listOf("start"), rec.calls)
            assertEquals(Talk.Listening("first", cancelling = false), d.talk.value)
            assertEquals("first", one.value.text)
            assertEquals("two", two.value.text)
        }
        mics[0].performTouchInput { up(0) }
        compose.runOnIdle {
            assertEquals(listOf("start", "stop"), rec.calls)
            assertEquals(Talk.Finishing, d.talk.value)
        }
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

    @Test
    fun askingForPermissionDoesNotClickTheParent() {
        val rec = FakeRecognizer()
        val d = Dictation(rec, { null })
        var asked = 0
        var opened = 0
        compose.setContent {
            SwarmzTheme {
                Column(Modifier.fillMaxWidth().clickable { opened++ }.testTag("card")) {
                    Text("reply card")
                    DictationMic(d, hasPermission = { false }, requestPermission = { asked++ }).Content(remember { mutableStateOf(TextFieldValue("")) }, Modifier.size(44.dp))
                }
            }
        }
        // The clickable parent merges its children's semantics, so look the mic up unmerged.
        compose.onNodeWithContentDescription("Hold to talk", useUnmergedTree = true).performTouchInput { down(center); up() }
        compose.waitForIdle()
        assertEquals(1, asked)
        assertEquals(0, opened)
        compose.onNodeWithText("reply card", useUnmergedTree = true).performTouchInput { down(center); up() }
        compose.waitForIdle()
        assertEquals("the parent itself still clicks", 1, opened)
    }
}
