package dev.swarmz.phone.link

import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.proto.ToolFailure
import dev.swarmz.phone.proto.Version
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.AuthRejected
import dev.swarmz.phone.ssh.ExecResult
import dev.swarmz.phone.ssh.HostKeyChanged
import dev.swarmz.phone.ssh.Unreachable
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
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

    @Test
    fun followHandsACollectorItsOwnException() = runTest {
        val conn = FakeConn()
        val link = link(FakeConnector(conn))
        link.start()
        runCurrent()
        val thrown = async {
            try {
                withTimeout(10_000) { link.follow { "cmd" }.collect { throw IllegalStateException("mine") } }
                "no error"
            } catch (e: IllegalStateException) {
                e.message
            }
        }
        runCurrent()
        conn.stream("cmd").send("a")
        assertEquals("mine", thrown.await())
    }

    @Test
    fun followTreatsACleanEndOnADroppedConnectionAsADrop() = runTest {
        val first = FakeConn()
        val second = FakeConn()
        val link = link(FakeConnector(first, second))
        link.start()
        runCurrent()
        var n = 0
        val got = async { link.follow { "cmd-${n++}" }.toList() }
        runCurrent()
        first.stream("cmd-0").send("a")
        runCurrent()
        // The watch fails first, then the follow stream ends without an error.
        first.stream(Cmd.watch()).close(java.io.IOException("reset"))
        first.stream("cmd-0").close()
        advanceTimeBy(1_001)
        runCurrent()
        second.stream("cmd-1").send("b")
        second.stream("cmd-1").close()
        assertEquals(listOf("a", "b"), got.await())
    }

    @Test
    fun followResumesWhenItsStreamFailsJustBeforeTheWatch() = runTest {
        val first = FakeConn()
        first.lineFailures = { cmd -> if (cmd == "cmd-0") java.io.IOException("reset") else null }
        val second = FakeConn()
        val link = link(FakeConnector(first, second))
        link.start()
        runCurrent()
        var n = 0
        val got = async { link.follow { "cmd-${n++}" }.take(1).toList() }
        runCurrent()
        // The follow stream has failed while `current` is still the first connection; the watch notices shortly after.
        advanceTimeBy(500)
        assertTrue(link.state.value is LinkState.Online)
        first.stream(Cmd.watch()).close(java.io.IOException("reset"))
        runCurrent()
        assertTrue(!got.isCompleted)
        advanceTimeBy(1_001)
        runCurrent()
        second.stream("cmd-1").send("b")
        assertEquals(listOf("b"), got.await())
    }

    @Test
    fun followEndsNormallyWhenTheCommandEnds() = runTest {
        val conn = FakeConn()
        val link = link(FakeConnector(conn))
        link.start()
        runCurrent()
        val got = async { link.follow { "cmd" }.toList() }
        runCurrent()
        conn.stream("cmd").send("a")
        conn.stream("cmd").close()
        assertEquals(listOf("a"), got.await())
        assertEquals(listOf(Cmd.version(), Cmd.watch(), "cmd"), conn.ran)
    }

    @Test
    fun followRethrowsFailuresThatAreNotDrops() = runTest {
        val conn = FakeConn()
        conn.lineFailures = { cmd ->
            when (cmd) {
                "tool" -> ToolFailure("old_session", "restart")
                "refused" -> java.io.IOException("session refused")
                else -> null
            }
        }
        val link = link(FakeConnector(conn))
        link.start()
        runCurrent()
        suspend fun failure(command: () -> String): Throwable? =
            try {
                withTimeout(60_000) { link.follow(command).toList() }
                null
            } catch (e: Exception) {
                e
            }
        assertEquals("old_session", (failure { "tool" } as ToolFailure).code)
        assertEquals("session refused", (failure { "refused" } as java.io.IOException).message)
        assertEquals("no command", (failure { throw IllegalArgumentException("no command") } as IllegalArgumentException).message)
        assertTrue(link.state.value is LinkState.Online)
    }

    @Test
    fun execMapsFailuresToLinkDown() = runTest {
        val conn = FakeConn()
        val link = link(FakeConnector(conn))
        link.start()
        runCurrent()
        suspend fun down(result: (String) -> ExecResult): String? {
            conn.execs = result
            return try {
                link.exec("x")
                null
            } catch (e: LinkDown) {
                e.message
            }
        }
        assertEquals("broken pipe", down { throw java.io.IOException("broken pipe") })
        assertEquals("mini did not answer in time", down { ExecResult(null, "", "") })
        assertTrue(down { ExecResult(127, "", "zsh: command not found: swarmz") }!!.contains("127"))
        // A tool error still reaches the caller as its JSON.
        assertEquals(null, down { ExecResult(1, """{"code":"usage","error":"bad","v":1}""", "") })
    }

    @Test
    fun aSilentWatchCountsAsADrop() = runTest {
        val conn = FakeConn()
        val link = link(FakeConnector(conn, FakeConn()))
        link.start()
        runCurrent()
        advanceTimeBy(50_000)
        conn.stream(Cmd.watch()).send("""{"type":"ping","v":1}""")
        advanceTimeBy(74_000)
        assertTrue(link.state.value is LinkState.Online)
        assertTrue(!conn.closed)
        advanceTimeBy(1_001)
        assertEquals(LinkState.Offline("mini stopped answering", 126_000), link.state.value)
        assertTrue(conn.closed)
    }

    @Test
    fun retryNowOnlyActsWhenWaiting() = runTest {
        val conn = FakeConn()
        val connector = FakeConnector(conn, FakeConn())
        val link = link(connector)
        link.start()
        runCurrent()
        link.retryNow()
        runCurrent()
        conn.stream(Cmd.watch()).close(java.io.IOException("reset"))
        runCurrent()
        assertTrue(link.state.value is LinkState.Offline)
        assertEquals(1, connector.connects)
        advanceTimeBy(1_001)
        assertEquals(2, connector.connects)
    }

    @Test
    fun anUnreadableVersionSaysSwarmzIsNotAnswering() = runTest {
        val link = link(FakeConnector(FakeConn { "zsh: command not found: swarmz" }))
        link.start()
        runCurrent()
        assertEquals("swarmz isn't answering on mini", (link.state.value as LinkState.Offline).reason)
    }

    @Test
    fun aRejectedKeyBlocksAndSaysHowToPairAgain() = runTest {
        val link = link(FakeConnector(AuthRejected("mini")))
        link.start()
        runCurrent()
        val st = link.state.value as LinkState.Blocked
        assertTrue(st.keyRejected)
        assertEquals("mini refused this phone's key. Pair it again below.", st.reason)
        assertTrue(!(LinkState.Blocked("x")).keyRejected)
    }

    @Test
    fun execPassesItsTimeoutThrough() = runTest {
        val conn = FakeConn()
        val link = link(FakeConnector(conn))
        link.start()
        runCurrent()
        link.exec("a")
        link.exec("b", timeoutMs = 60_000)
        assertEquals(20_000L, conn.timeouts["a"])
        assertEquals(60_000L, conn.timeouts["b"])
    }

    @Test
    fun execChannelsAreLimitedAndStreamsCannotStarveThem() = runTest {
        val conn = FakeConn()
        val gate = CompletableDeferred<Unit>()
        conn.beforeExec = { if (it.startsWith("slow")) gate.await() }
        val link = link(FakeConnector(conn))
        link.start()
        runCurrent()
        repeat(8) { i -> backgroundScope.launch { link.exec("slow $i") } }
        runCurrent()
        assertEquals(EXEC_SLOTS, conn.ran.count { it.startsWith("slow") })
        gate.complete(Unit)
        runCurrent()
        assertEquals(8, conn.ran.count { it.startsWith("slow") })

        // Streams take their own slots: the watch plus FOLLOW_SLOTS follows.
        repeat(FOLLOW_SLOTS + 1) { i -> backgroundScope.launch { link.follow { "follow $i" }.collect {} } }
        runCurrent()
        assertEquals(FOLLOW_SLOTS, conn.ran.count { it.startsWith("follow") })
        // Every stream slot is taken, and exec still runs.
        assertEquals(VERSION_OK, link.exec("quick"))
        // A follow that ends frees its slot for the one waiting.
        conn.stream("follow 0").close()
        runCurrent()
        assertEquals(FOLLOW_SLOTS + 1, conn.ran.count { it.startsWith("follow") })
        assertEquals(10, EXEC_SLOTS + FOLLOW_SLOTS + 1)
    }

    @Test
    fun commandsWaitingForTheLinkHoldNoSlots() = runTest {
        // Offline for good (the next attempt is far off): slots full of commands that wait a long time for it.
        val link = link(FakeConnector(Unreachable("mini", Exception("x")), Unreachable("mini", Exception("x"))))
        link.start()
        runCurrent()
        repeat(EXEC_SLOTS) { i -> backgroundScope.launch { runCatching { link.exec("long $i", waitMs = 600_000) } } }
        runCurrent()
        // A command with a short wait still gives up on time, rather than queueing behind them.
        val short = backgroundScope.async { runCatching { link.exec("short", waitMs = 500) } }
        advanceTimeBy(501)
        runCurrent()
        assertTrue(short.isCompleted)
        assertEquals("mini is offline", short.await().exceptionOrNull()!!.message)
    }
}
