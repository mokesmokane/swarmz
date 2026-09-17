package dev.swarmz.phone.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.swarmz.phone.data.MemorySettings
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.data.HostConnector
import dev.swarmz.phone.installBouncyCastle
import dev.swarmz.phone.keys.Ed25519
import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.FakeConn
import dev.swarmz.phone.link.VERSION_OK
import dev.swarmz.phone.proto.Cmd
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val SNAPSHOT = """{"tiles":[{"cwd":"/p/docs","id":"t3","kind":"claude","name":"docs","running":true,"status":"working"}],"type":"snapshot","v":1}"""

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RootTest {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @After fun tearDown() = scope.cancel()

    private fun vm(paired: Boolean): AppViewModel {
        installBouncyCastle()
        val key = PhoneKey(Ed25519.generate())
        val conn = FakeConn { if (it == Cmd.machines()) """{"machines":[],"v":1}""" else VERSION_OK }
        runBlocking { conn.stream(Cmd.watch()).send(SNAPSHOT) }
        val settings = MemorySettings().also { if (paired) it.paired.value = Paired("mini", "me", "Fold") }
        val repo = Repository(settings, { key }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), scope)
        repo.start()
        return AppViewModel(repo, settings, pairing = null, scope = scope)
    }

    @Test
    fun unpairedPhonesSeeThePairingScreen() {
        val vm = vm(paired = false)
        compose.setContent { SwarmzRoot(vm) }
        compose.onNodeWithText("Pair with a Mac").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "w360dp-h780dp")
    fun foldedShowsOneScreenAtATime() {
        val vm = vm(paired = true)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("docs") > 0 }
        assertTrue("a resumed activity counts as visible", vm.visible.value)
        compose.onNodeWithText("Nothing needs you").assertIsDisplayed()
        compose.onNodeWithText("docs").performClick()
        compose.onNodeWithText("Nothing needs you").assertDoesNotExist()
        compose.onNodeWithText("Message docs…").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "w700dp-h800dp")
    fun unfoldedKeepsTheListBesideTheTile() {
        val vm = vm(paired = true)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("docs") > 0 }
        compose.onNodeWithText("Tiles").assertIsDisplayed()
        // With no tile open, home sits beside the list, without repeating the list's actions.
        compose.onNodeWithText("Nothing needs you").assertIsDisplayed()
        compose.onAllNodes(hasText("New session") or hasContentDescription("New session")).assertCountEquals(1)
        compose.onAllNodes(hasContentDescription("Settings")).assertCountEquals(1)
        compose.onNodeWithTag("tile-row-mini/t3").performClick()
        compose.onNodeWithText("Tiles").assertIsDisplayed()
        compose.onNodeWithText("Nothing needs you").assertDoesNotExist()
        compose.onNodeWithText("Message docs…").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "w360dp-h780dp")
    fun foldedAddModeFillsTheScreenAndComesBack() {
        val vm = vm(paired = true)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("docs") > 0 }
        vm.openSettings()
        vm.openAddMac("studio")
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("Pair studio") > 0 }
        // Full screen: the tile list and Home are gone, and the Mac is filled in.
        compose.onNodeWithText("Nothing needs you").assertDoesNotExist()
        compose.onNodeWithText("Tiles").assertDoesNotExist()
        compose.onNodeWithText("studio").assertIsDisplayed()
        // Back returns to where the flow started.
        compose.onNodeWithContentDescription("Cancel").performClick()
        compose.waitUntil(5_000) { vm.route.value == Route.Settings }
    }

    @Test
    @Config(qualifiers = "w700dp-h800dp")
    fun unfoldedAddModeSitsBesideTheList() {
        val vm = vm(paired = true)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("docs") > 0 }
        vm.openAddMac(null)
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("Add a Mac") > 0 }
        compose.onNodeWithText("Tiles").assertIsDisplayed()
        compose.onNodeWithText("Add a Mac").assertIsDisplayed()
        // Started from Home, so cancelling goes back there.
        compose.onNodeWithContentDescription("Cancel").performClick()
        compose.waitUntil(5_000) { vm.route.value == Route.Home }
    }
}

private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTextCount(text: String) =
    onAllNodes(androidx.compose.ui.test.hasText(text)).fetchSemanticsNodes().size
