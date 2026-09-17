package dev.swarmz.phone.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
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
    private val settings = MemorySettings().also { it.paired.value = Paired("mini", "me", "Fold") }
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

        compose.onNodeWithText("English (UK)").performScrollTo().performClick()
        compose.waitUntil(5_000) { settings.dictationLanguage.value == "en-GB" }
        assertEquals("en-GB", settings.dictationLanguage.value)

        compose.onNodeWithText("Revoke this phone").performScrollTo().performClick()
        compose.onNodeWithText("Revoke").performClick()
        compose.waitUntil(5_000) { exists("Couldn't revoke: revoked here; could not reach the other Macs: x") }
        compose.onNodeWithText("Forget on this phone only").assertIsDisplayed().performClick()
        compose.waitUntil(5_000) { settings.paired.value == null && forgot == 1 }
        assertNull(settings.paired.value)
        assertEquals(1, forgot)
    }
}
