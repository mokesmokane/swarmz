package dev.swarmz.phone.ui.tile

import android.content.Intent
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.font.FontWeight
import dev.swarmz.phone.proto.Span
import dev.swarmz.phone.ui.theme.Sw
import dev.swarmz.phone.ui.theme.SwarmzTheme
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
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
    fun inverseWithOnlyAForegroundUsesItAsTheBackground() {
        val line = listOf(Span("x", fg = JsonPrimitive("#ff0000"), inverse = true))
        val style = line.annotated().spanStyles.single().item
        assertEquals(Sw.Background, style.color)
        assertEquals(Color(0xFFFF0000), style.background)
    }

    @Test
    fun inverseWithOnlyABackgroundUsesItAsTheText() {
        val line = listOf(Span("x", bg = JsonPrimitive("#00ff00"), inverse = true))
        val style = line.annotated().spanStyles.single().item
        assertEquals(Color(0xFF00FF00), style.color)
        assertEquals(Sw.Body, style.background)
    }

    @Test
    fun linesRender() {
        compose.setContent {
            SwarmzTheme {
                ShellLines(
                    listOf(listOf(Span("$ make")), listOf(Span("done"))),
                    dropped = 0,
                    exit = exitLine(0),
                    listState = rememberLazyListState(),
                )
            }
        }
        compose.onNodeWithText("$ make").assertIsDisplayed()
        compose.onNodeWithText("[process exited with code 0]").assertIsDisplayed()
    }

    @Test
    fun followsWhenAFullWindowDropsAndAppends() {
        var lines by mutableStateOf((0 until 300).map { i -> listOf(Span("line$i")) })
        var dropped by mutableStateOf(0L)
        lateinit var listState: LazyListState
        compose.setContent {
            listState = rememberLazyListState()
            SwarmzTheme { ShellLines(lines, dropped, exit = null, listState = listState) }
        }
        compose.onNodeWithText("line299").assertIsDisplayed()
        // A full window: the update drops one line and appends one, so lines.size (300) never changes.
        lines = lines.drop(1) + listOf(listOf(Span("line300")))
        dropped += 1
        compose.onNodeWithText("line300").assertIsDisplayed()
    }

    /** The URLs [links] finds in [text], as text, which is easier to read than index ranges. */
    private fun found(text: String) = links(text).map { text.substring(it) }

    @Test
    fun urlsAreFoundInAScreenLine() {
        assertEquals(emptyList<String>(), found("no url here at all"))
        assertEquals(
            listOf("https://claude.ai/oauth/authorize?code=1"),
            found("Open https://claude.ai/oauth/authorize?code=1 in a browser"),
        )
        assertEquals(listOf("http://x.test/1", "https://y.test/2"), found("a http://x.test/1 b https://y.test/2 c"))
        assertEquals(listOf("https://x.test/a"), found("see (https://x.test/a)."))
        assertEquals(listOf("https://x.test/a"), found("""quoted "https://x.test/a";"""))
        assertEquals("a url can run to the end of the line", listOf("https://x.test/end"), found("visit https://x.test/end"))
        assertEquals("a scheme with no host is not a link", emptyList<String>(), found("https:// and http://"))
        // Known limitation: the terminal wraps a long URL, and the two halves are never joined.
        assertEquals(listOf("https://claude.ai/oauth/auth"), found("https://claude.ai/oauth/auth"))
        assertEquals(emptyList<String>(), found("orize?code=1"))
    }

    @Test
    fun onlyHttpAndHttpsAreEverOpened() {
        val context = RuntimeEnvironment.getApplication()
        assertFalse(openLink(context, "javascript:alert(1)"))
        assertFalse(openLink(context, "file:///etc/passwd"))
        assertFalse(openLink(context, "intent://x#Intent;end"))
        assertNull("a refused scheme never reaches startActivity", shadowOf(context).nextStartedActivity)
        assertTrue(openLink(context, "https://claude.ai/oauth"))
        val started = shadowOf(context).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertEquals("https://claude.ai/oauth", started.data.toString())
        assertTrue("a browser is what should answer", started.hasCategory(Intent.CATEGORY_BROWSABLE))
    }

    @OptIn(ExperimentalComposeUiApi::class)
    @Test
    fun aUrlOnTheScreenIsTappableAndOffersOpenAndCopy() {
        var notice: String? = null
        compose.setContent {
            SwarmzTheme {
                ShellLines(
                    listOf(listOf(Span("Open "), Span("https://claude.ai/oauth"))),
                    dropped = 0,
                    exit = null,
                    listState = rememberLazyListState(),
                    onNotice = { notice = it },
                )
            }
        }
        compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.LinkTestMarker)).onFirst().performClick()
        compose.onNodeWithText("Open").assertIsDisplayed()
        compose.onNodeWithText("Copy").performClick()
        compose.waitUntil(5_000) { notice == "Link copied" }
    }
}
