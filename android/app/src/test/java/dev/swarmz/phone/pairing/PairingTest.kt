package dev.swarmz.phone.pairing

import dev.swarmz.phone.data.MemorySettings
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.ssh.FakeMac
import dev.swarmz.phone.ssh.SshjConnector
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

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

    private fun pairing(port: Int = mac.port) = Pairing(SshjConnector(settings), { key }, settings, port)

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
}
