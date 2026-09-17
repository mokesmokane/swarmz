package dev.swarmz.phone.ui.tile

import androidx.compose.ui.text.input.TextFieldValue
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
import dev.swarmz.phone.proto.Key
import dev.swarmz.phone.proto.Opt
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant

private fun snapshot(needs: String?) =
    """{"tiles":[{"cwd":"/p/api","id":"t1","kind":"claude","name":"api","running":true,"status":"idle"${if (needs != null) ""","needs":"$needs","since":"2026-09-17T10:00:00Z"""" else ""}},""" +
        """{"cwd":"/p","id":"s1","kind":"shell","name":"sh","running":true,"status":"offline"}],"type":"snapshot","v":1}"""

private fun sendPrefix(tile: String) = Cmd.send(tile, "").removeSuffix("''")

@OptIn(ExperimentalCoroutinesApi::class)
class TileControllerTest {
    private lateinit var key: PhoneKey
    @Before fun setUp() { installBouncyCastle(); key = PhoneKey(Ed25519.generate()) }

    private var sendFails = false

    private fun TestScope.setup(): Pair<Repository, FakeConn> {
        val conn = FakeConn { cmd ->
            when {
                cmd == Cmd.machines() -> """{"machines":[],"v":1}"""
                cmd == Cmd.pending("t1") -> """{"pending":{"tool":"Bash","summary":"rm -rf build","options":[{"n":1,"label":"Yes"},{"n":2,"label":"Yes, always"},{"n":3,"label":"No"}]},"v":1}"""
                cmd == Cmd.answer("t1", "2", "rm -rf build") -> """{"ignored":true,"reason":"a different question is showing","v":1}"""
                cmd.startsWith(sendPrefix("t1")) || cmd.startsWith(sendPrefix("s1")) ->
                    if (sendFails) """{"code":"not_running","error":"api is not running","v":1}""" else """{"sent":true,"v":1}"""
                cmd == Cmd.key("t1", Key.Esc) -> """{"sent":true,"v":1}"""
                else -> VERSION_OK
            }
        }
        val settings = MemorySettings().also { it.paired.value = Paired("mini", "me", "Fold") }
        val repo = Repository(settings, { key }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), backgroundScope)
        repo.start()
        runCurrent()
        return repo to conn
    }

    @Test
    fun claudeTilesFollowTheTranscriptAndTrackSends() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        conn.stream(Cmd.transcript("t1", follow = true)).send("""{"hasMore":false,"messages":[{"id":"a1","role":"assistant","text":"hello"}],"v":1}""")
        runCurrent()
        assertEquals(listOf("hello"), c.transcript.value.messages.map { it.text })
        c.draft.value = TextFieldValue("  run the tests ")
        c.send()
        runCurrent()
        assertEquals("", c.draft.value.text)
        assertTrue(Cmd.send("t1", "run the tests") in conn.ran)
        assertEquals(SendState.Sent, c.outgoing.value.single().state)
        conn.stream(Cmd.transcript("t1", follow = true)).send("""{"message":{"id":"u1","role":"user","text":"run the tests"},"type":"message","v":1}""")
        runCurrent()
        assertTrue(c.outgoing.value.isEmpty())
        sendFails = true
        c.draft.value = TextFieldValue("again")
        c.send()
        runCurrent()
        assertEquals(SendState.Failed, c.outgoing.value.single().state)
        sendFails = false
        c.retry(c.outgoing.value.single().id)
        runCurrent()
        assertEquals(SendState.Sent, c.outgoing.value.single().state)
        c.key(Key.Esc)
        runCurrent()
        assertTrue(Cmd.key("t1", Key.Esc) in conn.ran)
        c.close()
    }

    @Test
    fun permissionQuestionsAreFetchedAndAnsweredByNumber() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot("permission"))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        assertEquals("rm -rf build", c.pending.value!!.summary)
        c.answer(Opt(2, "Yes, always"))
        runCurrent()
        assertTrue(Cmd.answer("t1", "2", "rm -rf build") in conn.ran)
        assertNull(c.pending.value)
        assertNull(c.notice.value)
        conn.stream(Cmd.watch()).send("""{"tile":{"cwd":"/p/api","id":"t1","kind":"claude","name":"api","running":true,"status":"working"},"type":"tile","v":1}""")
        runCurrent()
        assertNull(c.pending.value)
        c.close()
    }

    @Test
    fun shellTilesFollowOutputAndKeepFailedCommandsInTheField() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "s1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        conn.stream(Cmd.output("s1", lines = 300, follow = true)).send("""{"cols":80,"rows":2,"cursor":[1,2],"lines":[[{"text":"$ ls"}],[{"text":"$ "}]],"v":1}""")
        runCurrent()
        assertEquals("$ ls", c.screen.value.lines[0][0].text)
        sendFails = true
        c.draft.value = TextFieldValue("make")
        c.send()
        runCurrent()
        assertEquals("make", c.draft.value.text)
        assertEquals("Couldn't send: api is not running", c.notice.value)
        assertTrue(c.outgoing.value.isEmpty())
        c.close()
    }
}
