package dev.swarmz.phone.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.swarmz.phone.data.LIST_MAX_DP
import dev.swarmz.phone.data.LIST_MIN_DP
import dev.swarmz.phone.ui.components.LocalMic
import dev.swarmz.phone.ui.dictation.AndroidRecognizer
import dev.swarmz.phone.ui.dictation.Dictation
import dev.swarmz.phone.ui.dictation.DictationMic
import dev.swarmz.phone.ui.dictation.DictationOverlay
import dev.swarmz.phone.ui.dictation.onMicPermissionResult
import dev.swarmz.phone.ui.home.HomeScreen
import dev.swarmz.phone.ui.home.TileListPane
import dev.swarmz.phone.ui.newsession.NewSessionScreen
import dev.swarmz.phone.ui.pairing.PairingScreen
import dev.swarmz.phone.ui.pairing.defaultDeviceName
import dev.swarmz.phone.ui.settings.SettingsScreen
import dev.swarmz.phone.ui.theme.Sw
import dev.swarmz.phone.ui.theme.SwarmzTheme
import dev.swarmz.phone.ui.tile.TileScreen
import kotlin.math.roundToInt

val UNFOLDED_MIN_WIDTH = 600.dp

/** However wide the list is stored, the open tile beside it never gets less than this. */
private val DETAIL_MIN_WIDTH = 320.dp

/** The draggable strip between the two panes. */
private val HANDLE_WIDTH = 12.dp

@Composable
fun SwarmzRoot(vm: AppViewModel) {
    LifecycleResumeEffect(vm) {
        vm.setVisible(true)
        onPauseOrDispose { vm.setVisible(false) }
    }
    // The recognizer is only created when the mic is first pressed, and destroyed with the root.
    val context = LocalContext.current
    val language by vm.settings.dictationLanguage.collectAsStateWithLifecycle()
    val currentLanguage by rememberUpdatedState(language)
    val dictation = remember { Dictation(AndroidRecognizer(context.applicationContext), { currentLanguage }) }
    DisposableEffect(dictation) { onDispose { dictation.release() } }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        onMicPermissionResult(dictation, granted)
    }
    val mic = remember(dictation) {
        DictationMic(
            dictation,
            hasPermission = { context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED },
            requestPermission = { permission.launch(Manifest.permission.RECORD_AUDIO) },
        )
    }
    SwarmzTheme {
        val paired by vm.paired.collectAsStateWithLifecycle()
        Box(Modifier.fillMaxSize().background(Sw.Background).safeDrawingPadding()) {
            if (paired == null) {
                val ui by vm.pairingUi.collectAsStateWithLifecycle()
                PairingScreen(ui, defaultDeviceName(Build.MODEL ?: "phone"), vm::pair, pins = vm.settings)
            } else {
                CompositionLocalProvider(LocalMic provides mic) {
                    Box(Modifier.fillMaxSize()) {
                        PairedContent(vm)
                        dictation.message.value?.let {
                            Text(it, color = Sw.ErrorLine, modifier = Modifier.align(Alignment.TopCenter).padding(8.dp))
                        }
                        DictationOverlay(dictation.talk.value, dictation.level.value, Modifier.align(Alignment.BottomCenter))
                    }
                }
            }
        }
    }
}

@Composable
private fun PairedContent(vm: AppViewModel) {
    val route by vm.route.collectAsStateWithLifecycle()
    val home by vm.home.collectAsStateWithLifecycle()
    val tileNotice by vm.tileNotice.collectAsStateWithLifecycle()
    BackHandler(enabled = route != Route.Home) { vm.back() }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val available = maxWidth
        val unfolded = available >= UNFOLDED_MIN_WIDTH
        if (unfolded) {
            val collapsed by vm.listCollapsed.collectAsStateWithLifecycle()
            val stored by vm.listWidth.collectAsStateWithLifecycle()
            Row(Modifier.fillMaxSize()) {
                if (!collapsed) {
                    // The drag moves this local copy every frame; only the settled value is written to settings,
                    // and a stored value coming back re-keys it.
                    var dragged by remember(stored) { mutableStateOf(stored.dp) }
                    // The handle is a row child of its own, so it comes off the list's ceiling too.
                    val ceiling = available - DETAIL_MIN_WIDTH - HANDLE_WIDTH
                    val widest = maxOf(LIST_MIN_DP.dp, minOf(LIST_MAX_DP.dp, ceiling))
                    TileListPane(
                        home,
                        selected = (route as? Route.Tile)?.key,
                        onOpen = vm::open,
                        onNew = vm::openNewSession,
                        onSettings = vm::openSettings,
                        onCollapse = { vm.setListCollapsed(true) },
                        modifier = Modifier.width(dragged.coerceAtMost(ceiling)),
                        onStop = vm::stopTile,
                        onStart = vm::startTile,
                        notice = tileNotice,
                        onDismissNotice = vm::dismissTileNotice,
                    )
                    ResizeHandle(
                        onDrag = { by -> dragged = (dragged + by).coerceIn(LIST_MIN_DP.dp, widest) },
                        onStop = { vm.setListWidth(dragged.value.roundToInt()) },
                    )
                }
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    Detail(vm, home, route, showBack = false, onShowList = if (collapsed) ({ vm.setListCollapsed(false) }) else null)
                }
            }
        } else {
            Detail(vm, home, route, showBack = true)
        }
    }
}

/** A 12 dp strip around a 1 dp line: dragging it resizes the tile list. */
@Composable
private fun ResizeHandle(onDrag: (Dp) -> Unit, onStop: () -> Unit) {
    val density = LocalDensity.current
    val state = rememberDraggableState { delta -> onDrag(with(density) { delta.toDp() }) }
    Box(
        Modifier
            .fillMaxHeight()
            .width(HANDLE_WIDTH)
            .draggable(state, Orientation.Horizontal, onDragStopped = { onStop() })
            .semantics { contentDescription = "Resize the list" },
        contentAlignment = Alignment.Center,
    ) {
        VerticalDivider(color = Sw.Border)
    }
}

/**
 * [onShowList] is set only when unfolded with the list hidden. A tile's header has its own place for it, beside the
 * status dot; every other route would need the same parameter threaded through it, so those get a thin bar instead.
 */
@Composable
private fun Detail(vm: AppViewModel, home: HomeUi, route: Route, showBack: Boolean, onShowList: (() -> Unit)? = null) {
    if (onShowList != null && route !is Route.Tile) {
        Column(Modifier.fillMaxSize()) {
            IconButton(onClick = onShowList, modifier = Modifier.padding(start = 4.dp, top = 4.dp)) {
                Icon(Icons.Default.ChevronRight, contentDescription = "Show the list", tint = Sw.Title)
            }
            Box(Modifier.weight(1f).fillMaxWidth()) { Screen(vm, home, route, showBack, null) }
        }
        return
    }
    Screen(vm, home, route, showBack, onShowList)
}

@Composable
private fun Screen(vm: AppViewModel, home: HomeUi, route: Route, showBack: Boolean, onShowList: (() -> Unit)?) {
    when (route) {
        // Folded, or unfolded with no tile open (beside the list, which then owns Settings and New session).
        Route.Home -> HomeScreen(
            home,
            onOpen = vm::open,
            onAllow = vm::allowOnce,
            onDeny = vm::deny,
            onReply = vm::reply,
            onReplyRestored = vm::replyRestored,
            onNew = vm::openNewSession,
            onSettings = vm::openSettings,
            showActions = showBack,
            onPairMac = vm::openAddMac,
            onDismissHint = vm::dismissPairHint,
            onDismissShare = vm::dismissShare,
            onStop = vm::stopTile,
            onStart = vm::startTile,
            onApproveClaim = vm::approveClaim,
            onDenyClaim = vm::denyClaim,
        )
        is Route.Tile -> {
            // While the controller is still loading there is no header, so a collapsed list has nothing to reopen it
            // for a frame or two. Deliberate: the tile arrives immediately and brings the control with it.
            val c by vm.tile.collectAsStateWithLifecycle()
            c?.let { TileScreen(it, unfolded = !showBack, onBack = if (showBack) ({ vm.back() }) else null, now = vm.now, onShowList = onShowList) }
        }
        is Route.AddMac -> {
            val ui by vm.addMacUi.collectAsStateWithLifecycle()
            val label = home.macs.firstOrNull { it.name == route.host }?.label ?: route.host
            PairingScreen(
                ui,
                defaultDevice = "",
                onPair = { host, user, password, _ -> vm.addMac(host, user, password) },
                title = if (label == null) "Add a Mac" else "Pair $label",
                initialHost = route.host ?: "",
                initialUser = route.user ?: "",
                askDevice = false,
                onCancel = { vm.back() },
                pins = vm.settings,
            )
        }
        Route.NewSession -> NewSessionScreen(vm.newSessionModel(), home.macs, onStarted = vm::open, onBack = if (showBack) ({ vm.back() }) else null)
        Route.Settings -> SettingsScreen(vm, onBack = if (showBack) ({ vm.back() }) else null)
    }
}
