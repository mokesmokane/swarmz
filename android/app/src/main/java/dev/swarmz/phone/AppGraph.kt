package dev.swarmz.phone

import android.app.Application
import dev.swarmz.phone.data.DataStoreSettings
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.keys.AndroidKeystoreVault
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.keys.PhoneKeyStore
import dev.swarmz.phone.pairing.Pairing
import dev.swarmz.phone.ssh.SshjConnector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class AppGraph(app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val settings = DataStoreSettings(app, scope)
    val keyStore = PhoneKeyStore(app.filesDir, AndroidKeystoreVault())
    private val connector = SshjConnector(settings)

    @Volatile private var key: PhoneKey? = null

    @Synchronized
    fun phoneKey(): PhoneKey = key ?: keyStore.loadOrCreate().also { key = it }

    @Synchronized
    fun forgetKey() {
        keyStore.delete()
        key = null
    }

    val repository = Repository(settings, ::phoneKey, connector, scope).also { it.start() }
    val pairing = Pairing(connector, ::phoneKey, settings)
}
