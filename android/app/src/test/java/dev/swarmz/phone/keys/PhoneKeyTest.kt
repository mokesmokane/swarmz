package dev.swarmz.phone.keys

import dev.swarmz.phone.installBouncyCastle
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.ByteBuffer
import java.security.Signature
import java.util.Base64

/** A stand-in for the Keystore: reversible, and visibly not the plain bytes. */
class XorVault : KeyVault {
    var erased = false
        private set

    override fun seal(plain: ByteArray) = byteArrayOf(0x5A) + plain.map { (it.toInt() xor 0x5A).toByte() }
    override fun open(sealed: ByteArray) = sealed.drop(1).map { (it.toInt() xor 0x5A).toByte() }.toByteArray()
    override fun erase() {
        erased = true
    }
}

class PhoneKeyTest {
    @get:Rule val tmp = TemporaryFolder()

    @Before fun bc() = installBouncyCastle()

    @Test
    fun openSshFormat() {
        val kp = Ed25519.generate()
        val line = Ed25519.openSsh(kp.public)
        assertTrue(line.startsWith("ssh-ed25519 "))
        val blob = Base64.getDecoder().decode(line.removePrefix("ssh-ed25519 "))
        val buf = ByteBuffer.wrap(blob)
        val type = ByteArray(buf.int).also { buf.get(it) }
        assertEquals("ssh-ed25519", String(type))
        val key = ByteArray(buf.int).also { buf.get(it) }
        assertEquals(32, key.size)
        assertArrayEquals(Ed25519.raw(kp.public), key)
        assertFalse(buf.hasRemaining())
    }

    @Test
    fun storeCreatesOnceAndReloads() {
        val vault = XorVault()
        val store = PhoneKeyStore(tmp.root, vault)
        assertFalse(store.exists())
        val first = store.loadOrCreate()
        assertTrue(store.exists())
        val again = PhoneKeyStore(tmp.root, XorVault()).loadOrCreate()
        assertEquals(first.openSsh, again.openSsh)
        // The sealed file never holds the plain PKCS#8 bytes.
        val sealed = tmp.root.resolve("phone_key.sealed").readBytes()
        val plain = first.keyPair.private.encoded
        assertFalse(sealed.asList().windowed(plain.size).any { it == plain.asList() })
        // The reloaded key signs, and the public key verifies.
        val data = "hello".toByteArray()
        val sig = again.sign(data)
        val v = Signature.getInstance("Ed25519", "BC")
        v.initVerify(first.keyPair.public)
        v.update(data)
        assertTrue(v.verify(sig))
        assertFalse(vault.erased)
        store.delete()
        assertTrue(vault.erased)
        assertFalse(store.exists())
    }
}
