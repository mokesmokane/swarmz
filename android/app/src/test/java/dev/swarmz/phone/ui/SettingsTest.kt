package dev.swarmz.phone.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.swarmz.phone.data.HostConnector
import dev.swarmz.phone.data.MemorySettings
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.FakeConn
import dev.swarmz.phone.link.VERSION_OK
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.ui.settings.SettingsScreen
import dev.swarmz.phone.ui.theme.SwarmzTheme
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val VERSION_OLD = """{"build":1,"protocol":0,"tool":"0.0.1","v":1}"""
private const val REVOKE_FAILED = """{"code":"failed","error":"revoked here; could not reach the other Macs: x","v":1}"""

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp")
class SettingsTest {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val settings = MemorySettings().also { runBlocking { it.setPaired(Paired("mini", "me", "Fold")) } }
    private var forgot = 0

    @After fun tearDown() = scope.cancel()

    private fun vm(conn: FakeConn): AppViewModel {
        installBouncyCastle()
        val key = PhoneKey(Ed25519.generate())
        val repo = Repository(settings, { key }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), scope)
        repo.start()
        return AppViewModel(repo, settings, pairing = null, forgetKey = { forgot++ }, scope = scope)
    }

    private fun exists(text: String) = compose.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun anOutdatedMacAsksForAnUpdate() {
        val vm = vm(FakeConn { if (it == Cmd.version()) VERSION_OLD else """{"machines":[],"v":1}""" })
        compose.setContent { SwarmzTheme { SettingsScreen(vm, onBack = {}) } }
        compose.waitUntil(5_000) { exists("Update swarmz on mini") }
        compose.onNodeWithText("Update swarmz on mini").assertIsDisplayed()
    }

    @Test
    fun settingsAreStoredAndAFailedRevokeCanForgetLocally() {
        val vm = vm(
            FakeConn { cmd ->
                when (cmd) {
                    Cmd.machines() -> """{"machines":[],"v":1}"""
                    Cmd.phoneRevoke("Fold") -> REVOKE_FAILED
                    else -> VERSION_OK
                }
            },
        )
        compose.setContent { SwarmzTheme { SettingsScreen(vm, onBack = {}) } }
        compose.waitUntil(5_000) { exists("online") }

        compose.onNodeWithText("Watch in the background").performScrollTo().performClick()
        compose.waitUntil(5_000) { !settings.backgroundWatch.value }

        compose.onNodeWithText("Revoke this phone").performScrollTo().performClick()
        compose.onNodeWithText("Revoke").performClick()
        compose.waitUntil(5_000) { exists("Couldn't revoke: revoked here; could not reach the other Macs: x") }
        compose.onNodeWithText("Forget on this phone only").assertIsDisplayed().performClick()
        compose.waitUntil(5_000) { settings.paired.value == null && forgot == 1 }
        assertNull(settings.paired.value)
        assertEquals(1, forgot)
    }

    @Test
    fun aMacWithoutThePhonesKeySaysWhy() {
        installBouncyCastle()
        val key = PhoneKey(Ed25519.generate())
        val mini = FakeConn {
            if (it == Cmd.machines()) """{"machines":[{"name":"mini","self":true},{"name":"studio","alias":"Studio","self":false}],"v":1}""" else VERSION_OK
        }
        val connector = object : dev.swarmz.phone.ssh.SshConnector {
            val inner = HostConnector(mapOf("mini" to ArrayDeque(listOf(mini))))
            override suspend fun connect(host: String, port: Int, auth: dev.swarmz.phone.ssh.Auth): dev.swarmz.phone.ssh.SshConnection =
                if (host == "studio") throw dev.swarmz.phone.ssh.AuthRejected(host) else inner.connect(host, port, auth)
        }
        val repo = Repository(settings, { key }, connector, scope)
        repo.start()
        val vm = AppViewModel(repo, settings, pairing = null, scope = scope)
        compose.setContent { SwarmzTheme { SettingsScreen(vm, onBack = {}) } }
        // Each Mac takes the key itself now, so the row says what is missing and offers to pair it.
        val why = "Studio doesn't have this phone's key yet"
        compose.waitUntil(5_000) { exists(why) }
        compose.onNodeWithText(why).assertIsDisplayed()
        assertEquals(emptyList<dev.swarmz.phone.data.Banner>(), vm.home.value.banners)

        // The Mac can be paired from its own row, with its name filled in and the first pairing's user.
        compose.onAllNodesWithText("Pair this Mac")[0].performScrollTo().performClick()
        assertEquals(Route.AddMac("studio", "me"), vm.route.value)
    }

    @Test
    fun anyMacCanBePairedFromSettings() {
        val vm = vm(FakeConn { if (it == Cmd.machines()) """{"machines":[],"v":1}""" else VERSION_OK })
        compose.setContent { SwarmzTheme { SettingsScreen(vm, onBack = {}) } }
        compose.waitUntil(5_000) { exists("online") }
        // The paired Mac is marked as such and needs no button; a Mac can still be added by hand.
        compose.onNodeWithText("mini · paired").assertIsDisplayed()
        compose.onAllNodesWithText("Pair this Mac").assertCountEquals(0)
        compose.onNodeWithText("Add a Mac").performScrollTo().performClick()
        assertEquals(Route.AddMac(null, "me"), vm.route.value)
    }
}
