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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
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

private fun snapshot(webTurnEnded: String) =
    """{"tiles":[{"cwd":"/p/api","id":"t1","kind":"claude","name":"api","needs":"permission","running":true,"since":"2026-09-17T10:00:00Z","status":"blocked","summary":"npm tes"},""" +
        """{"cwd":"/p/web","id":"t2","kind":"claude","name":"web","running":true,"status":"idle","turnEndedAt":"$webTurnEnded"}],"type":"snapshot","v":1}"""

private val PERMISSION_SNAPSHOT = snapshot("2026-09-17T10:05:00Z")
private const val QUESTION = """{"pending":{"tool":"Bash","summary":"npm test","options":[{"n":1,"label":"Yes"},{"n":2,"label":"No"}]},"v":1}"""
private const val NO_QUESTION = """{"pending":null,"v":1}"""
private val API = TileKey("mini", "t1")
private val WEB = TileKey("mini", "t2")

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelTest {
    private lateinit var key: PhoneKey

    @Before
    fun setUp() {
        installBouncyCastle()
        key = PhoneKey(Ed25519.generate())
    }

    private class Env {
        lateinit var vm: AppViewModel
        lateinit var conn: FakeConn
        val settings = MemorySettings().also { it.paired.value = Paired("mini", "me", "Fold") }
        /** What `pending` answers. */
        var pending = QUESTION
        /** When set, answering takes the question off the screen. */
        var answerClearsQuestion = true
        /** The phone's clock. */
        var clock: Instant = Instant.parse("2026-09-17T10:10:00Z")
        val ticks = MutableStateFlow(0)

        suspend fun push(json: String) = conn.stream(Cmd.watch()).send(json)
    }

    private suspend fun TestScope.env(
        answer: String = """{"answered":true,"option":{"n":1,"label":"Yes"},"v":1}""",
        setup: Env.() -> Unit = {},
    ): Env {
        val e = Env().apply(setup)
        e.conn = FakeConn { cmd ->
            when (cmd) {
                Cmd.machines() -> """{"machines":[],"v":1}"""
                Cmd.pending("t1") -> e.pending
                Cmd.answer("t1", "yes", "npm test"), Cmd.answer("t1", "deny", "npm test") -> {
                    if (e.answerClearsQuestion) e.pending = NO_QUESTION
                    answer
                }
                else -> VERSION_OK
            }
        }
        val now = { e.clock }
        val repo = Repository(e.settings, { key }, HostConnector(mapOf("mini" to ArrayDeque(listOf(e.conn)))), backgroundScope, now)
        repo.start()
        e.vm = AppViewModel(repo, e.settings, pairing = null, scope = backgroundScope, now = now, ticks = e.ticks)
        e.vm.setVisible(true)
        runCurrent()
        e.push(PERMISSION_SNAPSHOT)
        runCurrent()
        return e
    }

    @Test
    fun permissionCardsUseTheScreensSummaryAndAnswerWithIt() = runTest {
        val e = env()
        val ui = e.vm.home.value
        assertEquals(listOf("api", "web"), ui.model.needs.map { it.row.name }.sorted())
        assertEquals("npm test", ui.asks[API]!!.summary)
        e.vm.allowOnce(API)
        runCurrent()
        assertTrue(Cmd.answer("t1", "yes", "npm test") in e.conn.ran)
        assertFalse(API in e.vm.home.value.asks)
    }

    @Test
    fun ignoredAnswersDisappearQuietly() = runTest {
        val e = env(answer = """{"ignored":true,"reason":"no question is showing","v":1}""")
        e.vm.deny(API)
        runCurrent()
        assertTrue(Cmd.answer("t1", "deny", "npm test") in e.conn.ran)
        assertFalse(API in e.vm.home.value.asks)
    }

    @Test
    fun anIgnoredAnswerWhileStillBlockedBringsTheCardBack() = runTest {
        val e = env(answer = """{"ignored":true,"reason":"no question is showing","v":1}""") { answerClearsQuestion = false }
        e.vm.deny(API)
        runCurrent()
        assertEquals(2, e.conn.ran.count { it == Cmd.pending("t1") })
        assertEquals("npm test", e.vm.home.value.asks[API]!!.summary)
    }

    @Test
    fun aMissingQuestionIsNotCachedAndIsFetchedAgain() = runTest {
        val e = env { pending = NO_QUESTION }
        assertFalse(API in e.vm.home.value.asks)
        e.pending = QUESTION
        advanceTimeBy(2_001)
        runCurrent()
        assertEquals("npm test", e.vm.home.value.asks[API]!!.summary)
    }

    @Test
    fun theOpenTileStaysSeenWhenANewTurnEnds() = runTest {
        val e = env()
        e.vm.open(WEB)
        runCurrent()
        e.clock = Instant.parse("2026-09-17T10:20:00Z")
        e.push(snapshot("2026-09-17T10:15:00Z"))
        runCurrent()
        assertEquals(listOf("api"), e.vm.home.value.model.needs.map { it.row.name })
    }

    @Test
    fun aMacClockAheadOfThePhoneDoesNotResurfaceTheOpenTile() = runTest {
        val e = env()
        e.vm.open(WEB)
        runCurrent()
        e.push(snapshot("2026-09-17T10:30:00Z"))
        runCurrent()
        assertEquals(Instant.parse("2026-09-17T10:30:00Z"), e.settings.seen.value[WEB])
        assertEquals(listOf("api"), e.vm.home.value.model.needs.map { it.row.name })
    }

    @Test
    fun tilesAreOnlyMarkedSeenWhileTheAppIsVisible() = runTest {
        val e = env()
        e.vm.open(WEB)
        runCurrent()
        e.vm.setVisible(false)
        e.clock = Instant.parse("2026-09-17T10:20:00Z")
        e.push(snapshot("2026-09-17T10:15:00Z"))
        runCurrent()
        assertEquals(listOf("api", "web"), e.vm.home.value.model.needs.map { it.row.name }.sorted())
        e.vm.setVisible(true)
        runCurrent()
        assertEquals(listOf("api"), e.vm.home.value.model.needs.map { it.row.name })
        assertEquals(Instant.parse("2026-09-17T10:20:00Z"), e.settings.seen.value[WEB])
    }

    @Test
    fun theHomeClockMovesOnEachTick() = runTest {
        val e = env()
        e.clock = Instant.parse("2026-09-17T10:40:00Z")
        e.ticks.value = 1
        runCurrent()
        assertEquals(Instant.parse("2026-09-17T10:40:00Z"), e.vm.home.value.now)
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
