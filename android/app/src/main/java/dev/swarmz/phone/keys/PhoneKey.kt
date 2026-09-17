package dev.swarmz.phone.keys

import net.schmizz.sshj.userauth.keyprovider.KeyPairWrapper
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

object Ed25519 {
    fun generate(): KeyPair = KeyPairGenerator.getInstance("Ed25519", "BC").generateKeyPair()

    fun raw(public: PublicKey): ByteArray = SubjectPublicKeyInfo.getInstance(public.encoded).publicKeyData.bytes

    fun openSsh(public: PublicKey): String {
        val out = ByteArrayOutputStream()
        DataOutputStream(out).use { d ->
            val type = "ssh-ed25519".toByteArray()
            d.writeInt(type.size)
            d.write(type)
            val key = raw(public)
            d.writeInt(key.size)
            d.write(key)
        }
        return "ssh-ed25519 " + Base64.getEncoder().encodeToString(out.toByteArray())
    }

    fun fromEncoded(pkcs8: ByteArray, x509: ByteArray): KeyPair {
        val kf = KeyFactory.getInstance("Ed25519", "BC")
        return KeyPair(kf.generatePublic(X509EncodedKeySpec(x509)), kf.generatePrivate(PKCS8EncodedKeySpec(pkcs8)))
    }
}

class PhoneKey(val keyPair: KeyPair) {
    val openSsh: String = Ed25519.openSsh(keyPair.public)

    fun provider(): KeyProvider = KeyPairWrapper(keyPair)

    fun sign(data: ByteArray): ByteArray = Signature.getInstance("Ed25519", "BC").run {
        initSign(keyPair.private)
        update(data)
        sign()
    }
}

class PhoneKeyStore(private val dir: File, private val vault: KeyVault) {
    private val sealedFile get() = File(dir, "phone_key.sealed")
    private val publicFile get() = File(dir, "phone_key.pub")

    fun exists(): Boolean = sealedFile.exists() && publicFile.exists()

    @Synchronized
    fun loadOrCreate(): PhoneKey {
        if (exists()) {
            val pkcs8 = vault.open(sealedFile.readBytes())
            return PhoneKey(Ed25519.fromEncoded(pkcs8, publicFile.readBytes())).also { pkcs8.fill(0) }
        }
        val kp = Ed25519.generate()
        dir.mkdirs()
        val pkcs8 = kp.private.encoded
        writeAtomically(sealedFile, vault.seal(pkcs8))
        pkcs8.fill(0)
        writeAtomically(publicFile, kp.public.encoded)
        return PhoneKey(kp)
    }

    fun delete() {
        vault.erase()
        sealedFile.delete()
        publicFile.delete()
        File(dir, sealedFile.name + ".tmp").delete()
        File(dir, publicFile.name + ".tmp").delete()
    }

    private fun writeAtomically(f: File, bytes: ByteArray) {
        val tmp = File(dir, f.name + ".tmp")
        tmp.writeBytes(bytes)
        check(tmp.renameTo(f)) { "could not save ${f.name}" }
    }
}
