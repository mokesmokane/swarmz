package dev.swarmz.phone.ui.tile

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import dev.swarmz.phone.data.HostConnector
import dev.swarmz.phone.data.MemorySettings
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.FakeConn
import dev.swarmz.phone.link.VERSION_OK
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.ui.theme.SwarmzTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp")
class TileScreenTest {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @After fun tearDown() = scope.cancel()

    private lateinit var conn: FakeConn

    private fun controller(tile: String, row: String): TileController {
        installBouncyCastle()
        conn = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> """{"machines":[{"name":"mini","alias":"Mini","online":true,"self":true}],"v":1}"""
                Cmd.pending("t1") -> """{"pending":{"tool":"Bash","summary":"npm test","options":[{"n":1,"label":"Yes"},{"n":2,"label":"Yes, always"},{"n":3,"label":"No"}]},"v":1}"""
                Cmd.answer("t1", "1", "npm test") -> """{"answered":true,"option":{"n":1,"label":"Yes"},"v":1}"""
                Cmd.send("t1", "go on") -> """{"sent":true,"v":1}"""
                else -> VERSION_OK
            }
        }
        runBlocking {
            conn.stream(Cmd.watch()).send("""{"tiles":[$row],"type":"snapshot","v":1}""")
            conn.stream(Cmd.transcript("t1", follow = true)).send(
                """{"hasMore":false,"messages":[{"id":"u","role":"user","text":"fix the build"},""" +
                    """{"id":"a","role":"assistant","text":"Done. Run:\n```\nnpm test\n```","tools":[{"name":"Bash","summary":"npm run build","ok":true}]}],"v":1}""",
            )
        }
        val settings = MemorySettings().also { it.paired.value = Paired("mini", "me", "Fold") }
        val repo = Repository(settings, { PhoneKey(Ed25519.generate()) }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), scope)
        repo.start()
        return TileController(TileKey("mini", tile), repo, scope) { Instant.parse("2026-09-17T10:00:30Z") }
    }

    private val permissionRow =
        """{"cwd":"/Users/me/api","id":"t1","kind":"claude","mode":"acceptEdits","name":"api","needs":"permission","running":true,"since":"2026-09-17T10:00:00Z","status":"blocked"}"""

    @Test
    fun conversationPermissionAndComposer() {
        val c = controller("t1", permissionRow)
        var back = 0
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = { back++ }) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("fix the build")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("api").assertIsDisplayed()
        compose.onNodeWithText("ACCEPT EDITS").assertIsDisplayed()
        compose.onNodeWithText("Mini · api").assertIsDisplayed()
        compose.onNodeWithText("Done. Run:", substring = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("Copy code").assertIsDisplayed()
        compose.onNodeWithText("Bash", substring = true).assertIsDisplayed()
        compose.onNodeWithText("waiting on you").assertIsDisplayed()
        compose.onNodeWithText("Run npm test?", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Yes, always").assertIsDisplayed()
        compose.onNodeWithText("Yes").performClick()
        compose.waitUntil(5_000) { Cmd.answer("t1", "1", "npm test") in conn.ran }
        compose.onNodeWithText("Esc").assertIsDisplayed()
        compose.onNodeWithText("^C").assertIsDisplayed()
        compose.onNodeWithText("⇧Tab accept edits").assertIsDisplayed()
        compose.onNodeWithTag("composer").performTextInput("go on")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(5_000) { Cmd.send("t1", "go on") in conn.ran }
        compose.onNodeWithContentDescription("Back").performClick()
        assertTrue(back == 1)
    }

    @Test
    fun slashPickerFillsTheComposer() {
        val c = controller("t1", permissionRow)
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = true, onBack = null) } }
        // The keys only work once the tile is known.
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("ACCEPT EDITS")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("/").performClick()
        compose.onNodeWithText("/compact").performClick()
        assertTrue(c.draft.value.text == "/compact ")
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
    }

    @Test
    fun stoppedTilesOfferRestart() {
        val c = controller("t1", """{"cwd":"/Users/me/api","exitCode":1,"id":"t1","kind":"claude","name":"api","running":false,"status":"offline"}""")
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Restart")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(hasText("exited 1")).onFirst().assertIsDisplayed()
    }
}
