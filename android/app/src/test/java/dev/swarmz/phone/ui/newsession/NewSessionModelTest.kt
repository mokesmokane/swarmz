package dev.swarmz.phone.ui.newsession

import dev.swarmz.phone.data.HostConnector
import dev.swarmz.phone.data.MemorySettings
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.FakeConn
import dev.swarmz.phone.link.VERSION_OK
import dev.swarmz.phone.proto.Agent
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The model on its own, on virtual time: no Compose, no Robolectric and no real dispatcher, so every step below
 * happens in a known order.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NewSessionModelTest {
    @Before fun bc() = installBouncyCastle()

    @Test
    fun aSecondTapWhileStartingStartsNothing() = runTest {
        val newCmd = Cmd.newTile("/Users/me", skipPermissions = false)
        val reached = CompletableDeferred<Unit>()
        val gate = CompletableDeferred<Unit>()
        val conn = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> """{"machines":[],"v":1}"""
                Cmd.folders(null) -> """{"dirs":[],"parent":"/Users","path":"/Users/me","v":1}"""
                newCmd -> """{"tile":{"cwd":"/Users/me","id":"n1","kind":"claude","name":"me","running":true},"v":1}"""
                else -> VERSION_OK
            }
        }
        // `new` reports that it has reached the Mac, then waits there until this test lets it finish.
        conn.beforeExec = {
            if (it == newCmd) {
                reached.complete(Unit)
                gate.await()
            }
        }
        val settings = MemorySettings().also { it.setPaired(Paired("mini", "me", "Fold")) }
        val repo = Repository(settings, { PhoneKey(Ed25519.generate()) }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), backgroundScope)
        repo.start()
        val model = NewSessionModel(repo, backgroundScope)
        model.pickMac("mini")
        // Wait for the folder listing rather than assuming it has arrived.
        model.state.first { it.folders != null }

        val first = async { model.start() }
        // The first tap is provably in flight: its command is at the Mac and cannot finish yet.
        reached.await()
        assertTrue(model.state.value.starting)

        val second = async { model.start() }
        runCurrent()
        assertTrue("the second tap is answered without waiting", second.isCompleted)
        assertNull(second.await())
        assertEquals("the second tap runs no command", 1, conn.ran.count { it == newCmd })

        gate.complete(Unit)
        assertEquals(TileKey("mini", "n1"), first.await())
        assertEquals("two taps, one new session", 1, conn.ran.count { it == newCmd })
        assertFalse(model.state.value.starting)
    }

    @Test
    fun codexIsChosenAndStartsWithItsAgent() = runTest {
        val newCmd = Cmd.newTile("/Users/me", skipPermissions = true, agent = Agent.Codex)
        val conn = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> """{"machines":[],"v":1}"""
                Cmd.folders(null) -> """{"dirs":[],"parent":"/Users","path":"/Users/me","v":1}"""
                newCmd -> """{"tile":{"cwd":"/Users/me","id":"x1","kind":"codex","name":"me","running":true},"v":1}"""
                else -> VERSION_OK
            }
        }
        val settings = MemorySettings().also { it.setPaired(Paired("mini", "me", "Fold")) }
        val repo = Repository(settings, { PhoneKey(Ed25519.generate()) }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), backgroundScope)
        repo.start()
        val model = NewSessionModel(repo, backgroundScope)
        assertEquals("Claude by default", Agent.Claude, model.state.value.agent)
        model.setAgent(Agent.Codex)
        model.setSkip(true)
        model.pickMac("mini")
        assertEquals("the choice survives picking a Mac", Agent.Codex, model.state.value.agent)
        model.state.first { it.folders != null }
        assertEquals(TileKey("mini", "x1"), model.start())
        assertTrue(newCmd in conn.ran)
        assertEquals("Codex will run commands and edit files without asking, outside its sandbox.", skipWarning(Agent.Codex))
    }
}
