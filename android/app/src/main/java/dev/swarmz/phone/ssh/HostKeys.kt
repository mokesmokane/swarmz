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

/**
 * A stored pin is one fingerprint, or several separated by spaces: a Mac offers a key per type,
 * and a pairing QR code pins them all at once, since we cannot tell in advance which one sshj will
 * negotiate. A pin written by trust on first use is a set of one, and reads back the same way.
 */
internal fun pinnedSet(value: String?): Set<String> =
    value?.split(' ')?.filterTo(LinkedHashSet()) { it.isNotEmpty() } ?: emptySet()

/** Trust on first use, then insist on one of the keys pinned for that Mac. */
internal class PinningVerifier(private val pins: HostKeyPins, private val id: String) : HostKeyVerifier {
    @Volatile var mismatch: HostKeyChanged? = null

    override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        val offered = fingerprint(key)
        val pinned = pinnedSet(pins.get(id))
        return when {
            pinned.isEmpty() -> { pins.put(id, offered); true }
            offered in pinned -> true
            else -> { mismatch = HostKeyChanged(hostname, pinned.joinToString(" "), offered); false }
        }
    }

    override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
}

/**
 * Pins the host keys a pairing QR code carries for [host], so the phone's first connection to it is
 * verified rather than trusted blindly. [fingerprints] is every key the Mac offers, since which one
 * gets negotiated is not known in advance.
 *
 * A Mac the phone already has a pin for is never quietly re-pinned:
 * - when one of [fingerprints] is already pinned, the scan says nothing new and the pin is left
 *   exactly as it is. The code is not authenticated, so widening an existing pin to the other keys
 *   in it would let a code shown by someone else add a key of their own;
 * - when none is, the Mac is presenting different keys than the phone trusts, which is reported as
 *   a [HostKeyChanged] rather than overwritten.
 *
 * @throws HostKeyChanged when [host] is pinned to keys none of [fingerprints] match.
 */
fun pinScannedKeys(pins: HostKeyPins, host: String, fingerprints: List<String>, port: Int = 22) {
    if (fingerprints.isEmpty()) return
    val id = "$host:$port"
    val pinned = pinnedSet(pins.get(id))
    if (pinned.isEmpty()) {
        pins.put(id, fingerprints.joinToString(" "))
    } else if (pinned.none { it in fingerprints }) {
        throw HostKeyChanged(host, pinned.joinToString(" "), fingerprints.joinToString(" "))
    }
}
