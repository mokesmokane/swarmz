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
import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.TransportException
import net.schmizz.sshj.userauth.UserAuthException
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
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
    /** Every path that does not hand the connection back closes it, including cancellation after a successful login. */
    override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection {
        val verifier = PinningVerifier(pins, "$host:$port")
        // KEEP_ALIVE (not DefaultConfig's HEARTBEAT) disconnects after 5 unanswered keep-alives.
        val client = SSHClient(DefaultConfig().apply { keepAliveProvider = KeepAliveProvider.KEEP_ALIVE })
        try {
            return withContext(Dispatchers.IO) {
                client.addHostKeyVerifier(verifier)
                client.connectTimeout = 10_000
                // sshj starts the keep-alive thread in onConnect, and only if the interval is already set.
                client.connection.keepAlive.keepAliveInterval = 30
                try {
                    client.connect(host, port)
                } catch (e: TransportException) {
                    throw verifier.mismatch ?: Unreachable(host, e)
                } catch (e: IOException) {
                    throw Unreachable(host, e)
                }
                try {
                    when (auth) {
                        is Auth.Password -> client.authPassword(auth.user, auth.password)
                        is Auth.Key -> client.authPublickey(auth.user, auth.key.provider())
                    }
                } catch (e: UserAuthException) {
                    throw AuthRejected(host)
                } catch (e: IOException) {
                    throw Unreachable(host, e)
                }
                SshjConnection(client)
            }
        } catch (t: Throwable) {
            runCatching { client.close() }
            throw t
        }
    }
}

/** sshj's channel close waits up to 30 s for the peer's CLOSE; on a dead link that must not hold anyone up. */
private fun closeInBackground(session: Session) {
    thread(name = "ssh-close", isDaemon = true) { runCatching { session.close() } }
}

private class SshjConnection(private val client: SSHClient) : SshConnection {
    override val isOpen: Boolean get() = client.isConnected && client.isAuthenticated

    /**
     * Runs [command] to completion. After [timeoutMs], or when the caller is cancelled, the channel's streams are
     * closed at once (waking the reads) and the channel is closed in the background; a timed-out run reports
     * `exit = null` with whatever output arrived.
     */
    override suspend fun exec(command: String, timeoutMs: Long): ExecResult = withContext(Dispatchers.IO) {
        val s = client.startSession()
        var finished = false
        try {
            val cmd = s.exec(command)
            val timedOut = AtomicBoolean(false)
            val result = coroutineScope {
                val watchdog = launch {
                    try {
                        delay(timeoutMs)
                        timedOut.set(true)
                    } finally {
                        // Harmless once both streams are drained; wakes them if they are not.
                        runCatching { cmd.inputStream.close() }
                        runCatching { cmd.errorStream.close() }
                    }
                }
                val err = async { drain(cmd.errorStream) { timedOut.get() } }
                val out = drain(cmd.inputStream) { timedOut.get() }
                val errText = err.await()
                if (!timedOut.get()) runCatching { cmd.join(timeoutMs, TimeUnit.MILLISECONDS) }
                watchdog.cancel()
                ExecResult(if (timedOut.get()) null else cmd.exitStatus, out, errText)
            }
            finished = !timedOut.get()
            result
        } finally {
            if (finished) runCatching { s.close() } else closeInBackground(s)
        }
    }

    private fun drain(input: java.io.InputStream, timedOut: () -> Boolean): String {
        val buf = java.io.ByteArrayOutputStream()
        try {
            input.copyTo(buf)
        } catch (e: IOException) {
            if (!timedOut()) throw e
        }
        return buf.toByteArray().decodeToString()
    }

    override fun lines(command: String): Flow<String> = callbackFlow {
        val session: Session = client.startSession()
        val cmd = try {
            session.exec(command)
        } catch (e: Throwable) {
            closeInBackground(session)
            throw e
        }
        val stream = cmd.inputStream
        val cancelled = AtomicBoolean(false)
        thread(name = "ssh-lines", isDaemon = true) {
            try {
                stream.bufferedReader().useLines { seq -> seq.forEach { trySendBlocking(it).getOrThrow() } }
                if (!cancelled.get()) {
                    // EOF alone does not mean the command finished: a channel cut without an exit status is a drop.
                    runCatching { cmd.join(2, TimeUnit.SECONDS) }
                    if (cmd.exitStatus == null && !cancelled.get()) {
                        throw IOException("the stream for $command ended without an exit status")
                    }
                }
                close()
            } catch (e: Throwable) {
                close(e)
            } finally {
                closeInBackground(session)
            }
        }
        // Closing the stream first wakes the reader at once, even on a dead link; the reader then closes the channel.
        awaitClose {
            cancelled.set(true)
            runCatching { stream.close() }
        }
    }.flowOn(Dispatchers.IO)

    override fun close() {
        runCatching { client.disconnect() }
    }
}
