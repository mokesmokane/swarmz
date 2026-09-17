package dev.swarmz.phone.ssh

import dev.swarmz.phone.keys.PhoneKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.TransportException
import net.schmizz.sshj.userauth.UserAuthException
import java.io.Closeable
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

sealed interface Auth {
    val user: String

    data class Password(override val user: String, val password: CharArray) : Auth
    data class Key(override val user: String, val key: PhoneKey) : Auth
}

class AuthRejected(val host: String) : Exception("$host refused the login")
class Unreachable(val host: String, cause: Throwable) : Exception("could not reach $host: ${cause.message}", cause)

data class ExecResult(val exit: Int?, val stdout: String, val stderr: String)

interface SshConnection : Closeable {
    val isOpen: Boolean
    suspend fun exec(command: String, timeoutMs: Long = 20_000): ExecResult
    fun lines(command: String): Flow<String>
}

interface SshConnector {
    suspend fun connect(host: String, port: Int, auth: Auth): SshConnection
}

class SshjConnector(private val pins: HostKeyPins) : SshConnector {
    override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection = withContext(Dispatchers.IO) {
        val verifier = PinningVerifier(pins, "$host:$port")
        val client = SSHClient(DefaultConfig())
        client.addHostKeyVerifier(verifier)
        client.connectTimeout = 10_000
        // sshj starts the keep-alive thread in onConnect, and only if the interval is already set.
        client.connection.keepAlive.keepAliveInterval = 30
        try {
            client.connect(host, port)
        } catch (e: TransportException) {
            client.close()
            throw verifier.mismatch ?: Unreachable(host, e)
        } catch (e: java.io.IOException) {
            client.close()
            throw Unreachable(host, e)
        }
        try {
            when (auth) {
                is Auth.Password -> client.authPassword(auth.user, auth.password)
                is Auth.Key -> client.authPublickey(auth.user, auth.key.provider())
            }
        } catch (e: UserAuthException) {
            client.close()
            throw AuthRejected(host)
        } catch (e: java.io.IOException) {
            client.close()
            throw Unreachable(host, e)
        }
        SshjConnection(client)
    }
}

private class SshjConnection(private val client: SSHClient) : SshConnection {
    override val isOpen: Boolean get() = client.isConnected && client.isAuthenticated

    /** Runs [command] to completion. After [timeoutMs], or when the caller is cancelled, the channel is closed; a timed-out run reports `exit = null` with whatever output arrived. */
    override suspend fun exec(command: String, timeoutMs: Long): ExecResult = withContext(Dispatchers.IO) {
        client.startSession().use { s ->
            val cmd = s.exec(command)
            coroutineScope {
                val timedOut = java.util.concurrent.atomic.AtomicBoolean(false)
                val watchdog = launch {
                    try {
                        delay(timeoutMs)
                        timedOut.set(true)
                    } finally {
                        runCatching { s.close() }
                    }
                }
                val err = async { drain(cmd.errorStream) { timedOut.get() } }
                val out = drain(cmd.inputStream) { timedOut.get() }
                val errText = err.await()
                if (!timedOut.get()) cmd.join(timeoutMs, TimeUnit.MILLISECONDS)
                watchdog.cancel()
                ExecResult(if (timedOut.get()) null else cmd.exitStatus, out, errText)
            }
        }
    }

    private fun drain(input: java.io.InputStream, timedOut: () -> Boolean): String {
        val buf = java.io.ByteArrayOutputStream()
        try {
            input.copyTo(buf)
        } catch (e: java.io.IOException) {
            if (!timedOut()) throw e
        }
        return buf.toByteArray().decodeToString()
    }

    override fun lines(command: String): Flow<String> = callbackFlow {
        val session: Session = client.startSession()
        val cmd = try {
            session.exec(command)
        } catch (e: Exception) {
            runCatching { session.close() }
            throw e
        }
        val stream = cmd.inputStream
        val reader = thread(name = "ssh-lines", isDaemon = true) {
            try {
                stream.bufferedReader().useLines { seq -> seq.forEach { trySendBlocking(it).getOrThrow() } }
                close()
            } catch (e: Throwable) {
                close(e)
            }
        }
        awaitClose {
            runCatching { session.close() }
            runCatching { stream.close() }
            reader.interrupt()
        }
    }.flowOn(Dispatchers.IO)

    override fun close() {
        runCatching { client.disconnect() }
    }
}
