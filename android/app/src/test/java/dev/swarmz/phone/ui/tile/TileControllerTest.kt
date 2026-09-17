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
import dev.swarmz.phone.link.LinkDown
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    private val question = """{"pending":{"tool":"Bash","summary":"rm -rf build","options":[{"n":1,"label":"Yes"},{"n":2,"label":"Yes, always"},{"n":3,"label":"No"}]},"v":1}"""
    /** Replies to `pending t1`, in order; the last one repeats. */
    private var pendingReplies = listOf(question)
    private var pendingCalls = 0
    private var answerReply = """{"ignored":true,"reason":"a different question is showing","v":1}"""
    private lateinit var settings: MemorySettings
    /** The connection the link makes after the first one drops (or after pairing again). */
    private lateinit var conn2: FakeConn

    private fun reply(cmd: String): String = when {
        cmd == Cmd.machines() -> """{"machines":[],"v":1}"""
        cmd == Cmd.pending("t1") -> pendingReplies[minOf(pendingCalls++, pendingReplies.size - 1)]
        cmd == Cmd.answer("t1", "2", "rm -rf build") -> answerReply
        cmd.startsWith(sendPrefix("t1")) || cmd.startsWith(sendPrefix("s1")) ->
            if (sendFails) """{"code":"not_running","error":"api is not running","v":1}""" else """{"sent":true,"v":1}"""
        cmd == Cmd.key("t1", Key.Esc) -> """{"sent":true,"v":1}"""
        cmd == Cmd.image("t1", "i1") -> """{"code":"failed","error":"image gone","v":1}"""
        else -> VERSION_OK
    }

    private fun TestScope.setup(): Pair<Repository, FakeConn> {
        val conn = FakeConn(::reply)
        conn2 = FakeConn(::reply)
        settings = MemorySettings().also { it.paired.value = Paired("mini", "me", "Fold") }
        val repo = Repository(settings, { key }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn, conn2)))), backgroundScope)
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
    fun aSlashCommandSendsWithNoOutgoingBubble() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        c.draft.value = TextFieldValue("/login")
        c.send()
        runCurrent()
        assertEquals("", c.draft.value.text)
        assertTrue(Cmd.send("t1", "/login") in conn.ran)
        assertTrue("a slash command never gets a bubble stuck at the bottom", c.outgoing.value.isEmpty())
        // A failed slash command restores the draft, the way a shell send does.
        sendFails = true
        c.draft.value = TextFieldValue("/login")
        c.send()
        runCurrent()
        assertEquals("/login", c.draft.value.text)
        assertEquals("Couldn't send: api is not running", c.notice.value)
        assertTrue(c.outgoing.value.isEmpty())
        c.close()
    }

    @Test
    fun aSentEntryDisappearsAfterTheTimeout() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        conn.stream(Cmd.transcript("t1", follow = true)).send("""{"hasMore":false,"messages":[{"id":"a1","role":"assistant","text":"hello"}],"v":1}""")
        runCurrent()
        c.draft.value = TextFieldValue("run the tests")
        c.send()
        runCurrent()
        assertEquals(SendState.Sent, c.outgoing.value.single().state)
        advanceTimeBy(SENT_TIMEOUT_MS - 100)
        runCurrent()
        assertEquals("still shown just before the timeout", 1, c.outgoing.value.size)
        advanceTimeBy(200)
        runCurrent()
        assertTrue("a Sent entry can never stick, even with no echo at all", c.outgoing.value.isEmpty())
        c.close()
    }

    @Test
    fun aSentEntryDisappearsWhenLaterMessagesArriveWithoutIt() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        conn.stream(Cmd.transcript("t1", follow = true)).send("""{"hasMore":false,"messages":[{"id":"a1","role":"assistant","text":"hello"}],"v":1}""")
        runCurrent()
        c.draft.value = TextFieldValue("run the tests")
        c.send()
        runCurrent()
        assertEquals(SendState.Sent, c.outgoing.value.single().state)
        // The turn moved on: a later message shows up, but it is not this entry's echo.
        conn.stream(Cmd.transcript("t1", follow = true)).send("""{"message":{"id":"u1","role":"user","text":"something else"},"type":"message","v":1}""")
        runCurrent()
        assertTrue("the turn moved on without echoing it", c.outgoing.value.isEmpty())
        c.close()
    }

    @Test
    fun aFailedEntrySurvivesTheTimeoutAndLaterMessages() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        conn.stream(Cmd.transcript("t1", follow = true)).send("""{"hasMore":false,"messages":[{"id":"a1","role":"assistant","text":"hello"}],"v":1}""")
        runCurrent()
        sendFails = true
        c.draft.value = TextFieldValue("run the tests")
        c.send()
        runCurrent()
        assertEquals(SendState.Failed, c.outgoing.value.single().state)
        advanceTimeBy(SENT_TIMEOUT_MS + 1_000)
        runCurrent()
        assertEquals("a Failed entry never expires", SendState.Failed, c.outgoing.value.single().state)
        conn.stream(Cmd.transcript("t1", follow = true)).send("""{"message":{"id":"u1","role":"user","text":"something else"},"type":"message","v":1}""")
        runCurrent()
        assertEquals("a Failed entry is untouched by later messages too", SendState.Failed, c.outgoing.value.single().state)
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
        // Ignored, and the tile is still blocked: the question is asked again at once and the card comes back.
        assertEquals("rm -rf build", c.pending.value!!.summary)
        assertEquals(2, pendingCalls)
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

    @Test
    fun anAnsweredQuestionIsAskedAgainOnlyAfterAPause() = runTest {
        answerReply = """{"answered":true,"option":{"n":2,"label":"Yes, always"},"v":1}"""
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot("permission"))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        assertEquals(1, pendingCalls)
        c.answer(Opt(2, "Yes, always"))
        runCurrent()
        assertNull(c.pending.value)
        // A new `since` meanwhile waits out the same pause rather than asking at once.
        conn.stream(Cmd.watch()).send(snapshot("permission").replace("10:00:00Z", "10:00:05Z"))
        runCurrent()
        assertEquals(1, pendingCalls)
        advanceTimeBy(ASK_RETRY_MS - 100)
        runCurrent()
        assertNull("the answered question does not come straight back", c.pending.value)
        assertEquals(1, pendingCalls)
        advanceTimeBy(200)
        runCurrent()
        assertEquals(2, pendingCalls)
        assertEquals("rm -rf build", c.pending.value!!.summary)
        c.close()
    }

    @Test
    fun failedQuestionFetchesAreRetriedUnlessTheSessionIsOld() = runTest {
        pendingReplies = listOf("""{"code":"failed","error":"screen busy","v":1}""", """{"pending":null,"v":1}""", question)
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot("permission"))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        assertNull(c.pending.value)
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(2, pendingCalls)
        assertNull(c.pending.value)
        advanceTimeBy(4_100)
        runCurrent()
        assertEquals(3, pendingCalls)
        assertEquals("rm -rf build", c.pending.value!!.summary)
        c.close()

        pendingReplies = listOf("""{"code":"old_session","error":"restart this tile to use it from the phone","v":1}""")
        pendingCalls = 0
        val d = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, pendingCalls)
        assertNull(d.pending.value)
        d.close()
    }

    @Test
    fun aDisconnectedTranscriptReopensWhenTheMacIsBack() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        conn.stream(Cmd.transcript("t1", follow = true)).send("""{"hasMore":true,"messages":[{"id":"a0","role":"assistant","text":"earlier"},{"id":"a1","role":"assistant","text":"hello"}],"v":1}""")
        runCurrent()
        // Pairing again stops every link and ends its sessions.
        settings.paired.value = Paired("mini", "me", "Fold 2")
        runCurrent()
        assertEquals("Disconnected", c.streamError.value)
        assertEquals(listOf("earlier", "hello"), c.transcript.value.messages.map { it.text })
        conn2.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        assertTrue(Cmd.transcript("t1", follow = true) in conn2.ran)
        assertNull(c.streamError.value)
        assertEquals("the conversation stays on screen while it reloads", listOf("earlier", "hello"), c.transcript.value.messages.map { it.text })
        conn2.stream(Cmd.transcript("t1", follow = true)).send("""{"hasMore":false,"messages":[{"id":"a1","role":"assistant","text":"hello"},{"id":"a2","role":"assistant","text":"back"}],"v":1}""")
        runCurrent()
        assertEquals(listOf("earlier", "hello", "back"), c.transcript.value.messages.map { it.text })
        assertTrue(c.transcript.value.hasMore)
        conn2.stream(Cmd.transcript("t1", follow = true)).send("""{"message":{"id":"a3","role":"assistant","text":"live"},"type":"message","v":1}""")
        runCurrent()
        assertEquals("live", c.transcript.value.messages.last().text)
        c.close()
    }

    @Test
    fun aFailedFirstOpenIsRetriedWhenTheLinkComesBack() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        c.openTranscript = { throw LinkDown("mini is not connected") }
        runCurrent()
        assertEquals("mini is not connected", c.streamError.value)
        c.openTranscript = { repo.openTranscript(it) }
        // The watch ends, so the link drops, then reconnects on the next connection a second later.
        conn.stream(Cmd.watch()).close()
        runCurrent()
        assertTrue(!c.macOnline.value)
        advanceTimeBy(1_100)
        runCurrent()
        assertTrue(c.macOnline.value)
        assertNull(c.streamError.value)
        conn2.stream(Cmd.transcript("t1", follow = true)).send("""{"hasMore":false,"messages":[{"id":"a1","role":"assistant","text":"hello"}],"v":1}""")
        runCurrent()
        assertEquals(listOf("hello"), c.transcript.value.messages.map { it.text })
        c.close()
    }

    @Test
    fun failedImagesAreFetchedAgainNextTime() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        c.decoder = StandardTestDispatcher(testScheduler)
        c.loadImage("i1")
        c.loadImage("i1")
        runCurrent()
        assertEquals(1, conn.ran.count { it == Cmd.image("t1", "i1") })
        assertTrue("i1" in c.images.value)
        assertNull(c.images.value["i1"])
        c.loadImage("i1")
        runCurrent()
        assertEquals(2, conn.ran.count { it == Cmd.image("t1", "i1") })
        c.close()
    }

    private fun shellRow(running: Boolean) =
        """{"tile":{"cwd":"/p","id":"s1","kind":"shell","name":"sh","running":$running,"status":"idle"${if (running) "" else ""","exitCode":0"""}},"type":"tile","v":1}"""

    private val screenOne = """{"cols":80,"rows":1,"cursor":[0,2],"lines":[[{"text":"$ "}]],"v":1}"""

    @Test
    fun aRestartedShellShowsOutputAgain() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "s1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        val out = Cmd.output("s1", lines = 300, follow = true)
        conn.stream(out).send(screenOne)
        // The shell exits: the tool reports it and ends the stream cleanly, with no error.
        conn.stream(out).send("""{"type":"exit","v":1}""")
        conn.stream(out).close()
        conn.stream(Cmd.watch()).send(shellRow(running = false))
        runCurrent()
        assertTrue(c.screen.value.exited)
        assertNull(c.streamError.value)
        assertEquals(1, conn.ran.count { it == out })
        // "Restart shell": the row runs again, and the output is followed afresh.
        conn.streams.remove(out)
        conn.stream(Cmd.watch()).send(shellRow(running = true))
        runCurrent()
        assertEquals(2, conn.ran.count { it == out })
        assertFalse(c.screen.value.exited)
        conn.stream(out).send(screenOne.replace("$ ", "$ again"))
        runCurrent()
        assertEquals("$ again", c.screen.value.lines[0][0].text)
        c.close()
    }

    @Test
    fun aSessionThatEndedCleanlyReopensWhenTheMacIsBack() = runTest {
        val (repo, conn) = setup()
        conn.stream(Cmd.watch()).send(snapshot(null))
        runCurrent()
        val c = TileController(TileKey("mini", "t1"), repo, backgroundScope) { Instant.EPOCH }
        runCurrent()
        val open = Cmd.transcript("t1", follow = true)
        conn.stream(open).send("""{"hasMore":false,"messages":[{"id":"a1","role":"assistant","text":"hello"}],"v":1}""")
        conn.stream(open).close()
        runCurrent()
        assertNull(c.streamError.value)
        // The link drops and comes back on the next connection.
        conn.stream(Cmd.watch()).close()
        runCurrent()
        advanceTimeBy(1_100)
        runCurrent()
        assertTrue(c.macOnline.value)
        assertTrue(open in conn2.ran)
        assertEquals(listOf("hello"), c.transcript.value.messages.map { it.text })
        c.close()
    }
}
