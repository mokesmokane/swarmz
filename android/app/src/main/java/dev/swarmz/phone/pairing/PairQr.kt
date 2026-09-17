package dev.swarmz.phone.pairing

/**
 * What a Mac's pairing QR code carries (spec §7.2):
 * `swarmz://pair?host=<magicdns-name>&user=<unix-user>&fp=<SHA256:…>&…&v=1`.
 *
 * None of it is secret — ssh host keys are public — so a photograph of the code gives nobody
 * access. It saves typing the Mac's name and username, and lets the phone pin the Mac's host keys
 * before it ever connects, so the first connection is checked rather than trusted blindly. The
 * Mac's password is still needed once.
 */
data class PairQr(val host: String, val user: String, val fingerprints: List<String>)

/**
 * The longest payload [parsePairQr] will look at. A QR code holds at most a few kilobytes, and a
 * real pairing code is around 150 characters; anything longer is not one, and is refused without
 * being picked apart.
 */
const val MAX_PAIR_QR_LENGTH: Int = 2048

/** `SHA256:` and the 43 base64 characters of a 32-byte digest, as OpenSSH prints it. */
private val FINGERPRINT = Regex("^SHA256:[A-Za-z0-9+/]{43}$")

/** A hostname label: letters, digits and inner dashes. */
private val LABEL = Regex("^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$")

/**
 * The [PairQr] in [text], or null for anything that is not a swarmz pairing code: another scheme,
 * another host or path, a missing or unusable Mac name or username, broken percent-encoding, or a
 * payload too long to be a pairing code.
 *
 * The Mac name and the username are held to the same regexes [Pairing] applies before it sends a
 * password, and the name must also be a real hostname label by label — so `..`, however it is
 * encoded, is refused rather than carried forward. A fingerprint that is not `SHA256:` plus a
 * 32-byte digest is dropped, and repeats are pinned once; an unknown `v`, and any parameter this
 * version does not know, are ignored. Where `host` or `user` is given twice, the first wins.
 */
fun parsePairQr(text: String): PairQr? {
    if (text.length > MAX_PAIR_QR_LENGTH) return null
    val trimmed = text.trim()
    // `swarmz://pair`, `swarmz:pair` and `swarmz://pair/`, with the scheme and host case-folded
    // the way URIs are, and nothing else.
    val rest = listOf("swarmz://pair", "swarmz:pair")
        .firstNotNullOfOrNull { prefix -> trimmed.takeIf { it.length >= prefix.length && it.substring(0, prefix.length).lowercase() == prefix }?.drop(prefix.length) }
        ?.removePrefix("/")
        ?: return null
    if (!rest.startsWith("?")) return null
    // A fragment is not part of the query.
    val query = rest.drop(1).substringBefore('#')

    var host: String? = null
    var user: String? = null
    val fingerprints = LinkedHashSet<String>()
    for (pair in query.split('&')) {
        if (pair.isEmpty()) continue
        val key = pair.substringBefore('=')
        val value = percentDecode(pair.substringAfter('=', "")) ?: return null
        when (key.lowercase()) {
            "host" -> if (host == null) host = value
            "user" -> if (user == null) user = value
            "fp" -> if (FINGERPRINT.matches(value)) fingerprints.add(value)
            else -> {} // Including `v`: a version this build does not know changes nothing.
        }
    }
    val mac = host?.takeIf { validPairHost(it) } ?: return null
    val login = user?.takeIf { USER.matches(it) } ?: return null
    return PairQr(mac, login, fingerprints.toList())
}

/** [HOST], and a real hostname besides: non-empty labels of letters, digits and inner dashes. */
private fun validPairHost(host: String): Boolean =
    HOST.matches(host) && host.split('.').all { LABEL.matches(it) }

/**
 * Percent-decoding, as UTF-8, or null when an escape is malformed. Deliberately not
 * `URLDecoder.decode`, which reads `+` as a space: base64 fingerprints contain `+`.
 */
private fun percentDecode(s: String): String? {
    if ('%' !in s) return s
    val out = ByteArray(s.length)
    var n = 0
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c != '%') {
            if (c.code > 0x7F) return null // Raw non-ASCII: not something a pairing code contains.
            out[n++] = c.code.toByte()
            i++
            continue
        }
        if (i + 2 >= s.length) return null
        val hi = Character.digit(s[i + 1], 16)
        val lo = Character.digit(s[i + 2], 16)
        if (hi < 0 || lo < 0) return null
        out[n++] = ((hi shl 4) or lo).toByte()
        i += 3
    }
    return String(out, 0, n, Charsets.UTF_8)
}
