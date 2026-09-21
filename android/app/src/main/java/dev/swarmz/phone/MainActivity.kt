package dev.swarmz.phone

import android.content.Intent
import android.os.Bundle
import androidx.lifecycle.lifecycleScope
import dev.swarmz.phone.ui.tile.readPicked
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.swarmz.phone.ui.AppViewModel
import dev.swarmz.phone.ui.SwarmzRoot

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels {
        viewModelFactory {
            initializer {
                val g = (application as SwarmzApp).graph
                AppViewModel(g.repository, g.settings, g.pairing, forgetKey = g::forgetKey)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { SwarmzRoot(vm) }
        if (savedInstanceState == null) takeShare(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeShare(intent)
    }

    /** A share from another app (phone attachments spec §4.4): the files are read here, off the main thread. */
    private fun takeShare(intent: Intent?) {
        val shared = sharedFrom(intent) ?: return
        lifecycleScope.launch {
            val items = withContext(Dispatchers.IO) { shared.uris.mapNotNull { readPicked(this@MainActivity, it).getOrNull() } }
            vm.share(items, shared.text)
        }
    }
}
