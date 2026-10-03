package dev.swarmz.phone.ui.tile

import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sign

/** Drag per wheel notch, in dp. */
internal const val WHEEL_NOTCH_DP = 40f

/** The shortest gap between two notches: at most eight a second. */
internal const val WHEEL_MIN_INTERVAL_MS = 125L

/** The most notches one fling sends. */
internal const val WHEEL_FLING_MAX = 6

/**
 * Turns the drag a full-screen program's lines could not take into wheel notches (phone terminal-only spec,
 * amendment of 2026-10-03). Deltas are signed the way the reversed terminal list sees them: positive is toward
 * older content (`wheel-up`), negative toward newer (`wheel-down`). Results are signed the same way: +n is n
 * notches up, -n is n notches down.
 *
 * Pure: the caller passes the time, so the throttle is testable.
 */
internal class WheelNotches(
    private val stepPx: Float,
    private val minIntervalMs: Long = WHEEL_MIN_INTERVAL_MS,
    private val flingMax: Int = WHEEL_FLING_MAX,
) {
    private var acc = 0f
    private var lastAt: Long? = null

    /**
     * Leftover drag [delta] at [nowMs]: at most one notch, once a notch's worth has gathered in one direction and
     * the throttle allows. Drag gathered while throttled is kept, but never more than two notches' worth, so a
     * long fast drag does not leave a backlog behind it.
     */
    fun drag(delta: Float, nowMs: Long): Int {
        if (delta == 0f) return 0
        if (acc != 0f && sign(acc) != sign(delta)) acc = 0f
        acc += delta
        val cap = 2 * stepPx
        if (abs(acc) > cap) acc = sign(acc) * cap
        if (abs(acc) < stepPx) return 0
        val last = lastAt
        if (last != null && nowMs - last < minIntervalMs) return 0
        val dir = sign(acc).toInt()
        acc -= dir * stepPx
        lastAt = nowMs
        return dir
    }

    /**
     * Leftover fling [velocity] (px/s, signed as for [drag]): a notch for every notch's worth of drag the fling
     * would cover in a quarter second, at least one and at most [flingMax]. The caller spaces them by
     * [minIntervalMs]. A velocity under one notch per quarter second sends none.
     */
    fun fling(velocity: Float): Int {
        acc = 0f
        val n = (abs(velocity) * 0.25f / stepPx).toInt()
        if (n == 0) return 0
        return sign(velocity).toInt() * min(n, flingMax)
    }

    /** The list scrolled itself, so whatever was gathered toward a notch no longer counts. */
    fun reset() {
        acc = 0f
    }
}
