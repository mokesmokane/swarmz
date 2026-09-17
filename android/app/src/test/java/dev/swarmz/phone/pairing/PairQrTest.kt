package dev.swarmz.phone.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private const val FP_ED = "SHA256:r1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD/hh6U"
private const val FP_RSA = "SHA256:7CQ/ldJqhjJfG5HDFdkweMu4jkmliY+CecbtNbpO8J0"
private val FP_ED_ENC = FP_ED.replace(":", "%3A").replace("/", "%2F")
private val FP_RSA_ENC = FP_RSA.replace(":", "%3A").replace("/", "%2F").replace("+", "%2B")

class PairQrTest {
    @Test
    fun readsTheMacTheUserAndEveryFingerprint() {
        val qr = parsePairQr("swarmz://pair?host=mini&user=me&fp=$FP_ED_ENC&fp=$FP_RSA_ENC&v=1")
        assertEquals(PairQr("mini", "me", listOf(FP_ED, FP_RSA)), qr)
    }

    @Test
    fun acceptsThePairPathAsWellAsTheHost() {
        val want = PairQr("mini", "me", emptyList())
        assertEquals(want, parsePairQr("swarmz:pair?host=mini&user=me&v=1"))
        assertEquals(want, parsePairQr("swarmz://pair/?host=mini&user=me&v=1"))
        // The scheme is not case-sensitive, and stray whitespace around the payload is trimmed.
        assertEquals(want, parsePairQr("  SWARMZ://Pair?host=mini&user=me&v=1  "))
    }

    @Test
    fun aVersionItDoesNotKnowIsIgnored() {
        assertEquals(PairQr("mini", "me", emptyList()), parsePairQr("swarmz://pair?host=mini&user=me&v=7&future=x"))
        // No version at all is fine too.
        assertEquals(PairQr("mini", "me", emptyList()), parsePairQr("swarmz://pair?host=mini&user=me"))
    }

    @Test
    fun aPlusInAFingerprintIsNotASpace() {
        // URLDecoder would turn `+` into a space and break base64; percent-decoding must not.
        val qr = parsePairQr("swarmz://pair?host=mini&user=me&fp=SHA256%3Aab%2Bcd&fp=$FP_RSA_ENC")
        assertEquals(listOf(FP_RSA), qr?.fingerprints)
        assertEquals("mini", qr?.host)
    }

    @Test
    fun aTailscaleNameWithDotsAndDashesIsAccepted() {
        assertEquals(
            PairQr("mini-3.tail1a2b.ts.net", "martin.okane", emptyList()),
            parsePairQr("swarmz://pair?host=mini-3.tail1a2b.ts.net&user=martin.okane"),
        )
    }

    @Test
    fun onlyWellFormedFingerprintsArePinned() {
        val qr = parsePairQr("swarmz://pair?host=mini&user=me&fp=MD5%3Aaa&fp=$FP_ED_ENC&fp=&fp=$FP_ED_ENC&fp=SHA256%3Ashort")
        // Unknown hash, empty, truncated: dropped. The same key twice: pinned once.
        assertEquals(listOf(FP_ED), qr?.fingerprints)
    }

    @Test
    fun anythingThatIsNotASwarmzPairingCodeIsRefused() {
        for (bad in listOf(
            "",
            "   ",
            "https://example.com/pair?host=mini&user=me",
            "swarmz://other?host=mini&user=me",
            "swarmz://pairing?host=mini&user=me",
            "swarmz://pair",
            "swarmz://pair?user=me",
            "swarmz://pair?host=mini",
            "swarmz://pair?host=&user=me",
            "swarmz://pair?host=mini&user=",
            // A name that is not a hostname: a path traversal, percent-encoded or not.
            "swarmz://pair?host=%2e%2e&user=me",
            "swarmz://pair?host=..&user=me",
            "swarmz://pair?host=%2e%2e%2f%2e%2e%2fetc&user=me",
            "swarmz://pair?host=mini..local&user=me",
            "swarmz://pair?host=-mini&user=me",
            "swarmz://pair?host=.mini&user=me",
            "swarmz://pair?host=mini%20two&user=me",
            "swarmz://pair?host=mini%00&user=me",
            // A user that could be mistaken for an ssh option, or is not a username at all.
            "swarmz://pair?host=mini&user=-oProxyCommand%3Dx",
            "swarmz://pair?host=mini&user=me%20you",
            "swarmz://pair?host=mini&user=a%40b",
            // Broken percent-encoding.
            "swarmz://pair?host=mi%ni&user=me",
            "swarmz://pair?host=mini%&user=me",
        )) {
            assertNull(bad, parsePairQr(bad))
        }
    }

    @Test
    fun aHugePayloadIsRefusedRatherThanParsed() {
        assertNull(parsePairQr("swarmz://pair?host=mini&user=me&fp=" + "A".repeat(100_000)))
        assertNull(parsePairQr("swarmz://pair?host=" + "a".repeat(300) + "&user=me"))
        assertNull(parsePairQr("A".repeat(1_000_000)))
        // Right up to the limit still parses.
        val padding = "&x=" + "a".repeat(MAX_PAIR_QR_LENGTH - "swarmz://pair?host=mini&user=me&x=".length)
        assertEquals(PairQr("mini", "me", emptyList()), parsePairQr("swarmz://pair?host=mini&user=me$padding"))
    }
}
