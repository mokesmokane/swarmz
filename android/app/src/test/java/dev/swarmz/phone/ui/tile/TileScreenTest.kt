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
import dev.swarmz.phone.data.OUTPUT_LINES
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.FakeConn
import dev.swarmz.phone.link.VERSION_OK
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.proto.Key
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.ui.theme.SwarmzTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
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

    private val permissionPending =
        """{"pending":{"tool":"Bash","summary":"npm test","options":[{"n":1,"label":"Yes"},{"n":2,"label":"Yes, always"},{"n":3,"label":"No"}]},"v":1}"""

    private fun controller(tile: String, row: String, pending: String = permissionPending): TileController {
        installBouncyCastle()
        conn = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> """{"machines":[{"name":"mini","alias":"Mini","online":true,"self":true}],"v":1}"""
                Cmd.pending("t1") -> pending
                Cmd.answer("t1", "1", "npm test") -> """{"answered":true,"option":{"n":1,"label":"Yes"},"v":1}"""
                Cmd.answer("t1", "2", "Which colour should the button be?") -> """{"answered":true,"option":{"n":2,"label":"Blue"},"v":1}"""
                Cmd.answer("t1", "2", "Which shapes do you want?") -> """{"answered":true,"option":{"n":2,"label":"Square"},"toggled":true,"v":1}"""
                Cmd.answer("t1", "submit", "Which shapes do you want?") -> """{"answered":true,"option":null,"v":1}"""
                Cmd.upload("photo.jpg", 3) -> """{"path":"/Users/me/.swarmz/paste/paste-1-photo.jpg","size":3,"v":1}"""
                Cmd.upload("bad.bin", 2) -> """{"code":"short","error":"0 of 2 bytes arrived","v":1}"""
                Cmd.cardTitle("t1", "Mine") -> """{"card":{"title":"Mine","recap":"Parsed the dialog.","updatedAt":"2026-09-17T10:00:20Z","by":"user"},"v":1}"""
                Cmd.send("t1", "go on") -> """{"sent":true,"v":1}"""
                Cmd.send("s1", "ls") -> """{"sent":true,"v":1}"""
                Cmd.key("t1", Key.Up), Cmd.key("t1", Key.Down), Cmd.key("t1", Key.Enter) -> """{"sent":true,"v":1}"""
                else -> VERSION_OK
            }
        }
        runBlocking {
            conn.stream(Cmd.watch()).send("""{"tiles":[$row],"type":"snapshot","v":1}""")
            conn.stream(Cmd.output("s1", lines = OUTPUT_LINES, follow = true)).send(
                """{"cols":80,"rows":24,"lines":[[{"text":"$ ls"}],[{"text":"file.txt"}]],"v":1}""",
            )
            conn.stream(Cmd.output("t1", lines = OUTPUT_LINES, follow = true)).send(
                """{"cols":80,"rows":24,"lines":[[{"text":"> fix the build"}],[{"text":"Select login method:"}],[{"text":"1. Claude account"}]],"v":1}""",
            )
        }
        val settings = MemorySettings().also { runBlocking { it.setPaired(Paired("mini", "me", "Fold")) } }
        val repo = Repository(settings, { PhoneKey(Ed25519.generate()) }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), scope)
        repo.start()
        return TileController(TileKey("mini", tile), repo, scope) { Instant.parse("2026-09-17T10:00:30Z") }
    }

    private val permissionRow =
        """{"cwd":"/Users/me/api","id":"t1","kind":"claude","mode":"acceptEdits","name":"api","needs":"permission","running":true,"since":"2026-09-17T10:00:00Z","status":"blocked"}"""

    @Test
    fun aClaudeTileShowsItsTerminalWithThePermissionCardAndComposer() {
        val c = controller("t1", permissionRow)
        var back = 0
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = { back++ }) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("> fix the build")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("api").assertIsDisplayed()
        compose.onNodeWithText("ACCEPT EDITS").assertIsDisplayed()
        compose.onNodeWithText("Mini · api").assertIsDisplayed()
        // The tile is its terminal: no conversation view, no toggle and no microphone.
        compose.onNodeWithText("Select login method:").assertIsDisplayed()
        compose.onNodeWithContentDescription("Screen").assertDoesNotExist()
        compose.onNodeWithContentDescription("Conversation").assertDoesNotExist()
        compose.onNodeWithContentDescription("Hold to talk").assertDoesNotExist()
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
    fun aCodexTileGetsTheAgentKeysWithCodexCommands() {
        val c = controller("t1", """{"cwd":"/Users/me/api","id":"t1","kind":"codex","mode":"on-request","name":"api","running":true,"status":"idle"}""")
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = true, onBack = null) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Esc")).fetchSemanticsNodes().isNotEmpty() }
        // An unknown mode shows no badge, and Codex has no Shift+Tab mode cycle.
        compose.onNodeWithText("ON-REQUEST").assertDoesNotExist()
        compose.onNodeWithText("⇧Tab", substring = true).assertDoesNotExist()
        compose.onNodeWithTag("attach").assertExists()
        compose.onNodeWithText("/").performClick()
        compose.onNodeWithText("/status").assertIsDisplayed()
        compose.onNodeWithText("/new").performClick()
        assertTrue(c.draft.value.text == "/new ")
    }

    @Test
    fun stoppedTilesOfferRestart() {
        val c = controller("t1", """{"cwd":"/Users/me/api","exitCode":1,"id":"t1","kind":"claude","name":"api","running":false,"status":"offline"}""")
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Restart")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(hasText("exited 1")).onFirst().assertIsDisplayed()
    }

    @Test
    fun shellTileShowsOutputAndQuickKeys() {
        val c = controller("s1", """{"cwd":"/p","id":"s1","kind":"shell","name":"sh","running":true,"status":"offline"}""")
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("$ ls")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("file.txt").assertIsDisplayed()
        compose.onNodeWithText("SHELL").assertIsDisplayed()
        compose.onNodeWithText("^C").assertIsDisplayed()
        compose.onNodeWithText("↑").assertIsDisplayed()
        compose.onNodeWithText("Tab").assertIsDisplayed()
        compose.onNodeWithText("Type a command…").assertIsDisplayed()
        compose.onNodeWithTag("composer").performTextInput("ls")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(5_000) { Cmd.send("s1", "ls") in conn.ran }
    }

    private val questionRow =
        """{"cwd":"/Users/me/api","id":"t1","kind":"claude","mode":"default","name":"api","needs":"question","running":true,"since":"2026-09-17T10:00:00Z","status":"blocked","summary":"Which colour should the button be?"}"""

    @Test
    fun aQuestionFromClaudeIsACardWithItsOptions() {
        val pending = """{"pending":{"kind":"question","tool":"AskUserQuestion","summary":"Which colour should the button be?","multi":false,"submit":false,""" +
            """"options":[{"n":1,"label":"Red","description":"A bold red button"},{"n":2,"label":"Blue","description":"A classic blue button"}]},"v":1}"""
        val c = controller("t1", questionRow, pending = pending)
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Which colour should the button be?")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("QUESTION").assertIsDisplayed()
        compose.onNodeWithText("A classic blue button").assertIsDisplayed()
        compose.onNodeWithText("Run ", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Blue").performClick()
        compose.waitUntil(5_000) { Cmd.answer("t1", "2", "Which colour should the button be?") in conn.ran }
    }

    @Test
    fun aQuestionTheHookLogReportsOnItsOwnHasNoCard() {
        // An `idle_prompt` block: `needs` is question but there is no dialog to read, so nothing is asked for.
        val row = questionRow.replace(""","summary":"Which colour should the button be?"""", "")
        val c = controller("t1", row)
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("> fix the build")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Esc").assertIsDisplayed()
        assertTrue(conn.ran.none { it == Cmd.pending("t1") })
        compose.onNodeWithText("QUESTION").assertDoesNotExist()
    }

    @Test
    fun aMultiSelectQuestionTogglesAndSubmits() {
        val pending = """{"pending":{"kind":"question","tool":"AskUserQuestion","summary":"Which shapes do you want?","multi":true,"submit":true,""" +
            """"options":[{"n":1,"label":"Circle","checked":false},{"n":2,"label":"Square","checked":true}]},"v":1}"""
        val row = questionRow.replace("Which colour should the button be?", "Which shapes do you want?")
        val c = controller("t1", row, pending = pending)
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = true, onBack = null) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("✔ Square")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("✔ Square").performClick()
        compose.waitUntil(5_000) { Cmd.answer("t1", "2", "Which shapes do you want?") in conn.ran }
        // The box is toggled, so the card comes back and Submit presses the dialog's Submit entry.
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Submit")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Submit").performClick()
        compose.waitUntil(5_000) { Cmd.answer("t1", "submit", "Which shapes do you want?") in conn.ran }
    }

    @Test
    fun theHeaderShowsTheTitleAndItsCardOpensWithTheRecapAndATitleEdit() {
        val row = """{"cwd":"/Users/me/api","id":"t1","kind":"claude","mode":"default","name":"api","running":true,"since":"2026-09-17T10:00:00Z","status":"idle",""" +
            """"title":"Phone: answer questions","recap":"Parsed the dialog.\nNext: the card.","cardAt":"2026-09-17T10:00:20Z","cardBy":"agent"}"""
        val c = controller("t1", row)
        // The screen's own clock, so "updated … ago" is stable.
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}, now = { Instant.parse("2026-09-17T10:00:30Z") }) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Phone: answer questions")).fetchSemanticsNodes().isNotEmpty() }
        // The name moves into the second line.
        compose.onNodeWithText("api · Mini · api").assertIsDisplayed()
        compose.onNodeWithTag("tile-title").performClick()
        compose.onNodeWithText("Parsed the dialog.", substring = true).assertIsDisplayed()
        compose.onNodeWithText("updated just now by Claude").assertIsDisplayed()
        compose.onNodeWithText("Edit title").performClick()
        // The dialog closes and the title field opens under the header.
        compose.onNodeWithText("Edit title").assertDoesNotExist()
        compose.onNodeWithTag("title-edit").performTextInput("Mine")
        compose.onNodeWithText("Save").performClick()
        compose.waitUntil(5_000) { Cmd.cardTitle("t1", "Mine") in conn.ran }
        compose.onNodeWithTag("title-edit").assertDoesNotExist()
    }

    @Test
    fun anAttachmentIsSentAndItsPathLandsInTheDraft() {
        val c = controller("t1", permissionRow)
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("> fix the build")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("attach").assertIsDisplayed()
        compose.onNodeWithTag("composer").performTextInput("look at ")
        c.attach("photo.jpg", byteArrayOf(1, 2, 3))
        compose.waitUntil(5_000) { Cmd.upload("photo.jpg", 3) in conn.ran }
        compose.waitUntil(5_000) { c.draft.value.text.contains("paste-1-photo.jpg") }
        assertEquals("look at /Users/me/.swarmz/paste/paste-1-photo.jpg ", c.draft.value.text)
        assertTrue(conn.inputs[Cmd.upload("photo.jpg", 3)]!!.contentEquals(byteArrayOf(1, 2, 3)))
        compose.onNodeWithText("photo.jpg · sent").assertIsDisplayed()
        // A failed one offers a retry; removing it drops the chip.
        c.attach("bad.bin", byteArrayOf(9, 9))
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Retry")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("bad.bin · 0 of 2 bytes arrived").assertIsDisplayed()
        val failed = c.attachments.value.first { it.name == "bad.bin" }
        c.removeAttachment(failed.id)
        compose.waitForIdle()
        compose.onNodeWithText("Retry").assertDoesNotExist()
    }

    @Test
    fun aTileWithoutACardShowsItsNameAndNoRecap() {
        val c = controller("t1", permissionRow)
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("> fix the build")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Mini · api").assertIsDisplayed()
        compose.onNodeWithTag("tile-title").performClick()
        compose.onNodeWithText("No recap yet").assertIsDisplayed()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText("No recap yet").assertDoesNotExist()
    }

    @Test
    fun arrowAndEnterKeysAnswerAPromptOnTheScreen() {
        // A question the permission card cannot read (here a login picker; Claude's own
        // multiple-choice questions and the /resume picker look the same to the phone) is
        // answered by moving through it and confirming with the keys under the screen.
        val c = controller("t1", permissionRow)
        compose.setContent { SwarmzTheme { TileScreen(c, unfolded = false, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("> fix the build")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Select login method:").assertIsDisplayed()
        compose.onNodeWithText("↓").performClick()
        compose.waitUntil(5_000) { Cmd.key("t1", Key.Down) in conn.ran }
        compose.onNodeWithText("↑").performClick()
        compose.waitUntil(5_000) { Cmd.key("t1", Key.Up) in conn.ran }
        compose.onNodeWithText("Enter").performClick()
        compose.waitUntil(5_000) { Cmd.key("t1", Key.Enter) in conn.ran }
        // Pressing a key never types a message.
        assertTrue(conn.ran.none { " 'send' " in it })
    }
}
