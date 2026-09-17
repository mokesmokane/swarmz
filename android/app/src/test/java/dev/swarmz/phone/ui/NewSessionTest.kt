package dev.swarmz.phone.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
import dev.swarmz.phone.state.MacInfo
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.ui.newsession.NewSessionModel
import dev.swarmz.phone.ui.newsession.NewSessionScreen
import dev.swarmz.phone.ui.theme.SwarmzTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NewSessionTest {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @After fun tearDown() = scope.cancel()

    @Test
    @Config(qualifiers = "w360dp-h780dp")
    fun pickFolderSkipPermissionsAndStart() {
        installBouncyCastle()
        val newCmd = Cmd.newTile("/Users/me/projects/api", skipPermissions = true)
        val conn = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> """{"machines":[],"v":1}"""
                Cmd.folders(null) -> """{"dirs":["projects"],"parent":"/Users","path":"/Users/me","v":1}"""
                Cmd.folders("/Users/me/projects") -> """{"dirs":["api","web"],"parent":"/Users/me","path":"/Users/me/projects","v":1}"""
                Cmd.folders("/Users/me/projects/api") -> """{"dirs":[],"parent":"/Users/me/projects","path":"/Users/me/projects/api","v":1}"""
                newCmd -> """{"tile":{"cwd":"/Users/me/projects/api","id":"n1","kind":"claude","name":"api-2","running":true},"v":1}"""
                else -> VERSION_OK
            }
        }
        val settings = MemorySettings().also { it.paired.value = Paired("mini", "me", "Fold") }
        val repo = Repository(settings, { PhoneKey(Ed25519.generate()) }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), scope)
        repo.start()
        val model = NewSessionModel(repo, scope)
        var started: TileKey? = null
        compose.setContent {
            SwarmzTheme {
                NewSessionScreen(model, macs = listOf(MacInfo("mini", "Mini", true, null)), onStarted = { started = it }, onBack = {})
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("projects")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("/Users/me").assertIsDisplayed()
        compose.onNodeWithText("projects").performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("api")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("api").performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Start in api")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Skip permissions").performClick()
        compose.onNodeWithText("Claude will run commands and edit files without asking.").assertIsDisplayed()
        compose.onNodeWithText("Start in api").performClick()
        compose.waitUntil(5_000) { started != null }
        assertEquals(TileKey("mini", "n1"), started)
        assertTrue(newCmd in conn.ran)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun aSecondTapWhileStartingStartsNothing() = runTest {
        installBouncyCastle()
        val newCmd = Cmd.newTile("/Users/me", skipPermissions = false)
        val gate = CompletableDeferred<Unit>()
        val conn = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> """{"machines":[],"v":1}"""
                Cmd.folders(null) -> """{"dirs":[],"parent":"/Users","path":"/Users/me","v":1}"""
                newCmd -> """{"tile":{"cwd":"/Users/me","id":"n1","kind":"claude","name":"me","running":true},"v":1}"""
                else -> VERSION_OK
            }
        }
        conn.beforeExec = { if (it == newCmd) gate.await() }
        val settings = MemorySettings().also { it.paired.value = Paired("mini", "me", "Fold") }
        val repo = Repository(settings, { PhoneKey(Ed25519.generate()) }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), backgroundScope)
        repo.start()
        runCurrent()
        val model = NewSessionModel(repo, backgroundScope)
        model.pickMac("mini")
        runCurrent()
        val first = async { model.start() }
        runCurrent()
        assertTrue(model.state.value.starting)
        val second = async { model.start() }
        runCurrent()
        gate.complete(Unit)
        assertEquals(TileKey("mini", "n1"), first.await())
        assertNull(second.await())
        assertEquals(1, conn.ran.count { it == newCmd })
    }
}
