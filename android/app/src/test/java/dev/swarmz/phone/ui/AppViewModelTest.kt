package dev.swarmz.phone.ui

import dev.swarmz.phone.data.MemorySettings
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.data.HostConnector
import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.FakeConn
import dev.swarmz.phone.link.VERSION_OK
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant

private const val PERMISSION_SNAPSHOT =
    """{"tiles":[{"cwd":"/p/api","id":"t1","kind":"claude","name":"api","needs":"permission","running":true,"since":"2026-09-17T10:00:00Z","status":"blocked","summary":"npm tes"},""" +
        """{"cwd":"/p/web","id":"t2","kind":"claude","name":"web","running":true,"status":"idle","turnEndedAt":"2026-09-17T10:05:00Z"}],"type":"snapshot","v":1}"""

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelTest {
    private lateinit var key: PhoneKey

    @Before
    fun setUp() {
        installBouncyCastle()
        key = PhoneKey(Ed25519.generate())
    }

    private class Env(val vm: AppViewModel, val conn: FakeConn, val settings: MemorySettings)

    private suspend fun TestScope.env(answer: String = """{"answered":true,"option":{"n":1,"label":"Yes"},"v":1}"""): Env {
        val conn = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> """{"machines":[],"v":1}"""
                Cmd.pending("t1") -> """{"pending":{"tool":"Bash","summary":"npm test","options":[{"n":1,"label":"Yes"},{"n":2,"label":"No"}]},"v":1}"""
                Cmd.answer("t1", "yes", "npm test"), Cmd.answer("t1", "deny", "npm test") -> answer
                else -> VERSION_OK
            }
        }
        val settings = MemorySettings().also { it.paired.value = Paired("mini", "me", "Fold") }
        val now = { Instant.parse("2026-09-17T10:10:00Z").plusMillis(testScheduler.currentTime) }
        val repo = Repository(settings, { key }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), backgroundScope, now)
        repo.start()
        val vm = AppViewModel(repo, settings, pairing = null, scope = backgroundScope, now = now)
        runCurrent()
        conn.stream(Cmd.watch()).send(PERMISSION_SNAPSHOT)
        runCurrent()
        return Env(vm, conn, settings)
    }

    @Test
    fun permissionCardsUseTheScreensSummaryAndAnswerWithIt() = runTest {
        val e = env()
        val ui = e.vm.home.value
        assertEquals(listOf("api", "web"), ui.model.needs.map { it.row.name }.sorted())
        assertEquals("npm test", ui.asks[TileKey("mini", "t1")]!!.summary)
        e.vm.allowOnce(TileKey("mini", "t1"))
        runCurrent()
        assertTrue(Cmd.answer("t1", "yes", "npm test") in e.conn.ran)
        assertFalse(TileKey("mini", "t1") in e.vm.home.value.asks)
    }

    @Test
    fun ignoredAnswersDisappearQuietly() = runTest {
        val e = env(answer = """{"ignored":true,"reason":"no question is showing","v":1}""")
        e.vm.deny(TileKey("mini", "t1"))
        runCurrent()
        assertTrue(Cmd.answer("t1", "deny", "npm test") in e.conn.ran)
        assertFalse(TileKey("mini", "t1") in e.vm.home.value.asks)
    }

    @Test
    fun openingATileMarksItSeenAndKeepsItsController() = runTest {
        val e = env()
        val web = TileKey("mini", "t2")
        e.vm.open(web)
        runCurrent()
        assertEquals(Route.Tile(web), e.vm.route.value)
        assertEquals(listOf("api"), e.vm.home.value.model.needs.map { it.row.name })
        val controller = e.vm.tile.value!!
        controller.draft.value = androidx.compose.ui.text.input.TextFieldValue("half typed")
        e.vm.open(web)
        assertSame(controller, e.vm.tile.value)
        e.vm.open(TileKey("mini", "t1"))
        assertNotSame(controller, e.vm.tile.value)
        assertTrue(e.vm.back())
        assertEquals(Route.Home, e.vm.route.value)
        assertEquals(null, e.vm.tile.value)
        assertFalse(e.vm.back())
    }

    @Test
    fun repliesAreSent() = runTest {
        val e = env()
        e.vm.reply(TileKey("mini", "t2"), "carry on")
        runCurrent()
        assertTrue(Cmd.send("t2", "carry on") in e.conn.ran)
    }
}
