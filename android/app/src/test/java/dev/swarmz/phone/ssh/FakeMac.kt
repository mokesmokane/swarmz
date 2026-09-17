package dev.swarmz.phone.ssh

import org.apache.sshd.common.config.keys.PublicKeyEntry
import org.apache.sshd.server.Environment
import org.apache.sshd.server.ExitCallback
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.auth.password.PasswordAuthenticator
import org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator
import org.apache.sshd.server.channel.ChannelSession
import org.apache.sshd.server.command.Command
import org.apache.sshd.server.command.CommandFactory
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/** What a command does: write to [out], return the exit code. Runs on its own thread; [stopped] turns true when the client goes away. */
typealias Handler = (command: String, out: OutputStream, stopped: () -> Boolean) -> Int

class FakeMac(hostKeyFile: Path, var handler: Handler) : AutoCloseable {
    val allowedKeys = CopyOnWriteArrayList<String>()
    val commands = CopyOnWriteArrayList<String>()
    val destroyed = CopyOnWriteArrayList<String>()

    private val server: SshServer = SshServer.setUpDefaultServer().apply {
        port = 0
        keyPairProvider = SimpleGeneratorHostKeyProvider(hostKeyFile)
        passwordAuthenticator = PasswordAuthenticator { user, password, _ -> user == "me" && password == "pw" }
        publickeyAuthenticator = PublickeyAuthenticator { user, key, _ ->
            val line = PublicKeyEntry.toString(key)
            user == "me" && allowedKeys.any { it.trim().split(" ").take(2).joinToString(" ") == line }
        }
        commandFactory = CommandFactory { _, command -> FakeCommand(command) }
        start()
    }

    val port: Int get() = server.port

    override fun close() = server.stop(true)

    private inner class FakeCommand(private val command: String) : Command {
        private lateinit var out: OutputStream
        private lateinit var exit: ExitCallback
        @Volatile private var stop = false

        override fun setInputStream(`in`: InputStream) {}
        override fun setOutputStream(out: OutputStream) { this.out = out }
        override fun setErrorStream(err: OutputStream) {}
        override fun setExitCallback(callback: ExitCallback) { exit = callback }

        override fun start(channel: ChannelSession, env: Environment) {
            commands += command
            thread {
                val code = try {
                    handler(command, out, { stop })
                } catch (_: Exception) {
                    255
                }
                runCatching { out.flush() }
                exit.onExit(code)
            }
        }

        override fun destroy(channel: ChannelSession) {
            stop = true
            destroyed += command
        }
    }
}
