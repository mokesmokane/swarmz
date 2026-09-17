package dev.swarmz.phone.link

import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.proto.ToolFailure
import dev.swarmz.phone.proto.Version
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.HostKeyChanged
import dev.swarmz.phone.ssh.Unreachable
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MacLinkTest {
    private val auth: suspend () -> Auth = { Auth.Password("me", CharArray(0)) }
    private val snapshot = """{"tiles":[{"cwd":"/p","id":"t1","kind":"claude","name":"one","running":true,"status":"idle"}],"type":"snapshot","v":1}"""
    private val tileWorking = """{"tile":{"cwd":"/p","id":"t1","kind":"claude","name":"one","running":true,"status":"working"},"type":"tile","v":1}"""

    private fun TestScope.link(connector: FakeConnector) =
        MacLink("mini", "mini", auth, connector, backgroundScope) { testScheduler.currentTime }

    @Test
    fun backoff() {
        assertEquals(listOf(1000L, 2000, 4000, 8000, 16000, 30000, 30000), (0..6).map(::backoffMs))
    }

    @Test
    fun reconnectsWithBackoffThenWatches() = runTest {
        val conn = FakeConn()
        val connector = FakeConnector(Unreachable("mini", Exception("x")), Unreachable("mini", Exception("x")), conn)
        val link = link(connector)
        link.start()
        runCurrent()
        assertTrue(link.state.value is LinkState.Offline)
        advanceTimeBy(1_001)
        assertEquals(2, connector.connects)
        advanceTimeBy(2_001)
        assertEquals(3, connector.connects)
        assertTrue(link.state.value is LinkState.Online)
        conn.stream(Cmd.watch()).send(snapshot)
        runCurrent()
        assertEquals("idle", link.tiles.value["t1"]!!.status)
        conn.stream(Cmd.watch()).send(tileWorking)
        runCurrent()
        assertEquals("working", link.tiles.value["t1"]!!.status)
        conn.stream(Cmd.watch()).send("""{"id":"t1","type":"gone","v":1}""")
        runCurrent()
        assertTrue(link.tiles.value.isEmpty())
        assertTrue(link.lastSeen.value != null)
    }

    @Test
    fun aDroppedWatchReconnects() = runTest {
        val first = FakeConn()
        val second = FakeConn()
        val connector = FakeConnector(first, second)
        val link = link(connector)
        link.start()
        runCurrent()
        first.stream(Cmd.watch()).close(java.io.IOException("reset"))
        runCurrent()
        assertTrue(first.closed)
        assertTrue(link.state.value is LinkState.Offline)
        advanceTimeBy(1_001)
        assertTrue(link.state.value is LinkState.Online)
        second.stream(Cmd.watch()).send(snapshot)
        runCurrent()
        assertEquals(1, link.tiles.value.size)
    }

    @Test
    fun changedHostKeysBlockUntilRetried() = runTest {
        val connector = FakeConnector(HostKeyChanged("mini", "a", "b"), FakeConn())
        val link = link(connector)
        link.start()
        runCurrent()
        assertTrue(link.state.value is LinkState.Blocked)
        advanceTimeBy(120_000)
        assertEquals(1, connector.connects)
        link.retryNow()
        runCurrent()
        assertTrue(link.state.value is LinkState.Online)
    }

    @Test
    fun oldToolsAreReported() = runTest {
        val old = FakeConn { """{"protocol":0,"tool":"0.0.1","v":1}""" }
        val link = link(FakeConnector(old, FakeConn()))
        link.start()
        runCurrent()
        assertEquals(LinkState.TooOld(Version("0.0.1", 0)), link.state.value)
        advanceTimeBy(30_001)
        assertTrue(link.state.value is LinkState.Online)
    }

    @Test
    fun callWaitsForOnlineAndDecodesErrors() = runTest {
        val conn = FakeConn { cmd ->
            if (cmd == Cmd.pending("t1")) """{"code":"old_session","error":"restart","v":1}""" else VERSION_OK
        }
        val link = link(FakeConnector(Unreachable("mini", Exception("x")), conn))
        link.start()
        val pending = async {
            try {
                link.call<dev.swarmz.phone.proto.PendingReply>(Cmd.pending("t1"))
                "no error"
            } catch (e: ToolFailure) {
                e.code
            }
        }
        advanceTimeBy(1_001)
        assertEquals("old_session", pending.await())
    }

    @Test
    fun callFailsWhenTheMacStaysOffline() = runTest {
        val link = link(FakeConnector(*Array(20) { Unreachable("mini", Exception("x")) }))
        link.start()
        try {
            link.exec(Cmd.ls(), waitMs = 5_000)
            fail("expected LinkDown")
        } catch (_: LinkDown) {
        }
    }

    @Test
    fun followResumesWithAFreshCommandAfterADrop() = runTest {
        val first = FakeConn()
        val second = FakeConn()
        val link = link(FakeConnector(first, second))
        link.start()
        runCurrent()
        var n = 0
        val got = async { link.follow { "cmd-${n++}" }.take(3).toList() }
        runCurrent()
        first.stream("cmd-0").send("a")
        runCurrent()
        // The connection drops: both the watch and the follow stream fail.
        first.stream(Cmd.watch()).close(java.io.IOException("reset"))
        first.stream("cmd-0").close(java.io.IOException("reset"))
        advanceTimeBy(1_001)
        runCurrent()
        second.stream("cmd-1").send("b")
        second.stream("cmd-1").send("c")
        assertEquals(listOf("a", "b", "c"), got.await())
    }
}
