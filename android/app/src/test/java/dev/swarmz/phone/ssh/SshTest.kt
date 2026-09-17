package dev.swarmz.phone.ssh

import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.keys.Ed25519
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SshTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var mac: FakeMac
    private val pins = MemoryPins()

    @Before
    fun up() {
        installBouncyCastle()
        mac = FakeMac(tmp.root.toPath().resolve("host.key")) { command, out, stopped ->
            when {
                command == "echo" -> { out.write("one\ntwo\n".toByteArray()); 0 }
                command == "fail" -> { out.write("{\"v\":1,\"error\":\"nope\",\"code\":\"usage\"}\n".toByteArray()); 1 }
                command == "tick" -> {
                    var i = 0
                    while (!stopped() && i < 200) {
                        out.write("line $i\n".toByteArray()); out.flush(); i++
                        Thread.sleep(20)
                    }
                    0
                }
                command == "hang" -> {
                    while (!stopped()) Thread.sleep(20)
                    0
                }
                else -> 127
            }
        }
    }

    @After fun down() = mac.close()

    private val password get() = Auth.Password("me", "pw".toCharArray())

    @Test
    fun execReturnsOutputAndExitCode() = runBlocking {
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use { c ->
            assertEquals(ExecResult(0, "one\ntwo\n", ""), c.exec("echo"))
            assertEquals(1, c.exec("fail").exit)
            assertTrue(c.exec("fail").stdout.contains("nope"))
        }
    }

    @Test
    fun linesStreamAndCancellationClosesTheChannel() = runBlocking {
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use { c ->
            val first = withTimeout(5_000) { c.lines("tick").take(3).toList() }
            assertEquals(listOf("line 0", "line 1", "line 2"), first)
            withTimeout(5_000) { while ("tick" !in mac.destroyed) kotlinx.coroutines.delay(20) }
            assertEquals(listOf("one", "two"), c.lines("echo").toList())
        }
    }

    @Test
    fun hostKeysArePinnedAndAChangeIsRefused() = runBlocking {
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).close()
        val pinned = pins.get("127.0.0.1:${mac.port}")!!
        assertTrue(pinned.startsWith("SHA256:"))
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).close()
        // Same host:port, different host key.
        pins.put("127.0.0.1:${mac.port}", "SHA256:somethingElse")
        try {
            SshjConnector(pins).connect("127.0.0.1", mac.port, password)
            fail("expected HostKeyChanged")
        } catch (e: HostKeyChanged) {
            assertEquals(pinned, e.offered)
        }
    }

    @Test
    fun badPasswordsAndUnknownKeysAreRejected() = runBlocking {
        try {
            SshjConnector(pins).connect("127.0.0.1", mac.port, Auth.Password("me", "wrong".toCharArray()))
            fail("expected AuthRejected")
        } catch (_: AuthRejected) {
        }
        val key = PhoneKey(Ed25519.generate())
        try {
            SshjConnector(pins).connect("127.0.0.1", mac.port, Auth.Key("me", key))
            fail("expected AuthRejected")
        } catch (_: AuthRejected) {
        }
        mac.allowedKeys += key.openSsh + " swarmz-phone:test"
        SshjConnector(pins).connect("127.0.0.1", mac.port, Auth.Key("me", key)).use { c ->
            assertEquals(0, c.exec("echo").exit)
        }
    }

    @Test
    fun linesThrowWhenTheConnectionDrops() = runBlocking {
        val c = SshjConnector(pins).connect("127.0.0.1", mac.port, password)
        var seen = 0
        try {
            withTimeout(5_000) {
                c.lines("tick").collect {
                    seen++
                    if (seen == 2) mac.close()
                }
            }
            fail("expected the stream to fail")
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("the stream neither failed nor ended", e)
        } catch (_: java.io.IOException) {
        } finally {
            c.close()
        }
        assertTrue(seen >= 2)
    }

    @Test
    fun execGivesUpAfterItsTimeout() = runBlocking {
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use { c ->
            val r = withTimeout(5_000) { c.exec("hang", timeoutMs = 200) }
            assertEquals(null, r.exit)
            withTimeout(5_000) { while ("hang" !in mac.destroyed) kotlinx.coroutines.delay(20) }
            assertEquals(ExecResult(0, "one\ntwo\n", ""), c.exec("echo"))
        }
    }

    @Test
    fun connectionsKeepThemselvesAlive() = runBlocking {
        fun keepAlives() = Thread.getAllStackTraces().keys.filter { it is net.schmizz.keepalive.KeepAlive && it.isAlive }
        val before = keepAlives().toSet()
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use {
            val mine = keepAlives().filter { it !in before }
            assertEquals(1, mine.size)
            assertEquals(30, (mine[0] as net.schmizz.keepalive.KeepAlive).keepAliveInterval)
        }
    }

    @Test
    fun unreachableHostsSaySo() = runBlocking {
        try {
            SshjConnector(pins).connect("127.0.0.1", 1, password)
            fail("expected Unreachable")
        } catch (_: Unreachable) {
        }
    }
}
