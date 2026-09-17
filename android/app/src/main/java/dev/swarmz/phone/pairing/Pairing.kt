package dev.swarmz.phone.pairing

import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.data.SettingsStore
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.proto.APP_PROTOCOL
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.proto.MachineResult
import dev.swarmz.phone.proto.PhoneAddReply
import dev.swarmz.phone.proto.ToolFailure
import dev.swarmz.phone.proto.ToolJson
import dev.swarmz.phone.proto.Version
import dev.swarmz.phone.proto.validDevice
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.AuthRejected
import dev.swarmz.phone.ssh.HostKeyChanged
import dev.swarmz.phone.ssh.SshConnection
import dev.swarmz.phone.ssh.SshConnector
import dev.swarmz.phone.ssh.Unreachable
import dev.swarmz.phone.proto.PHONE_KEY_EXEC_MS
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException

data class PairResult(val others: List<MachineResult>)

/** Tailscale's ranges: IPv4 100.64.0.0/10 (CGNAT) and IPv6 fd7a:115c:a1e0::/48. */
internal fun isTailscaleAddress(a: InetAddress): Boolean {
    val b = a.address.map { it.toInt() and 0xFF }
    return when (a) {
        is Inet4Address -> b[0] == 100 && (b[1] and 0xC0) == 64
        is Inet6Address -> b.take(6) == listOf(0xFD, 0x7A, 0x11, 0x5C, 0xA1, 0xE0)
        else -> false
    }
}

/**
 * Whether every address [host] resolves to is a Tailscale one, so the password only ever travels over the tailnet.
 * A name that does not resolve at all is reported as unreachable.
 */
suspend fun resolvesToTailscale(host: String): Boolean = withContext(Dispatchers.IO) {
    val all = try {
        InetAddress.getAllByName(host)
    } catch (_: UnknownHostException) {
        throw PairingError("Can't reach $host. Is Tailscale connected?")
    }
    all.isNotEmpty() && all.all(::isTailscaleAddress)
}

class PairingError(message: String) : Exception(message)

private val HOST = Regex("^[A-Za-z0-9.-]{1,253}$")
private val USER = Regex("^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$")

/**
 * Logs in to a Mac once with the user's password, installs the phone's public key there, then
 * confirms key login works before saving the pairing. The password is used once and never stored
 * or logged; it is wiped on every path, success or failure.
 *
 * With a Mac already paired this adds another one: the phone keeps the device name it is known by,
 * so that `phone revoke` finds it on every Mac, and the new pairing joins the list.
 */
class Pairing(
    private val connector: SshConnector,
    private val keys: () -> PhoneKey,
    private val settings: SettingsStore,
    private val port: Int = 22,
    /** Whether a host is on the tailnet; tests, whose Mac is on 127.0.0.1, replace it. */
    private val resolver: suspend (String) -> Boolean = ::resolvesToTailscale,
) {
    suspend fun pair(host: String, user: String, password: CharArray, device: String): PairResult {
        try {
            // Adding a Mac: the saved device name is the phone's name everywhere, whatever the screen sent.
            val first = settings.paired.value
            val name = first?.device ?: device
            if (!validDevice(name)) throw PairingError("That device name can't be used.")
            if (!HOST.matches(host)) throw PairingError("That Mac name can't be used.")
            if (!USER.matches(user)) throw PairingError("That username can't be used.")
            if (!resolver(host)) {
                throw PairingError("$host isn't a Tailscale address. Use the Mac's Tailscale name (for example mini or mini.tailnet.ts.net).")
            }
            val key = keys()
            val reply = passwordSession(host, user, password).use { conn ->
                // This one-off session has no phone key yet, so it can't go through the ssh-gate
                // (which only accepts key logins); it runs the tool by its absolute path instead,
                // the same way `Cmd.phoneAdd` does. Once the key is installed, the login check
                // below reuses `Cmd.version()`, which does go through the gate.
                val v = conn.exec("${Cmd.TOOL_PATH} ${Cmd.quote("version")}")
                val version = try {
                    ToolJson.decode<Version>(v.stdout)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    null
                } ?: throw PairingError("swarmz isn't installed on $host yet. Open swarmz on that Mac once, then try again.")
                if (version.protocol < APP_PROTOCOL) throw PairingError("Update swarmz on $host first.")
                try {
                    ToolJson.decode<PhoneAddReply>(conn.exec(Cmd.phoneAdd(name, key.openSsh), PHONE_KEY_EXEC_MS).stdout)
                } catch (e: ToolFailure) {
                    throw PairingError(e.message)
                }
            }
            try {
                connector.connect(host, port, Auth.Key(user, key)).use { conn ->
                    ToolJson.decode<Version>(conn.exec(Cmd.version()).stdout)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                throw PairingError("The key was added, but logging in with it failed: ${e.message}")
            }
            val paired = Paired(host, user, name)
            if (first == null) settings.setPaired(paired) else settings.addPairing(paired)
            return PairResult(reply.machines)
        } finally {
            password.fill(Char.MIN_VALUE)
        }
    }

    private suspend fun passwordSession(host: String, user: String, password: CharArray): SshConnection = try {
        connector.connect(host, port, Auth.Password(user, password))
    } catch (e: AuthRejected) {
        throw PairingError("Wrong username or password, or Remote Login is off on $host.")
    } catch (e: Unreachable) {
        throw PairingError("Can't reach $host. Is Tailscale connected?")
    } catch (e: HostKeyChanged) {
        throw PairingError("$host presented a different host key than before.")
    }
}
