package com.knowscroll.mobile.ui.fidelity

import android.graphics.Bitmap
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpRect
import java.io.File

/**
 * Shared helpers for the #111 fidelity tests. Kept separate from the tests themselves so each
 * test file stays readable as a list of claims from docs/product/ui-system.md.
 */

/** Converts a Compose test node's root-relative bounds (Dp) into a pixel rectangle for sampling
 * a captured [Bitmap], using the same [Density] the content was composed with. */
internal fun DpRect.toPixelRect(density: Density): IntRectPx = with(density) {
    IntRectPx(
        left = left.toPx().toInt(),
        top = top.toPx().toInt(),
        right = right.toPx().toInt(),
        bottom = bottom.toPx().toInt()
    )
}

internal data class IntRectPx(val left: Int, val top: Int, val right: Int, val bottom: Int)

/** The most common pixel colour inside [rect] that is not within [tolerance] of [background] on
 * every channel. Used to find the "ink" colour of a rendered label without depending on which
 * glyphs happen to be drawn (different truth-state words have different shapes, but the same
 * colour treatment applied to all of them must still expose the same dominant non-background
 * colour). Returns null if every sampled pixel matched the background (nothing was drawn, or the
 * rect missed the glyphs entirely). */
internal fun Bitmap.dominantInkColor(rect: IntRectPx, background: Int, tolerance: Int = 24): Int? {
    val counts = HashMap<Int, Int>()
    val left = rect.left.coerceIn(0, width - 1)
    val right = rect.right.coerceIn(left + 1, width)
    val top = rect.top.coerceIn(0, height - 1)
    val bottom = rect.bottom.coerceIn(top + 1, height)
    for (y in top until bottom) {
        for (x in left until right) {
            val pixel = getPixel(x, y)
            if (!closeTo(pixel, background, tolerance)) {
                counts[pixel] = (counts[pixel] ?: 0) + 1
            }
        }
    }
    return counts.maxByOrNull { it.value }?.key
}

private fun closeTo(a: Int, b: Int, tolerance: Int): Boolean {
    val channels = intArrayOf(24, 16, 8, 0) // A, R, G, B shifts
    for (shift in channels) {
        val ca = (a shr shift) and 0xFF
        val cb = (b shr shift) and 0xFF
        if (kotlin.math.abs(ca - cb) > tolerance) return false
    }
    return true
}

/** Locates a file under the mobile module root by walking up from the JVM working directory,
 * which Gradle sets differently depending on how the test task is invoked. Shared by the tests
 * that check a source-level fact Compose's own test APIs cannot answer (a literal in a file, or
 * whether any file references a given platform constant). */
internal fun findMobileModuleFile(relativeToModuleRoot: String): File {
    var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
    repeat(6) {
        val candidate = File(dir, relativeToModuleRoot)
        if (candidate.exists()) return candidate
        dir = dir.parentFile ?: return@repeat
    }
    throw IllegalStateException(
        "Could not find $relativeToModuleRoot from working directory " +
            (System.getProperty("user.dir") ?: "?")
    )
}
