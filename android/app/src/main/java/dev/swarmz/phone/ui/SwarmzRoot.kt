package dev.swarmz.phone.ui

import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.swarmz.phone.ui.home.HomeScreen
import dev.swarmz.phone.ui.home.TileListPane
import dev.swarmz.phone.ui.pairing.PairingScreen
import dev.swarmz.phone.ui.pairing.defaultDeviceName
import dev.swarmz.phone.ui.theme.Sw
import dev.swarmz.phone.ui.theme.SwarmzTheme
import dev.swarmz.phone.ui.tile.TileScreen

val UNFOLDED_MIN_WIDTH = 600.dp

@Composable
fun SwarmzRoot(vm: AppViewModel) {
    LifecycleResumeEffect(vm) {
        vm.setVisible(true)
        onPauseOrDispose { vm.setVisible(false) }
    }
    SwarmzTheme {
        val paired by vm.paired.collectAsStateWithLifecycle()
        Box(Modifier.fillMaxSize().background(Sw.Background).safeDrawingPadding()) {
            if (paired == null) {
                val ui by vm.pairingUi.collectAsStateWithLifecycle()
                PairingScreen(ui, defaultDeviceName(Build.MODEL ?: "phone"), vm::pair)
            } else {
                PairedContent(vm)
            }
        }
    }
}

@Composable
private fun PairedContent(vm: AppViewModel) {
    val route by vm.route.collectAsStateWithLifecycle()
    val home by vm.home.collectAsStateWithLifecycle()
    BackHandler(enabled = route != Route.Home) { vm.back() }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val unfolded = maxWidth >= UNFOLDED_MIN_WIDTH
        if (unfolded) {
            Row(Modifier.fillMaxSize()) {
                TileListPane(
                    home,
                    selected = (route as? Route.Tile)?.key,
                    onOpen = vm::open,
                    onNew = vm::openNewSession,
                    onSettings = vm::openSettings,
                    modifier = Modifier.width(312.dp),
                )
                VerticalDivider(color = Sw.Border)
                Box(Modifier.weight(1f).fillMaxHeight()) { Detail(vm, home, route, showBack = false) }
            }
        } else {
            Detail(vm, home, route, showBack = true)
        }
    }
}

@Composable
private fun Detail(vm: AppViewModel, home: HomeUi, route: Route, showBack: Boolean) {
    when (route) {
        // Folded, or unfolded with no tile open (beside the list), so its cards work in both.
        Route.Home -> HomeScreen(
            home,
            onOpen = vm::open,
            onAllow = vm::allowOnce,
            onDeny = vm::deny,
            onReply = vm::reply,
            onNew = vm::openNewSession,
            onSettings = vm::openSettings,
        )
        is Route.Tile -> {
            val c by vm.tile.collectAsStateWithLifecycle()
            c?.let { TileScreen(it, unfolded = !showBack, onBack = if (showBack) ({ vm.back() }) else null, now = vm.now) }
        }
        Route.NewSession -> Text("New session", modifier = Modifier.padding(16.dp))
        Route.Settings -> Text("Settings", modifier = Modifier.padding(16.dp))
    }
}
