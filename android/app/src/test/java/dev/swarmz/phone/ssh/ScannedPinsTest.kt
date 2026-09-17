package dev.swarmz.phone.ssh

import dev.swarmz.phone.installBouncyCastle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.security.KeyFactory
import java.security.PublicKey
import java.security.spec.X509EncodedKeySpec

/** An Ed25519 public key built from 32 fixed bytes, so its fingerprint is the same every run. */
private fun keyOf(seed: Byte): PublicKey {
    val raw = ByteArray(32) { (it + seed).toByte() }
    val x509 = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00) + raw
    return KeyFactory.getInstance("Ed25519", "BC").generatePublic(X509EncodedKeySpec(x509))
}

class ScannedPinsTest {
    @Before fun up() = installBouncyCastle()

    @Test
    fun aScannedMacIsVerifiedOnItsFirstConnection() {
        val theirs = keyOf(0)
        val other = keyOf(9)
        val pins = MemoryPins()
        // The QR pins every key type the Mac offers, under the id the connector uses.
        pinScannedKeys(pins, "mini", listOf(fingerprint(other), fingerprint(theirs)))
        assertEquals("${fingerprint(other)} ${fingerprint(theirs)}", pins.get("mini:22"))

        // The first connection is now checked, not trusted blindly: either pinned key is accepted...
        assertTrue(PinningVerifier(pins, "mini:22").verify("mini", 22, theirs))
        assertTrue(PinningVerifier(pins, "mini:22").verify("mini", 22, other))
        // ...and anything else is a host key change, with the pins left alone.
        val verifier = PinningVerifier(pins, "mini:22")
        assertFalse(verifier.verify("mini", 22, keyOf(4)))
        assertEquals(fingerprint(keyOf(4)), verifier.mismatch?.offered)
        assertEquals("${fingerprint(other)} ${fingerprint(theirs)}", pins.get("mini:22"))
    }

    @Test
    fun trustOnFirstUseStillWorksForAMacThatWasNeverScanned() {
        val pins = MemoryPins()
        val theirs = keyOf(0)
        assertNull(pins.get("mini:22"))
        assertTrue(PinningVerifier(pins, "mini:22").verify("mini", 22, theirs))
        assertEquals(fingerprint(theirs), pins.get("mini:22"))
        // And the key it settled on is still insisted on afterwards.
        assertFalse(PinningVerifier(pins, "mini:22").verify("mini", 22, keyOf(4)))
    }

    @Test
    fun scanningAMacThatIsAlreadyPinnedElsewhereIsAHostKeyChange() {
        val pins = MemoryPins()
        pins.put("mini:22", fingerprint(keyOf(0)))
        try {
            pinScannedKeys(pins, "mini", listOf(fingerprint(keyOf(4)), fingerprint(keyOf(9))))
            fail("expected HostKeyChanged")
        } catch (e: HostKeyChanged) {
            assertEquals("mini", e.host)
            assertEquals(fingerprint(keyOf(0)), e.pinned)
        }
        // The pin the phone already trusts is never quietly replaced by the scanned one.
        assertEquals(fingerprint(keyOf(0)), pins.get("mini:22"))
    }

    @Test
    fun rescanningAMacThatIsAlreadyPinnedChangesNothing() {
        val pins = MemoryPins()
        val theirs = keyOf(0)
        pins.put("mini:22", fingerprint(theirs))
        // The scan proves nothing the phone does not already know, so the pin is not widened to
        // the other keys in the code: a code shown by someone else cannot add a key to it.
        pinScannedKeys(pins, "mini", listOf(fingerprint(theirs), fingerprint(keyOf(4))))
        assertEquals(fingerprint(theirs), pins.get("mini:22"))
        assertFalse(PinningVerifier(pins, "mini:22").verify("mini", 22, keyOf(4)))
    }

    @Test
    fun aCodeWithNoFingerprintsPinsNothing() {
        val pins = MemoryPins()
        pinScannedKeys(pins, "mini", emptyList())
        assertNull(pins.get("mini:22"))
    }

    @Test
    fun oneMacHasOnePinWhateverSpellingItIsReachedBy() {
        // The app treats `mini` and `mini.tailnet.ts.net` as one Mac, so its pin is keyed on the
        // short name: pairing by one spelling and scanning the other must not pin twice.
        assertEquals(pinId("mini"), pinId("Mini.tailnet.ts.net"))
        assertEquals("mini:22", pinId("MINI"))
        assertEquals("mini:2222", pinId("mini.tailnet.ts.net", 2222))
        // A literal address is only ever itself.
        assertEquals("100.64.1.2:22", pinId("100.64.1.2"))
        assertNotEquals(pinId("100.64.1.2"), pinId("100.64.1.3"))
        assertEquals("fd7a:115c::1:22", pinId("fd7a:115c::1"))

        val pins = MemoryPins()
        pinScannedKeys(pins, "mini", listOf(fingerprint(keyOf(0))))
        val long = pinIdFor(pins, "mini.tailnet.ts.net", 22)
        assertTrue(PinningVerifier(pins, long).verify("mini.tailnet.ts.net", 22, keyOf(0)))
        assertFalse(PinningVerifier(pins, long).verify("mini.tailnet.ts.net", 22, keyOf(4)))
    }

    @Test
    fun aPinWrittenUnderAnotherSpellingMovesToTheNormalisedId() {
        val pins = MemoryPins()
        pins.put("mini.tailnet.ts.net:22", fingerprint(keyOf(0)))
        assertEquals("mini:22", pinIdFor(pins, "mini", 22))
        assertEquals(fingerprint(keyOf(0)), pins.get("mini:22"))
        assertTrue(PinningVerifier(pins, "mini:22").verify("mini", 22, keyOf(0)))
        // A pin for another port, or another Mac, is left where it is.
        assertNull(pins.get("mini:2222"))
    }

    @Test
    fun aScanAfterPairingByTheLongNameIsStillAHostKeyChange() {
        val pins = MemoryPins()
        pins.put("mini.tailnet.ts.net:22", fingerprint(keyOf(0)))
        try {
            pinScannedKeys(pins, "mini", listOf(fingerprint(keyOf(4))))
            fail("expected HostKeyChanged")
        } catch (e: HostKeyChanged) {
            assertEquals(fingerprint(keyOf(0)), e.pinned)
        }
        assertEquals(fingerprint(keyOf(0)), pins.get("mini:22"))
    }

    @Test
    fun pinsLeftUnderSeveralSpellingsMergeRatherThanOneWinning() {
        val pins = MemoryPins()
        pins.put("mini.tailnet.ts.net:22", fingerprint(keyOf(0)))
        pins.put("MINI.other.ts.net:22", fingerprint(keyOf(4)))
        pins.put("mini:2222", fingerprint(keyOf(9)))
        pinIdFor(pins, "mini", 22)
        // Each was already trusted for this Mac under a name the app treats as the same one, so
        // merging them is what those spellings already accepted between them -- and no more.
        assertEquals(setOf(fingerprint(keyOf(0)), fingerprint(keyOf(4))), pinnedSet(pins.get("mini:22")))
        assertEquals(fingerprint(keyOf(9)), pins.get("mini:2222"))
    }

    @Test
    fun aNormalisedPinIsNeverReplacedByAnOlderSpellings() {
        val pins = MemoryPins()
        pins.put("mini:22", fingerprint(keyOf(0)))
        pins.put("mini.tailnet.ts.net:22", fingerprint(keyOf(4)))
        pinIdFor(pins, "mini.tailnet.ts.net", 22)
        assertEquals(fingerprint(keyOf(0)), pins.get("mini:22"))
    }
}
