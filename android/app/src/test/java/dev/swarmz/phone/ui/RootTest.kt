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
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.geometry.Offset
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
import org.junit.Assert.assertEquals
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

    private lateinit var conn: FakeConn

    private fun vm(paired: Boolean, snapshot: String = SNAPSHOT): AppViewModel {
        installBouncyCastle()
        val key = PhoneKey(Ed25519.generate())
        conn = FakeConn {
            when (it) {
                Cmd.machines() -> """{"machines":[],"v":1}"""
                Cmd.close("t3") -> """{"closed":true,"v":1}"""
                Cmd.restart("t4") -> """{"tile":{"cwd":"/p/web","id":"t4","kind":"claude","name":"web","running":true,"status":"idle"},"v":1}"""
                else -> VERSION_OK
            }
        }
        runBlocking { conn.stream(Cmd.watch()).send(snapshot) }
        val settings = MemorySettings().also { if (paired) runBlocking { it.setPaired(Paired("mini", "me", "Fold")) } }
        val repo = Repository(settings, { key }, HostConnector(mapOf("mini" to ArrayDeque(listOf(conn)))), scope)
        repo.start()
        return AppViewModel(repo, settings, pairing = null, scope = scope)
    }

    @Test
    @Config(qualifiers = "w700dp-h800dp")
    fun aLongPressOnARowOffersStopOrStart() {
        val two = """{"tiles":[{"cwd":"/p/docs","id":"t3","kind":"claude","name":"docs","running":true,"status":"working"},""" +
            """{"cwd":"/p/web","id":"t4","kind":"claude","name":"web","running":false,"status":"offline","exitCode":0}],"type":"snapshot","v":1}"""
        val vm = vm(paired = true, snapshot = two)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("tile-row-mini/t4")).fetchSemanticsNodes().isNotEmpty() }
        // A running tile: Stop, behind a confirm, ends its session.
        compose.onNodeWithTag("tile-row-mini/t3").performTouchInput { longClick() }
        compose.onNodeWithText("Stop").performClick()
        compose.onNodeWithText("Stop docs?").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(conn.ran.none { it == Cmd.close("t3") })
        compose.onNodeWithTag("tile-row-mini/t3").performTouchInput { longClick() }
        compose.onNodeWithText("Stop").performClick()
        compose.onAllNodesWithText("Stop").onLast().performClick()
        compose.waitUntil(5_000) { Cmd.close("t3") in conn.ran }
        // A stopped tile: Start, at once.
        compose.onNodeWithTag("tile-row-mini/t4").performTouchInput { longClick() }
        compose.onNodeWithText("Start").performClick()
        compose.waitUntil(5_000) { Cmd.restart("t4") in conn.ran }
        // Open is still a tap.
        compose.onNodeWithTag("tile-row-mini/t3").performClick()
        compose.onNodeWithText("Message docs…").assertIsDisplayed()
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

    @Test
    @Config(qualifiers = "w700dp-h800dp")
    fun unfoldedHidesAndShowsTheList() {
        val vm = vm(paired = true)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("docs") > 0 }
        compose.onNodeWithText("Tiles").assertIsDisplayed()
        compose.onNodeWithContentDescription("Hide the list").performClick()
        compose.waitUntil(5_000) { vm.listCollapsed.value }
        compose.onNodeWithText("Tiles").assertDoesNotExist()
        // Beside Home, the control sits in the detail pane.
        compose.onNodeWithContentDescription("Show the list").assertIsDisplayed()
        // The state is in settings, so a route change (and the recomposition with it) keeps the list hidden.
        vm.open(dev.swarmz.phone.state.TileKey("mini", "t3"))
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("Message docs\u2026") > 0 }
        compose.onNodeWithText("Tiles").assertDoesNotExist()
        // On a tile the control sits in the header, where the back arrow sits when folded.
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.onNodeWithContentDescription("Show the list").performClick()
        compose.waitUntil(5_000) { !vm.listCollapsed.value }
        compose.onNodeWithText("Tiles").assertIsDisplayed()
        compose.onNodeWithContentDescription("Show the list").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "w700dp-h800dp")
    fun unfoldedResizesTheListByDraggingTheHandle() {
        val vm = vm(paired = true)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("docs") > 0 }
        assertEquals(260, vm.listWidth.value)
        compose.onNodeWithContentDescription("Resize the list").performTouchInput {
            down(center)
            moveBy(Offset(30f, 0f))
            moveBy(Offset(30f, 0f))
            moveBy(Offset(30f, 0f))
            up()
        }
        // The settled width is what reaches settings; the exact dp depends on the touch slop.
        compose.waitUntil(5_000) { vm.listWidth.value > 260 }
        assertTrue("dragged to ${vm.listWidth.value} dp", vm.listWidth.value in 261..380)
    }

    @Test
    @Config(qualifiers = "w700dp-h800dp")
    fun theListStopsWhereTheDetailPaneStillHasItsFloor() {
        val vm = vm(paired = true)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("docs") > 0 }
        compose.onNodeWithContentDescription("Resize the list").performTouchInput {
            down(center)
            moveBy(Offset(150f, 0f))
            moveBy(Offset(150f, 0f))
            moveBy(Offset(150f, 0f))
            up()
        }
        // The handle is a row child too, so the ceiling is 700 - 320 - 12, not 700 - 320.
        compose.waitUntil(5_000) { vm.listWidth.value > 260 }
        assertEquals(368, vm.listWidth.value)
    }

    @Test
    @Config(qualifiers = "w360dp-h780dp")
    fun foldedHasNoListPaneControls() {
        val vm = vm(paired = true)
        compose.setContent { SwarmzRoot(vm) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("docs") > 0 }
        compose.onNodeWithContentDescription("Hide the list").assertDoesNotExist()
        compose.onNodeWithContentDescription("Show the list").assertDoesNotExist()
        compose.onNodeWithContentDescription("Resize the list").assertDoesNotExist()
        // A list collapsed while unfolded changes nothing folded: the tile still has its back arrow.
        vm.setListCollapsed(true)
        compose.waitUntil(5_000) { vm.listCollapsed.value }
        compose.onNodeWithText("docs").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTextCount("Message docs\u2026") > 0 }
        compose.onNodeWithContentDescription("Back").assertIsDisplayed()
        compose.onNodeWithContentDescription("Show the list").assertDoesNotExist()
    }
}

private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTextCount(text: String) =
    onAllNodes(androidx.compose.ui.test.hasText(text)).fetchSemanticsNodes().size
