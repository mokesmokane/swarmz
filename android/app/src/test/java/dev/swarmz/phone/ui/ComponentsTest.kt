package dev.swarmz.phone.ui

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.graphics.toArgb
import dev.swarmz.phone.state.Dot
import dev.swarmz.phone.ui.components.Badge
import dev.swarmz.phone.ui.components.Pill
import dev.swarmz.phone.ui.components.StatusDot
import dev.swarmz.phone.ui.components.SwCard
import dev.swarmz.phone.ui.theme.Sw
import dev.swarmz.phone.ui.theme.SwarmzTheme
import dev.swarmz.phone.ui.theme.color
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ComponentsTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun statusColoursMatchTheDesktop() {
        assertEquals(0xFF25BF35.toInt(), Dot.Working.color().toArgbInt())
        assertEquals(0xFFFFB21B.toInt(), Dot.NeedsYou.color().toArgbInt())
        assertEquals(0xFF475569.toInt(), Dot.Idle.color().toArgbInt())
        assertEquals(0xFFFF0303.toInt(), Dot.Error.color().toArgbInt())
        assertEquals(0xFF0F172A.toInt(), Sw.Background.toArgbInt())
    }

    @Test
    fun componentsRender() {
        var clicks = 0
        compose.setContent {
            SwarmzTheme {
                SwCard(highlighted = true, onClick = { clicks++ }) {
                    StatusDot(Dot.NeedsYou)
                    Badge("permission")
                    Pill(onClick = {}) { Text("api") }
                }
            }
        }
        compose.onNodeWithText("PERMISSION").assertIsDisplayed()
        compose.onNodeWithContentDescription("needsyou").assertIsDisplayed()
        compose.onNodeWithText("api").assertIsDisplayed()
        compose.onNodeWithText("PERMISSION").performClick()
        assertEquals(1, clicks)
    }
}

private fun androidx.compose.ui.graphics.Color.toArgbInt() = this.toArgb()
