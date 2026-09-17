package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.font.FontWeight
import dev.swarmz.phone.proto.Span
import dev.swarmz.phone.ui.theme.Sw
import dev.swarmz.phone.ui.theme.SwarmzTheme
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ShellOutputTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun spansBecomeStyledText() {
        val line = listOf(
            Span("err", fg = JsonPrimitive(1), bold = true),
            Span(" ok ", fg = JsonPrimitive("#00ff00")),
            Span("sel", inverse = true),
        )
        val a = line.annotated()
        assertEquals("err ok sel", a.text)
        val styles = a.spanStyles.sortedBy { it.start }
        assertEquals(Color(0xFFCD3131), styles[0].item.color)
        assertEquals(FontWeight.Bold, styles[0].item.fontWeight)
        assertEquals(Color(0xFF00FF00), styles[1].item.color)
        assertEquals(Sw.Background, styles[2].item.color)
        assertEquals(Sw.Body, styles[2].item.background)
        assertEquals("[process exited with code 2]", exitLine(2))
        assertEquals("[process exited]", exitLine(null))
    }

    @Test
    fun linesRender() {
        compose.setContent {
            SwarmzTheme { ShellLines(listOf(listOf(Span("$ make")), listOf(Span("done"))), exit = exitLine(0), listState = rememberLazyListState()) }
        }
        compose.onNodeWithText("$ make").assertIsDisplayed()
        compose.onNodeWithText("[process exited with code 0]").assertIsDisplayed()
    }
}
