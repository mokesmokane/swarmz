package dev.swarmz.phone.ssh

import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.keys.Ed25519
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import net.schmizz.keepalive.KeepAliveRunner
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
                    // No pauses and no end: the client's close is the only way out, and data is always in flight.
                    var i = 0
                    while (!stopped()) {
                        out.write("line $i\n".toByteArray()); out.flush(); i++
                    }
                    0
                }
                command == "flood" -> {
                    val chunk = "x".repeat(1023).plus("\n").toByteArray()
                    while (!stopped()) out.write(chunk)
                    0
                }
                command == "dropAfterEof" -> { out.write("x\n".toByteArray()); out.flush(); DROP }
                command == "quiet" -> {
                    out.write("a\nb\nc\n".toByteArray()); out.flush()
                    while (!stopped()) Thread.sleep(20)
                    0
                }
                command == "cut" -> { out.write("x\n".toByteArray()); CUT }
                command.startsWith("swarmz 'upload'") -> {
                    val got = mac.inputs[command]?.size ?: -1
                    out.write("{\"v\":1,\"path\":\"/Users/me/.swarmz/paste/p.bin\",\"size\":$got}\n".toByteArray()); 0
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
    fun execWithInputWritesItAllToStdinAndReportsProgress() = runBlocking {
        val payload = ByteArray(200_000) { (it % 251).toByte() }
        val progress = mutableListOf<Long>()
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use { c ->
            val r = c.exec("swarmz 'upload' '--name' 'p.bin' '--size' '200000'", payload, { progress += it })
            assertEquals(0, r.exit)
            assertTrue(r.stdout, r.stdout.contains("\"size\":200000"))
            assertTrue(mac.inputs["swarmz 'upload' '--name' 'p.bin' '--size' '200000'"]!!.contentEquals(payload))
            assertEquals(200_000L, progress.last())
            assertTrue(progress.size >= 3)
        }
    }

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
    fun stoppingAChattyCommandLeavesTheConnectionUp() = runBlocking {
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use { c ->
            repeat(3) {
                assertEquals(5, withTimeout(5_000) { c.lines("flood").take(5).toList() }.size)
                val r = withTimeout(5_000) { c.exec("flood", timeoutMs = 100) }
                assertEquals(null, r.exit)
                assertTrue(r.stdout.isNotEmpty())
                val cancelled = launch(Dispatchers.IO) { c.exec("flood", timeoutMs = 60_000) }
                delay(100)
                withTimeout(5_000) { cancelled.cancelAndJoin() }
            }
            // Every run has been closed by the Mac, so nothing is in flight any more.
            withTimeout(10_000) { while (mac.destroyed.count { it == "flood" } < 9) delay(20) }
            assertTrue(c.isOpen)
            assertEquals(ExecResult(0, "one\ntwo\n", ""), c.exec("echo"))
        }
    }

    @Test
    fun execFailsWhenTheLinkDropsBeforeTheExitStatus() = runBlocking {
        val c = SshjConnector(pins).connect("127.0.0.1", mac.port, password)
        try {
            withTimeout(5_000) { c.exec("dropAfterEof") }
            fail("expected an IOException")
        } catch (_: java.io.IOException) {
        } finally {
            c.close()
        }
        assertTrue("dropAfterEof" in mac.eofSent)
    }

    @Test
    fun cancellingAQuietStreamClosesTheChannel() = runBlocking {
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use { c ->
            // Nothing more arrives after the third line, so only closing the stream can wake the reader.
            assertEquals(listOf("a", "b", "c"), withTimeout(5_000) { c.lines("quiet").take(3).toList() })
            withTimeout(5_000) { while ("quiet" !in mac.destroyed) delay(20) }
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
    fun aChannelClosedWithoutAnExitStatusIsADrop() = runBlocking {
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use { c ->
            val seen = mutableListOf<String>()
            try {
                withTimeout(5_000) { c.lines("cut").collect { seen += it } }
                fail("expected the stream to fail")
            } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
                throw AssertionError("the stream neither failed nor ended", e)
            } catch (_: java.io.IOException) {
            }
            assertEquals(listOf("x"), seen)
            // A command that exits normally still ends cleanly on the same connection.
            assertEquals(listOf("one", "two"), withTimeout(5_000) { c.lines("echo").toList() })
        }
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
    fun connectionsKeepThemselvesAliveAndGiveUpOnSilentPeers() = runBlocking {
        fun runners() = Thread.getAllStackTraces().keys.filter { it is KeepAliveRunner && it.isAlive }
        val before = runners().toSet()
        SshjConnector(pins).connect("127.0.0.1", mac.port, password).use {
            val mine = runners().filter { it !in before }
            assertEquals(1, mine.size)
            val runner = mine[0] as KeepAliveRunner
            assertEquals(30, runner.keepAliveInterval)
            assertEquals(5, runner.maxAliveCount)
        }
    }

    @Test
    fun aCancelledConnectClosesItsConnection() = runBlocking {
        val checking = CountDownLatch(1)
        val release = CountDownLatch(1)
        mac.beforePasswordCheck = {
            checking.countDown()
            release.await(60, TimeUnit.SECONDS)
        }
        val job = launch(Dispatchers.IO) { SshjConnector(pins).connect("127.0.0.1", mac.port, password) }
        // Waits are only for the steps to happen, never for them not to: they are generous, so load cannot fail them.
        assertTrue("the login reached the Mac", checking.await(60, TimeUnit.SECONDS))
        assertEquals(1, mac.openSessions)
        job.cancel()
        release.countDown()
        job.join()
        withTimeout(60_000) { while (mac.openSessions > 0) delay(20) }
    }

    @Test
    fun fingerprintsMatchOpenSsh() {
        val raw = ByteArray(32) { it.toByte() }
        val x509 = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00) + raw
        val key = KeyFactory.getInstance("Ed25519", "BC").generatePublic(X509EncodedKeySpec(x509))
        val type = "ssh-ed25519".toByteArray()
        val blob = ByteBuffer.allocate(4 + type.size + 4 + raw.size).putInt(type.size).put(type).putInt(raw.size).put(raw).array()
        val expected = "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(blob))
        assertEquals(expected, fingerprint(key))
        // What `ssh-keygen -lf` prints for this key.
        assertEquals("SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA", fingerprint(key))
    }

    @Test
    fun unreachableHostsSaySo() = runBlocking {
        try {
            val closed = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
            SshjConnector(pins).connect("127.0.0.1", closed, password)
            fail("expected Unreachable")
        } catch (_: Unreachable) {
        }
    }
}
