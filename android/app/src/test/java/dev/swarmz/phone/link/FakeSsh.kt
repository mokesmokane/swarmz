package dev.swarmz.phone.link

import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.ExecResult
import dev.swarmz.phone.ssh.SshConnection
import dev.swarmz.phone.ssh.SshConnector
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow

const val VERSION_OK = """{"build":1,"protocol":1,"tool":"0.1.0","v":1}"""

class FakeConn(
    private val replies: (String) -> String = { VERSION_OK },
) : SshConnection {
    var closed = false
    val streams = mutableMapOf<String, Channel<String>>()
    val ran = mutableListOf<String>()

    fun stream(command: String): Channel<String> = streams.getOrPut(command) { Channel(Channel.UNLIMITED) }

    override val isOpen get() = !closed
    override suspend fun exec(command: String, timeoutMs: Long): ExecResult {
        ran += command
        return ExecResult(0, replies(command), "")
    }
    override fun lines(command: String): Flow<String> {
        ran += command
        return stream(command).receiveAsFlow()
    }
    override fun close() { closed = true }
}

/** Each connect takes the next step: a connection, or an exception to throw. */
class FakeConnector(vararg steps: Any) : SshConnector {
    val queue = ArrayDeque(steps.toList())
    var connects = 0

    override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection {
        connects++
        return when (val step = queue.removeFirst()) {
            is SshConnection -> step
            is Exception -> throw step
            else -> error("bad step")
        }
    }
}
