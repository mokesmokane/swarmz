package dev.swarmz.phone.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertTextContains
import dev.swarmz.phone.data.PairHint
import dev.swarmz.phone.proto.Opt
import dev.swarmz.phone.proto.Pending
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.state.MacInfo
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.TileView
import dev.swarmz.phone.state.homeModel
import dev.swarmz.phone.state.tileListSections
import dev.swarmz.phone.ui.home.HomeScreen
import dev.swarmz.phone.ui.home.TileListPane
import dev.swarmz.phone.ssh.MemoryPins
import dev.swarmz.phone.ui.pairing.PairingScreen
import dev.swarmz.phone.ui.pairing.defaultDeviceName
import dev.swarmz.phone.ui.theme.SwarmzTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

fun sampleHome(): HomeUi {
    val now = Instant.parse("2026-09-17T10:10:00Z")
    fun v(id: String, name: String, needs: String? = null, status: String = "idle", turnEnded: String? = null, last: String? = null, mac: String = "mini", online: Boolean = true, title: String? = null) =
        TileView(
            TileKey(mac, id),
            TileRow(id = id, name = name, cwd = "/p/$name", kind = "claude", running = true, status = status, needs = needs, since = "2026-09-17T10:00:00Z", turnEndedAt = turnEnded, lastMessage = last, title = title),
            if (mac == "mini") "Mini" else mac,
            online,
        )
    val tiles = listOf(
        v("t1", "api", needs = "permission", status = "blocked"),
        v("t2", "web", turnEnded = "2026-09-17T10:05:00Z", last = "All tests pass."),
        v("t3", "docs", status = "working"),
        v("t4", "infra", mac = "studio", online = false, title = "Infra: rotate the certs"),
    )
    val macs = listOf(MacInfo("mini", "Mini", true, now), MacInfo("studio", "studio", false, now.minusSeconds(7200)))
    return HomeUi(
        model = homeModel(tiles, emptyMap()),
        sections = tileListSections(tiles, emptyMap(), macs),
        asks = mapOf(TileKey("mini", "t1") to Pending("Bash", "npm test", listOf(Opt(1, "Yes"), Opt(2, "No")))),
        banners = emptyList(),
        macs = macs,
        now = now,
    )
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class HomeScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test
    @Config(qualifiers = "w360dp-h780dp")
    fun homeShowsCardsChipsAndActions() {
        val events = mutableListOf<String>()
        compose.setContent {
            SwarmzTheme {
                HomeScreen(
                    sampleHome(),
                    onOpen = { events += "open ${it.id}" },
                    onAllow = { events += "allow ${it.id}" },
                    onDeny = { events += "deny ${it.id}" },
                    onReply = { k, t -> events += "reply ${k.id} $t" },
                    onNew = { events += "new" },
                    onSettings = { events += "settings" },
                )
            }
        }
        compose.onNodeWithText("2 agents need you").assertIsDisplayed()
        compose.onNodeWithText("2 others running quietly").assertIsDisplayed()
        compose.onNodeWithText("PERMISSION").assertIsDisplayed()
        compose.onNodeWithText("npm test", substring = true).assertIsDisplayed()
        compose.onNodeWithText("“All tests pass.”").assertIsDisplayed()
        compose.onNodeWithText("Allow once").performClick()
        compose.onNodeWithText("Deny").performClick()
        compose.onNodeWithTag("reply-web").performTextInput("ship it")
        compose.onNodeWithContentDescription("Send reply to web").performClick()
        // A tile with a card shows its title where its name would be (conversation cards spec §6).
        compose.onNodeWithText("Infra: rotate the certs").assertExists()
        compose.onNodeWithText("docs").performClick()
        compose.onNodeWithText("New session").performClick()
        assertEquals(listOf("allow t1", "deny t1", "reply t2 ship it", "open t3", "new"), events)
    }

    @Test
    fun tileListHasANeedsYouSectionThenOnePerMac() {
        var opened: TileKey? = null
        compose.setContent {
            SwarmzTheme {
                TileListPane(sampleHome(), selected = TileKey("mini", "t3"), onOpen = { opened = it }, onNew = {}, onSettings = {})
            }
        }
        compose.onNodeWithText("Tiles").assertIsDisplayed()
        compose.onNodeWithText("NEEDS YOU").assertIsDisplayed()
        compose.onNodeWithText("MINI").assertIsDisplayed()
        compose.onNodeWithText("STUDIO").assertIsDisplayed()
        compose.onNodeWithText("last seen 2h ago", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Mini · permission").assertIsDisplayed()
        compose.onNodeWithText("docs").performClick()
        assertEquals(TileKey("mini", "t3"), opened)
    }

    @Test
    fun pairingScreenPassesTheFieldsAndShowsErrors() {
        var paired: List<String>? = null
        compose.setContent {
            SwarmzTheme {
                PairingScreen(
                    PairingUi(error = "Can't reach mini. Is Tailscale connected?"),
                    defaultDevice = "",
                    onPair = { host, user, password, device -> paired = listOf(host, user, String(password), device) },
                    pins = MemoryPins(),
                )
            }
        }
        compose.onNodeWithText("Can't reach mini. Is Tailscale connected?").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Mac name").performScrollTo().performTextInput("mini")
        compose.onNodeWithText("Username").performScrollTo().performTextInput("me")
        compose.onNodeWithText("Password").performScrollTo().performTextInput("pw")
        compose.onNodeWithText("This phone's name").performScrollTo().performTextInput("Fold")
        compose.onNodeWithText("Pair").performScrollTo().performClick()
        assertEquals(listOf("mini", "me", "pw", "Fold"), paired)
    }

    @Test
    fun defaultDeviceNamesPassValidation() {
        assertEquals("SM-F966U", defaultDeviceName("SM-F966U"))
        assertEquals("Galaxy Z Fold7 5G", defaultDeviceName("Galaxy Z Fold7 (5G)"))
    }

    @Test
    @Config(qualifiers = "w360dp-h780dp")
    fun aFailedReplyIsPutBackWithItsError() {
        val web = TileKey("mini", "t2")
        var restored: TileKey? = null
        val ui = sampleHome().copy(replyErrors = mapOf(web to ReplyError("ship it", "Couldn't send: web is not running")))
        compose.setContent {
            SwarmzTheme {
                HomeScreen(ui, onOpen = {}, onAllow = {}, onDeny = {}, onReply = { _, _ -> }, onNew = {}, onSettings = {}, onReplyRestored = { restored = it })
            }
        }
        compose.onNodeWithTag("reply-web").assertTextContains("ship it")
        compose.onNodeWithText("Couldn't send: web is not running").assertIsDisplayed()
        compose.waitUntil(5_000) { restored == web }
    }

    @Test
    @Config(qualifiers = "w360dp-h780dp")
    fun anUnpairedMacGetsOneQuietLineOnHome() {
        val events = mutableListOf<String>()
        val ui = sampleHome().copy(pairHints = listOf(PairHint("studio", "Studio")))
        compose.setContent {
            SwarmzTheme {
                HomeScreen(
                    ui,
                    onOpen = {}, onAllow = {}, onDeny = {}, onReply = { _, _ -> }, onNew = {}, onSettings = {},
                    onPairMac = { events += "pair $it" },
                    onDismissHint = { events += "dismiss $it" },
                )
            }
        }
        compose.onNodeWithText("Studio isn't paired with this phone yet · Pair").assertIsDisplayed().performClick()
        compose.onNodeWithContentDescription("Dismiss").performClick()
        assertEquals(listOf("pair studio", "dismiss studio"), events)
    }

    @Test
    fun macsWithTheSameLabelGetTheirOwnSections() {
        val base = sampleHome()
        val now = base.now
        val macs = listOf(MacInfo("mini", "Mac", true, now), MacInfo("studio", "Mac", true, now))
        val tiles = listOf(
            TileView(TileKey("mini", "a"), TileRow(id = "a", name = "one", cwd = "/p", kind = "claude", running = true, status = "idle"), "Mac", true),
            TileView(TileKey("studio", "b"), TileRow(id = "b", name = "two", cwd = "/p", kind = "claude", running = true, status = "idle"), "Mac", true),
        )
        val ui = base.copy(model = homeModel(tiles, emptyMap()), sections = tileListSections(tiles, emptyMap(), macs), asks = emptyMap(), macs = macs)
        compose.setContent {
            SwarmzTheme { TileListPane(ui, selected = null, onOpen = {}, onNew = {}, onSettings = {}) }
        }
        compose.onNodeWithText("one").assertIsDisplayed()
        compose.onNodeWithText("two").assertIsDisplayed()
    }
}
