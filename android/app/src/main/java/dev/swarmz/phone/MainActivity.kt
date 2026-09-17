package dev.swarmz.phone

import android.os.Bundle
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
    }
}
