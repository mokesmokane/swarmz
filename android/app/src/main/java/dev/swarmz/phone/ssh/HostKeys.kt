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
    /** Every id with a pin, so one stored under an older spelling of a Mac can be found and moved. */
    fun ids(): Set<String>
}

class MemoryPins : HostKeyPins {
    private val map = ConcurrentHashMap<String, String>()
    override fun get(id: String) = map[id]
    override fun put(id: String, fingerprint: String) { map[id] = fingerprint }
    override fun ids(): Set<String> = map.keys.toSet()
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

/** An address is only ever itself; a name is also its short MagicDNS form (`studio.tail.ts.net` is `studio`). */
private fun isAddress(host: String) = host.contains(':') || host.isNotEmpty() && host.all { it.isDigit() || it == '.' }

/**
 * The id a Mac's pin is stored under. The rest of the app treats `mini` and `mini.tailnet.ts.net`
 * as one Mac (`sameMac`), so its pin is keyed the same way: on the lowercased short name, or on a
 * literal address unchanged. Keying on whatever was typed would let pairing by one spelling and
 * scanning the other pin the same Mac twice, and a real host key change would then go unreported.
 */
fun pinId(host: String, port: Int = 22): String =
    if (isAddress(host)) "$host:$port" else "${host.substringBefore('.').lowercase()}:$port"

/**
 * [pinId], having first moved any pin an older build left under another spelling of the same Mac
 * onto it. Where several spellings are pinned they merge: each was already trusted for this Mac
 * under a name the app treats as the same one, so accepting any of them is exactly what those
 * spellings accepted between them, and no more. A pin already at the normalised id is never
 * replaced -- it is the one the phone is verifying against -- and the old entries are simply left
 * where they are, unread from now on.
 */
fun pinIdFor(pins: HostKeyPins, host: String, port: Int = 22): String {
    val id = pinId(host, port)
    if (pins.get(id) != null) return id
    val suffix = ":$port"
    val merged = pins.ids()
        .filter { it != id && it.endsWith(suffix) && pinId(it.dropLast(suffix.length), port) == id }
        .flatMapTo(LinkedHashSet()) { pinnedSet(pins.get(it)) }
    if (merged.isNotEmpty()) pins.put(id, merged.joinToString(" "))
    return id
}

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
    val id = pinIdFor(pins, host, port)
    val pinned = pinnedSet(pins.get(id))
    if (pinned.isEmpty()) {
        pins.put(id, fingerprints.joinToString(" "))
    } else if (pinned.none { it in fingerprints }) {
        throw HostKeyChanged(host, pinned.joinToString(" "), fingerprints.joinToString(" "))
    }
}
