package dev.swarmz.phone.ssh

import dev.swarmz.phone.keys.PhoneKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
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

/** How long a background close waits for the peer's CLOSE before giving up on the channel (sshj's own default). */
private const val CLOSE_WAIT_MS = 30_000L

/**
 * Closes a channel without holding anyone up and without endangering the connection. sshj's close sends CLOSE and
 * waits up to 30 s for the peer's; only after that are the [streams] marked EOF (a no-op if the peer's CLOSE already
 * did it). Marking them EOF earlier would be fatal: sshj treats data arriving on an EOF'ed stream as a protocol error
 * and kills the whole transport, and a command that keeps writing always has data in flight.
 */
private fun closeInBackground(session: Session, vararg streams: java.io.InputStream) {
    thread(name = "ssh-close", isDaemon = true) {
        runCatching { session.close() }
        // close() returns at once when another caller already asked (the wait releases the channel lock), so wait
        // for the channel's own close here; it ends early if the connection dies.
        runCatching { session.join(CLOSE_WAIT_MS, TimeUnit.MILLISECONDS) }
        streams.forEach { runCatching { it.close() } }
    }
}

/** Copies [input] into a buffer on a thread of its own, which the caller may abandon. */
private class Pump(input: java.io.InputStream, name: String) {
    private val buffer = java.io.ByteArrayOutputStream() // synchronized
    @Volatile var failure: IOException? = null
        private set
    val thread: Thread = thread(name = name, isDaemon = true) {
        try {
            val chunk = ByteArray(8192)
            while (true) {
                val n = input.read(chunk)
                if (n < 0) break
                buffer.write(chunk, 0, n)
            }
        } catch (e: IOException) {
            failure = e
        }
    }

    fun text(): String = buffer.toByteArray().decodeToString()
}

private class SshjConnection(private val client: SSHClient) : SshConnection {
    override val isOpen: Boolean get() = client.isConnected && client.isAuthenticated

    /**
     * Runs [command] to completion. The output is pumped on threads of its own, so the caller never waits on a read:
     * after [timeoutMs] the run reports `exit = null` with whatever output has arrived, and a cancelled caller returns
     * at once. Either way the channel is closed in the background. A connection that fails before the exit status
     * arrives throws.
     */
    override suspend fun exec(command: String, timeoutMs: Long): ExecResult {
        val (s, cmd) = withContext(Dispatchers.IO) {
            val s = client.startSession()
            try {
                s to s.exec(command)
            } catch (e: Throwable) {
                closeInBackground(s)
                throw e
            }
        }
        val out = Pump(cmd.inputStream, "ssh-exec-out")
        val err = Pump(cmd.errorStream, "ssh-exec-err")
        val done = CompletableDeferred<Unit>()
        thread(name = "ssh-exec-wait", isDaemon = true) {
            try {
                out.thread.join()
                err.thread.join()
                (out.failure ?: err.failure)?.let { throw it }
                cmd.join() // the exit status arrives before the peer's CLOSE; a dropped link throws here
                done.complete(Unit)
            } catch (e: Throwable) {
                done.completeExceptionally(e)
            }
        }
        try {
            val finished = withTimeoutOrNull(timeoutMs) { done.await() } != null
            return ExecResult(if (finished) cmd.exitStatus else null, out.text(), err.text())
        } finally {
            closeInBackground(s, cmd.inputStream, cmd.errorStream)
        }
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
        val closing = AtomicBoolean(false)
        thread(name = "ssh-lines", isDaemon = true) {
            try {
                // Not useLines: closing the reader would mark the stream EOF while data may still be in flight.
                val reader = stream.bufferedReader()
                while (true) {
                    val line = reader.readLine() ?: break
                    trySendBlocking(line).getOrThrow()
                }
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
                if (closing.compareAndSet(false, true)) closeInBackground(session, stream)
            }
        }
        // The collector never waits on the reader. Closing the channel ends the reader: the peer's CLOSE (or, on a
        // dead link, the close timing out) marks the stream EOF, and a closed flow makes its next send fail.
        awaitClose {
            cancelled.set(true)
            if (closing.compareAndSet(false, true)) closeInBackground(session, stream)
        }
    }.flowOn(Dispatchers.IO)

    override fun close() {
        runCatching { client.disconnect() }
    }
}
