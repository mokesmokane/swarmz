package dev.swarmz.phone.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.TextFieldValue

/** Draws a mic that dictates into [target]. Task 14 provides the real one. */
interface MicSlot {
    @Composable
    fun Content(target: MutableState<TextFieldValue>, modifier: Modifier)
}

object NoMic : MicSlot {
    @Composable
    override fun Content(target: MutableState<TextFieldValue>, modifier: Modifier) = Unit
}

val LocalMic = staticCompositionLocalOf<MicSlot> { NoMic }
