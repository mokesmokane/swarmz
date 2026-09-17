package dev.swarmz.phone.ui.tile

import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import dev.swarmz.phone.ui.theme.SwarmzTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The blink used to swap " ▍" for "  ", and the block character comes from a fallback font that measures
 * slightly taller, so the status line's height changed on every blink and the messages above it jumped. The
 * fix keeps the same text always and animates only its alpha, so the layout can never change.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ClaudeConversationTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun theCursorTextNeverChangesAcrossBlinks() {
        compose.setContent { SwarmzTheme { StatusLine("working · 3s") } }
        compose.onNodeWithTag("statusCursor").assertTextEquals(" ▍")
        // Well past a 530ms blink, more than once, so both the "on" and "off" phase are exercised.
        compose.mainClock.advanceTimeBy(600)
        compose.onNodeWithTag("statusCursor").assertTextEquals(" ▍")
        compose.mainClock.advanceTimeBy(600)
        compose.onNodeWithTag("statusCursor").assertTextEquals(" ▍")
        compose.mainClock.advanceTimeBy(600)
        compose.onNodeWithTag("statusCursor").assertTextEquals(" ▍")
    }
}
