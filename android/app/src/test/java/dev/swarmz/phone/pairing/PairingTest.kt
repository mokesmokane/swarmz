package dev.swarmz.phone.pairing

import dev.swarmz.phone.data.MemorySettings
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.ssh.CUT
import dev.swarmz.phone.proto.PHONE_KEY_EXEC_MS
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.ExecResult
import dev.swarmz.phone.ssh.FakeMac
import dev.swarmz.phone.ssh.SshConnection
import dev.swarmz.phone.ssh.SshConnector
import dev.swarmz.phone.ssh.SshjConnector
import java.net.InetAddress
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PairingTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var mac: FakeMac
    private lateinit var key: PhoneKey
    private val settings = MemorySettings()
    @Volatile private var installed = true
    @Volatile private var protocol = 1
    @Volatile private var acceptKey = true

    @Before
    fun up() {
        installBouncyCastle()
        key = PhoneKey(Ed25519.generate())
        mac = FakeMac(tmp.root.toPath().resolve("host.key")) { command, out, _ ->
            val version = """{"build":1,"protocol":$protocol,"tool":"0.1.0","v":1}""" + "\n"
            when {
                !installed -> { out.write("zsh: no such file or directory\n".toByteArray()); 127 }
                command == "${Cmd.TOOL_PATH} 'version'" || command == Cmd.version() -> { out.write(version.toByteArray()); 0 }
                command.startsWith("${Cmd.TOOL_PATH} 'phone' 'add'") -> {
                    if (acceptKey) mac.allowedKeys += key.openSsh
                    out.write(("""{"added":true,"machines":[{"machine":"studio","ok":true}],"v":1}""" + "\n").toByteArray())
                    0
                }
                else -> 127
            }
        }
    }

    @After fun down() = mac.close()

    /** The timeout each command ran with, over any connection the pairing opens. */
    private val timeouts = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val recording = object : SshConnector {
        val inner = SshjConnector(settings)
        override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection {
            val conn = inner.connect(host, port, auth)
            return object : SshConnection by conn {
                override suspend fun exec(command: String, timeoutMs: Long): ExecResult {
                    timeouts[command] = timeoutMs
                    return conn.exec(command, timeoutMs)
                }
            }
        }
    }

    // The fake Mac listens on 127.0.0.1, which is not a Tailscale address.
    private fun pairing(port: Int = mac.port) = Pairing(recording, { key }, settings, port, resolver = { true })

    private suspend fun message(block: suspend () -> Unit): String = try {
        block()
        "no error"
    } catch (e: PairingError) {
        e.message!!
    }

    @Test
    fun pairsAndSaves() = runBlocking {
        val pw = "pw".toCharArray()
        val result = pairing().pair("127.0.0.1", "me", pw, "Galaxy Fold")
        assertEquals("studio", result.others.single().machine)
        assertEquals(Paired("127.0.0.1", "me", "Galaxy Fold"), settings.paired.value)
        assertTrue(pw.all { it == Char.MIN_VALUE })
        assertTrue(mac.commands.contains(Cmd.phoneAdd("Galaxy Fold", key.openSsh)))
        assertEquals(PHONE_KEY_EXEC_MS, timeouts[Cmd.phoneAdd("Galaxy Fold", key.openSsh)])
    }

    @Test
    fun explainsFailures() = runBlocking {
        assertEquals("That device name can't be used.", message { pairing().pair("127.0.0.1", "me", "pw".toCharArray(), " Fold") })
        assertEquals(
            "Wrong username or password, or Remote Login is off on 127.0.0.1.",
            message { pairing().pair("127.0.0.1", "me", "bad".toCharArray(), "Fold") },
        )
        installed = false
        assertEquals(
            "swarmz isn't installed on 127.0.0.1 yet. Open swarmz on that Mac once, then try again.",
            message { pairing().pair("127.0.0.1", "me", "pw".toCharArray(), "Fold") },
        )
        installed = true
        protocol = 0
        assertEquals("Update swarmz on 127.0.0.1 first.", message { pairing().pair("127.0.0.1", "me", "pw".toCharArray(), "Fold") })
        protocol = 1
        acceptKey = false
        assertTrue(message { pairing().pair("127.0.0.1", "me", "pw".toCharArray(), "Fold") }
            .startsWith("The key was added, but logging in with it failed: "))
        assertNull(settings.paired.value)
        assertEquals("Can't reach 127.0.0.1. Is Tailscale connected?", message { pairing(port = 1).pair("127.0.0.1", "me", "pw".toCharArray(), "Fold") })
    }

    @Test
    fun explainsAHostKeyChange() = runBlocking {
        settings.put("127.0.0.1:${mac.port}", "SHA256:not-the-real-key")
        assertEquals(
            "127.0.0.1 presented a different host key than before.",
            message { pairing().pair("127.0.0.1", "me", "pw".toCharArray(), "Fold") },
        )
    }

    @Test
    fun cancellingDuringKeyLoginDoesNotBecomeAPairingError() = runBlocking {
        val started = CountDownLatch(1)
        mac.handler = { command, out, stopped ->
            val version = """{"build":1,"protocol":$protocol,"tool":"0.1.0","v":1}""" + "\n"
            when {
                command == "${Cmd.TOOL_PATH} 'version'" -> { out.write(version.toByteArray()); 0 }
                command.startsWith("${Cmd.TOOL_PATH} 'phone' 'add'") -> {
                    mac.allowedKeys += key.openSsh
                    out.write(("""{"added":true,"machines":[{"machine":"studio","ok":true}],"v":1}""" + "\n").toByteArray())
                    0
                }
                // The key-login check's own `Cmd.version()` call: hang until the test cancels pair().
                command == Cmd.version() -> {
                    started.countDown()
                    while (!stopped()) Thread.sleep(10)
                    CUT
                }
                else -> 127
            }
        }
        val pw = "pw".toCharArray()
        val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        val result = scope.async { pairing().pair("127.0.0.1", "me", pw, "Fold") }
        assertTrue(started.await(5, TimeUnit.SECONDS))
        result.cancel()
        val outcome = runCatching { result.await() }
        assertTrue(outcome.exceptionOrNull() is CancellationException)
        assertNull(settings.paired.value)
        assertTrue(pw.all { it == Char.MIN_VALUE })
    }

    @Test
    fun onlyTailscaleAddressesGetThePassword() = runBlocking {
        var passwordChecks = 0
        mac.beforePasswordCheck = { passwordChecks++ }
        val pw = "pw".toCharArray()
        val real = Pairing(recording, { key }, settings, mac.port)
        assertEquals(
            "127.0.0.1 isn't a Tailscale address. Use the Mac's Tailscale name (for example mini or mini.tailnet.ts.net).",
            message { real.pair("127.0.0.1", "me", pw, "Fold") },
        )
        assertEquals(0, passwordChecks)
        assertTrue(mac.commands.isEmpty())
        assertTrue(pw.all { it == Char.MIN_VALUE })
        assertNull(settings.paired.value)
        var asked: String? = null
        val stub = Pairing(recording, { key }, settings, mac.port, resolver = { asked = it; false })
        assertEquals(
            "mini isn't a Tailscale address. Use the Mac's Tailscale name (for example mini or mini.tailnet.ts.net).",
            message { stub.pair("mini", "me", "pw".toCharArray(), "Fold") },
        )
        assertEquals("mini", asked)
    }

    @Test
    fun tailscaleAddressRanges() {
        fun ts(a: String) = isTailscaleAddress(InetAddress.getByName(a))
        assertTrue(ts("100.64.0.1"))
        assertTrue(ts("100.127.255.254"))
        assertTrue(ts("fd7a:115c:a1e0::1"))
        assertTrue(ts("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240"))
        for (a in listOf("100.63.255.255", "100.128.0.1", "10.0.0.1", "127.0.0.1", "192.168.1.2", "fd7a:115c:a1e1::1", "::1", "fe80::1")) {
            assertTrue(a, !ts(a))
        }
    }
}
