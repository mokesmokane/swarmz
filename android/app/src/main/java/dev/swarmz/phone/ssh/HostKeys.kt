package dev.swarmz.phone.ssh

import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import java.security.MessageDigest
import java.security.PublicKey
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

interface HostKeyPins {
    fun get(id: String): String?
    fun put(id: String, fingerprint: String)
}

class MemoryPins : HostKeyPins {
    private val map = ConcurrentHashMap<String, String>()
    override fun get(id: String) = map[id]
    override fun put(id: String, fingerprint: String) { map[id] = fingerprint }
}

fun fingerprint(key: PublicKey): String {
    val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
    val digest = MessageDigest.getInstance("SHA-256").digest(blob)
    return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
}

class HostKeyChanged(val host: String, val pinned: String, val offered: String) :
    Exception("$host presented a different host key ($offered, expected $pinned)")

/** Trust on first use, then insist on the same key. */
internal class PinningVerifier(private val pins: HostKeyPins, private val id: String) : HostKeyVerifier {
    @Volatile var mismatch: HostKeyChanged? = null

    override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        val offered = fingerprint(key)
        val pinned = pins.get(id)
        return when (pinned) {
            null -> { pins.put(id, offered); true }
            offered -> true
            else -> { mismatch = HostKeyChanged(hostname, pinned, offered); false }
        }
    }

    override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
}
