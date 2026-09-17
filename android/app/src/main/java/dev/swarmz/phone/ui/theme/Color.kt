package dev.swarmz.phone.ui.theme

import androidx.compose.ui.graphics.Color
import dev.swarmz.phone.state.Dot

object Sw {
    val Background = Color(0xFF0F172A)
    val Card = Color(0xFF151C2C)
    val CardHighTop = Color(0xFF1A2236)
    val Border = Color(0xFF1B2436)
    val Border2 = Color(0xFF253045)
    val Border3 = Color(0xFF2C3852)
    val Border4 = Color(0xFF3A4761)
    val Title = Color(0xFFF8FAFC)
    val Body = Color(0xFFE2E8F0)
    val Body2 = Color(0xFFCBD5E1)
    val Secondary = Color(0xFF94A3B8)
    val Muted = Color(0xFF64748B)
    val Code = Color(0xFFFFD27A)
    val ErrorLine = Color(0xFFF87171)
    val Primary = Color(0xFF363B94)
    val Working = Color(0xFF25BF35)
    val NeedsYou = Color(0xFFFFB21B)
    val Idle = Color(0xFF475569)
    val Exited = Color(0xFFFF0303)
}

fun Dot.color(): Color = when (this) {
    Dot.Working -> Sw.Working
    Dot.NeedsYou -> Sw.NeedsYou
    Dot.Idle -> Sw.Idle
    Dot.Error -> Sw.Exited
    Dot.Offline -> Sw.Muted
}
