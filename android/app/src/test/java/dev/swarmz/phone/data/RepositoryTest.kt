package dev.swarmz.phone.data

import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.FakeConn
import dev.swarmz.phone.link.VERSION_OK
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.proto.PHONE_KEY_EXEC_MS
import dev.swarmz.phone.link.LinkState
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.AuthRejected
import dev.swarmz.phone.ssh.SshConnection
import dev.swarmz.phone.ssh.SshConnector
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
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

/** Refuses connections to [host] until the virtual clock reaches [upAt]. */
class LateConnector(private val clock: () -> Long, private val host: String, private val upAt: Long, private val inner: SshConnector) : SshConnector {
    override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection {
        if (host == this.host && clock() < upAt) throw dev.swarmz.phone.ssh.Unreachable(host, Exception("down"))
        return inner.connect(host, port, auth)
    }
}

/** Settings whose `setMacs` waits, uncancellably, for [gate]: a write that has started and cannot be abandoned. */
class GatedSettings(val inner: MemorySettings = MemorySettings()) : SettingsStore by inner {
    val gate = CompletableDeferred<Unit>()
    override suspend fun setMacs(list: List<KnownMac>) {
        withContext(NonCancellable) { gate.await() }
        inner.setMacs(list)
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
    fun revokingRunsOnThePairedMacThenForgets() = runTest {
        val mini = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> NO_MACHINES
                Cmd.phoneRevoke("Fold") -> """{"revoked":1,"machines":[],"v":1}"""
                else -> VERSION_OK
            }
        }
        val settings = paired("mini")
        val repo = repo(settings, HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)))))
        repo.start()
        runCurrent()
        mini.stream(Cmd.watch()).send(
            """{"tiles":[{"cwd":"/p/a","id":"t1","kind":"claude","name":"a","running":true,"turnEndedAt":"2026-09-17T09:00:00Z"},""" +
                """{"cwd":"/p/b","id":"t2","kind":"claude","name":"b","running":true,"turnEndedAt":"2026-09-17T10:00:00Z"},""" +
                """{"cwd":"/p/a","id":"t3","kind":"shell","name":"c","running":true}],"type":"snapshot","v":1}""",
        )
        runCurrent()
        assertEquals(listOf("/p/b", "/p/a"), repo.recentFolders("mini"))
        repo.revokeThisPhone()
        runCurrent()
        assertTrue(Cmd.phoneRevoke("Fold") in mini.ran)
        assertEquals(PHONE_KEY_EXEC_MS, mini.timeouts[Cmd.phoneRevoke("Fold")])
        assertNull(settings.paired.value)
        assertTrue(repo.tiles.value.isEmpty())
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
        val chat = repo.openTranscript(TileKey("mini", T1))
        runCurrent()
        mini.stream(Cmd.output(T1, lines = 300, follow = true)).send("not json")
        mini.stream(Cmd.transcript(T1, follow = true)).send("not json")
        runCurrent()
        assertEquals("Couldn't read this tile's output", out.error.value)
        assertEquals("Couldn't read this conversation", chat.error.value)
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
    @Test
    fun discoveryRunsAsSoonAsThePairedMacComesOnline() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) MACHINES else VERSION_OK }
        val studio = FakeConn()
        val hosts = HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)), "studio" to ArrayDeque(listOf(studio))))
        // Down for the first 20 s; the link's backoff next tries at 31 s.
        val repo = repo(paired("mini"), LateConnector({ testScheduler.currentTime }, "mini", 20_000, hosts))
        repo.start()
        advanceTimeBy(20_000)
        assertEquals(listOf("mini"), repo.macs.value.map { it.name })
        advanceTimeBy(12_000)
        runCurrent()
        assertEquals(listOf("mini", "studio"), repo.macs.value.map { it.name })
        assertTrue(repo.macs.value.all { it.online })
    }

    @Test
    fun discoveryRunsAgainWhenThePairedMacReconnects() = runTest {
        val first = FakeConn { if (it == Cmd.machines()) NO_MACHINES else VERSION_OK }
        val second = FakeConn { if (it == Cmd.machines()) MACHINES else VERSION_OK }
        val studio = FakeConn()
        val repo = repo(paired("mini"), HostConnector(mapOf("mini" to ArrayDeque(listOf(first, second)), "studio" to ArrayDeque(listOf(studio)))))
        repo.start()
        runCurrent()
        assertEquals(listOf("mini"), repo.macs.value.map { it.name })
        first.stream(Cmd.watch()).close(java.io.IOException("reset"))
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(listOf("mini", "studio"), repo.macs.value.map { it.name })
    }

    @Test
    fun aPairingChangeWaitsForARoundInProgress() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) MACHINES else VERSION_OK }
        val studio = FakeConn()
        val connector = HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)), "studio" to ArrayDeque(listOf(studio))))
        val settings = GatedSettings().also { it.inner.paired.value = Paired("mini", "me", "Fold") }
        val repo = repo(settings, connector)
        repo.start()
        runCurrent()
        // The round has added studio and is stuck saving the list.
        assertEquals(2, connector.auths.size)
        settings.inner.paired.value = Paired("other", "me", "Fold")
        runCurrent()
        // The reset waits for the round, so nothing of the new pairing has started yet.
        assertEquals(2, connector.auths.size)
        assertTrue(!mini.closed && !studio.closed)
        settings.gate.complete(Unit)
        runCurrent()
        assertTrue(mini.closed && studio.closed)
        assertEquals(3, connector.auths.size)
        assertEquals(listOf("other"), repo.macs.value.map { it.name })
        // The old pairing's list, written by the finished round, is cleared for the new pairing.
        assertEquals(emptyList<KnownMac>(), settings.macs.value)
    }

    @Test
    fun memorySettingsIgnoreMacsWhenUnpaired() = runTest {
        val settings = paired("mini")
        settings.forgetPairing()
        settings.setMacs(listOf(KnownMac("mini", "Mini")))
        assertEquals(emptyList<KnownMac>(), settings.macs.value)
        settings.setPaired(Paired("mini", "me", "Fold"))
        settings.setMacs(listOf(KnownMac("mini", "Mini")))
        assertEquals(listOf(KnownMac("mini", "Mini")), settings.macs.value)
    }

    @Test
    fun sessionsEndWhenTheirLinkStops() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) NO_MACHINES else VERSION_OK }
        val settings = paired("mini")
        val repo = repo(settings, HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)))))
        repo.start()
        runCurrent()
        val out = repo.openOutput(TileKey("mini", T1))
        val chat = repo.openTranscript(TileKey("mini", T1))
        runCurrent()
        settings.setPaired(null)
        runCurrent()
        assertEquals("Disconnected", out.error.value)
        assertEquals("Disconnected", chat.error.value)
        assertTrue(!out.job.isActive && !chat.job.isActive)
    }

    @Test
    fun startingTwiceStartsOnce() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) NO_MACHINES else VERSION_OK }
        val connector = HostConnector(mapOf("mini" to ArrayDeque(listOf(mini, FakeConn()))))
        val repo = repo(paired("mini"), connector)
        repo.start()
        repo.start()
        runCurrent()
        assertEquals(1, connector.auths.size)
        assertEquals(1, repo.macs.value.size)
    }

    @Test
    fun savedMacsAreReachedWhileThePairedMacIsOffline() = runTest {
        val studio = FakeConn()
        val settings = paired("mini").also {
            it.macs.value = listOf(KnownMac("mini", "Mini", 5), KnownMac("studio", "Studio", 7))
        }
        // mini never answers.
        val repo = repo(settings, HostConnector(mapOf("studio" to ArrayDeque(listOf(studio)))))
        repo.start()
        runCurrent()
        studio.stream(Cmd.watch()).send(snapshot("t2", "web"))
        runCurrent()
        assertEquals(listOf("web"), repo.tiles.value.map { it.row.name })
        assertEquals(listOf("mini" to "Mini", "studio" to "Studio"), repo.macs.value.map { it.name to it.label })
        assertEquals(listOf(false, true), repo.macs.value.map { it.online })
        assertEquals(Instant.ofEpochMilli(5), repo.macs.value.first().lastSeen)
    }

    @Test
    fun discoveryKeepsSavedMacsTheMachinesListLeavesOut() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) """{"machines":[{"name":"mini","self":true}],"v":1}""" else VERSION_OK }
        val studio = FakeConn()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        // The paired Mac's version check waits, so studio is up (with a session open) before discovery runs.
        mini.beforeExec = { if (it == Cmd.version()) gate.await() }
        val settings = paired("mini").also { it.macs.value = listOf(KnownMac("mini", "Mini"), KnownMac("studio", "Studio", 9)) }
        val repo = repo(settings, HostConnector(mapOf("mini" to ArrayDeque(listOf(mini)), "studio" to ArrayDeque(listOf(studio)))))
        repo.start()
        runCurrent()
        val out = repo.openOutput(TileKey("studio", "t9"))
        runCurrent()
        assertEquals(listOf("mini", "studio"), repo.macs.value.map { it.name })
        gate.complete(Unit)
        runCurrent()
        // `machines` leaves out Macs that are asleep: studio keeps its link, its session, its label and its entry.
        assertTrue("discovery ran", Cmd.machines() in mini.ran)
        assertEquals(listOf("mini", "studio"), repo.macs.value.map { it.name })
        assertEquals("Studio", repo.macs.value.last().label)
        assertTrue("studio's link stays", !studio.closed)
        assertNull(out.error.value)
        assertTrue("studio's session stays", out.job.isActive)
        assertEquals(listOf(KnownMac("mini", "mini", 0), KnownMac("studio", "Studio", 0)), settings.macs.value)
        out.close()
    }

    @Test
    fun aMacWithoutThePhonesKeyIsNotAHomeBanner() = runTest {
        val mini = FakeConn { if (it == Cmd.machines()) MACHINES else VERSION_OK }
        val rejecting = object : SshConnector {
            val inner = HostConnector(mapOf("mini" to ArrayDeque(listOf(mini))))
            override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection =
                if (host == "studio") throw AuthRejected(host) else inner.connect(host, port, auth)
        }
        val repo = repo(paired("mini"), rejecting)
        repo.start()
        runCurrent()
        assertTrue((repo.macStates.value["studio"] as LinkState.Blocked).keyRejected)
        assertEquals(emptyList<Banner>(), repo.banners.value)

        // The paired Mac refusing the key still is one.
        val refused = repo(paired("mini"), object : SshConnector {
            override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection = throw AuthRejected(host)
        })
        refused.start()
        runCurrent()
        assertEquals(listOf("mini"), refused.banners.value.map { it.mac })
    }
}
