package dev.swarmz.phone.data

import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.SshConnection
import dev.swarmz.phone.ssh.SshConnector
import dev.swarmz.phone.ssh.Unreachable

/** Connections by host; each host hands out its queue in order. */
class HostConnector(val byHost: Map<String, ArrayDeque<SshConnection>>) : SshConnector {
    val auths = mutableListOf<Auth>()
    override suspend fun connect(host: String, port: Int, auth: Auth): SshConnection {
        auths += auth
        return byHost[host]?.removeFirstOrNull() ?: throw Unreachable(host, Exception("no more"))
    }
}
