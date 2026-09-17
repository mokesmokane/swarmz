package dev.swarmz.phone

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.KeyPairGenerator
import java.security.Security

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ScaffoldTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun rootShowsTheAppName() {
        compose.setContent { SwarmzRoot() }
        compose.onNodeWithText("swarmz").assertExists()
    }

    @Test
    fun bouncyCastleProvidesEd25519() {
        installBouncyCastle()
        assertEquals("BC", Security.getProviders()[0].name)
        val kp = KeyPairGenerator.getInstance("Ed25519", "BC").generateKeyPair()
        assertEquals("Ed25519", kp.public.algorithm)
    }
}
