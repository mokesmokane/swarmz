package dev.swarmz.phone

import android.app.Application
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security

class SwarmzApp : Application() {
    override fun onCreate() {
        super.onCreate()
        installBouncyCastle()
    }
}

/** Android ships a cut-down "BC" provider; sshj needs the full one (Ed25519, X25519). */
fun installBouncyCastle() {
    Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
    Security.insertProviderAt(BouncyCastleProvider(), 1)
}
