package dev.swarmz.phone.data

import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.FakeConn
import dev.swarmz.phone.link.VERSION_OK
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.SshConnection
import dev.swarmz.phone.ssh.SshConnector
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant

/** Connections by host; each host hands out its queue in order. */
class HostConnector(val byHost: Map<String, ArrayDeque<SshConnection>>) : SshConnector {
    val auths = mutableListOf<Auth>()
    override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection {
        auths += auth
        return byHost[host]?.removeFirstOrNull() ?: throw dev.swarmz.phone.ssh.Unreachable(host, Exception("no more"))
    }
}

private const val NO_MACHINES = """{"machines":[],"v":1}"""
private const val MACHINES = """{"machines":[{"name":"mini","alias":"Mini","online":true,"self":true},{"name":"studio","online":true,"self":false}],"v":1}"""
private const val T1 = "t1"
private fun snapshot(id: String, name: String) =
    """{"tiles":[{"cwd":"/p/$name","id":"$id","kind":"claude","name":"$name","running":true,"status":"idle"}],"type":"snapshot","v":1}"""

@OptIn(ExperimentalCoroutinesApi::class)
class RepositoryTest {
    private lateinit var key: PhoneKey

    @Before
    fun setUp() {
        installBouncyCastle()
        key = PhoneKey(Ed25519.generate())
    }

    private fun TestScope.repo(settings: SettingsStore, connector: SshConnector) =
        Repository(settings, { key }, connector, backgroundScope) { Instant.ofEpochMilli(testScheduler.currentTime) }

    private fun paired(host: String) = MemorySettings().also { it.paired.value = Paired(host, "me", "Fold") }

    @Test
    fun pairedMacAndDiscoveredMacsBothFeedTiles() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) MACHINES else VERSION_OK }
        val studio = FakeConn()
        val connector = HostConnector(mapOf("mini.tail.ts.net" to ArrayDeque(listOf(mini)), "studio" to ArrayDeque(listOf(studio))))
        val settings = paired("mini.tail.ts.net")
        val repo = repo(settings, connector)
        repo.start()
        runCurrent()
        mini.stream(Cmd.watch()).send(snapshot(T1, "api"))
        studio.stream(Cmd.watch()).send(snapshot("t2", "web"))
        runCurrent()
        assertEquals(setOf("api", "web"), repo.tiles.value.map { it.row.name }.toSet())
        val labels = repo.macs.value.associate { it.name to it.label }
        assertEquals("Mini", labels["mini.tail.ts.net"])
        assertEquals("studio", labels["studio"])
        assertTrue(connector.auths.all { it is Auth.Key && it.user == "me" })
        assertEquals(listOf("Mini", "studio"), settings.macs.value.map { it.label })
    }

    @Test
    fun commandsGoToTheRightMac() = runTest {
        val mini = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> NO_MACHINES
                Cmd.answer(T1, "yes", "npm test") -> """{"answered":true,"option":{"n":1,"label":"Yes"},"v":1}"""
                Cmd.pending(T1) -> """{"pending":null,"v":1}"""
                Cmd.send(T1, "hi") -> """{"sent":true,"v":1}"""
                else -> VERSION_OK
            }
        }
        val repo = repo(paired("mini"), HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)))))
        repo.start()
        runCurrent()
        val k = TileKey("mini", T1)
        assertEquals(1, repo.answer(k, "yes", "npm test").option!!.n)
        assertNull(repo.pending(k))
        repo.send(k, "hi")
        assertTrue(Cmd.send(T1, "hi") in mini.ran)
    }

    @Test
    fun transcriptSessionsResumeAfterTheLastMessageAndLoadOlder() = runTest {
        val older = """{"hasMore":false,"messages":[{"id":"a0","role":"user","text":"first"}],"v":1}"""
        val first = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> NO_MACHINES
                Cmd.transcript(T1, before = "a1") -> older
                else -> VERSION_OK
            }
        }
        val second = FakeConn { if (it == Cmd.machines()) NO_MACHINES else VERSION_OK }
        val repo = repo(paired("mini"), HostConnector(mapOf("mini" to ArrayDeque(listOf(first, second)))))
        repo.start()
        runCurrent()
        val s = repo.openTranscript(TileKey("mini", T1))
        runCurrent()
        val open = Cmd.transcript(T1, follow = true)
        first.stream(open).send("""{"hasMore":true,"messages":[{"id":"a1","role":"assistant","text":"hi"}],"v":1}""")
        runCurrent()
        assertEquals(listOf("a1"), s.state.value.messages.map { it.id })
        s.loadOlder()
        assertEquals(listOf("a0", "a1"), s.state.value.messages.map { it.id })
        first.stream(Cmd.watch()).close(java.io.IOException("reset"))
        first.stream(open).close(java.io.IOException("reset"))
        advanceTimeBy(1_001)
        runCurrent()
        val resume = Cmd.transcript(T1, after = "a1", follow = true)
        assertTrue(resume in second.ran)
        second.stream(resume).send("""{"hasMore":false,"messages":[{"id":"a1","role":"assistant","text":"hi"},{"id":"a2","role":"user","text":"more"}],"v":1}""")
        runCurrent()
        assertEquals(listOf("a0", "a1", "a2"), s.state.value.messages.map { it.id })
        s.close()
    }

    @Test
    fun outputSessionsReportOldSessions() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) NO_MACHINES else VERSION_OK }
        val repo = repo(paired("mini"), HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)))))
        repo.start()
        runCurrent()
        val out = repo.openOutput(TileKey("mini", T1))
        runCurrent()
        mini.stream(Cmd.output(T1, lines = 300, follow = true))
            .send("""{"code":"old_session","error":"restart this tile to use it from the phone","v":1}""")
        runCurrent()
        assertEquals("restart this tile to use it from the phone", out.error.value)
        out.close()
    }

    @Test
    fun oldToolsBecomeBannersAndSeenIsStored() = runTest {
        val old = FakeConn { """{"protocol":0,"tool":"0.0.1","v":1}""" }
        val repo = repo(paired("mini"), HostConnector(mapOf("mini" to ArrayDeque(listOf(old)))))
        repo.start()
        runCurrent()
        assertEquals(listOf(Banner("mini", "Update swarmz on mini")), repo.banners.value)
        repo.markSeen(TileKey("mini", T1))
        runCurrent()
        assertEquals(Instant.ofEpochMilli(testScheduler.currentTime), repo.seen.value[TileKey("mini", T1)])
    }
    @Test
    fun transcriptToolFailuresStopTheSession() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) NO_MACHINES else VERSION_OK }
        val repo = repo(paired("mini"), HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)))))
        repo.start()
        runCurrent()
        val s = repo.openTranscript(TileKey("mini", T1))
        runCurrent()
        val open = Cmd.transcript(T1, follow = true)
        mini.stream(open).send("""{"code":"old_session","error":"restart this tile to use it from the phone","v":1}""")
        runCurrent()
        assertEquals("restart this tile to use it from the phone", s.error.value)
        assertEquals(1, mini.ran.count { it == open })
        s.close()
    }

    @Test
    fun malformedStreamLinesEndTheSessionWithAnError() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) NO_MACHINES else VERSION_OK }
        val repo = repo(paired("mini"), HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)))))
        repo.start()
        runCurrent()
        val out = repo.openOutput(TileKey("mini", T1))
        runCurrent()
        mini.stream(Cmd.output(T1, lines = 300, follow = true)).send("not json")
        runCurrent()
        assertTrue(out.error.value != null)
        out.close()
    }

    @Test
    fun unpairingStopsEveryLink() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) MACHINES else VERSION_OK }
        val studio = FakeConn()
        val settings = paired("mini")
        val repo = repo(settings, HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)), "studio" to ArrayDeque(listOf(studio)))))
        repo.start()
        runCurrent()
        mini.stream(Cmd.watch()).send(snapshot(T1, "api"))
        runCurrent()
        assertEquals(2, repo.macs.value.size)
        settings.setPaired(null)
        runCurrent()
        assertTrue(mini.closed)
        assertTrue(studio.closed)
        assertTrue(repo.macs.value.isEmpty())
        assertTrue(repo.tiles.value.isEmpty())
        try {
            repo.send(TileKey("mini", T1), "hi")
            org.junit.Assert.fail("expected LinkDown")
        } catch (_: dev.swarmz.phone.link.LinkDown) {
        }
    }
}
