package dev.swarmz.phone

import android.app.Application
import android.util.Log
import dev.swarmz.phone.data.DataStoreSettings
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.keys.AndroidKeystoreVault
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.keys.PhoneKeyStore
import dev.swarmz.phone.pairing.Pairing
import dev.swarmz.phone.ssh.SshjConnector
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

const val LOG_TAG = "swarmz"

/**
 * Logs a background task's uncaught failure instead of crashing the app. Only the exception is logged: the pairing
 * password never reaches an exception, and nothing else is added to the message.
 */
fun uncaughtLogger(): CoroutineExceptionHandler = CoroutineExceptionHandler { _, e ->
    Log.e(LOG_TAG, "Uncaught ${e.javaClass.name} in a background task", e)
}

class AppGraph(app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + uncaughtLogger())
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
