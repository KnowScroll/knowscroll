package com.knowscroll.mobile.ui.system

import com.knowscroll.mobile.data.WorldSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-function tests for [worldBodyFraction] and [isWorldFullyExplored] (#116). No
 * Robolectric/Compose needed -- both are plain Kotlin, deliberately factored out of the
 * `@Composable` tree for exactly this reason.
 *
 * These did not exist before this lane: run directly against the pre-#116 source, the whole
 * module fails to compile (`worldBodyFraction`/`isWorldFullyExplored`/`SystemScreen.kt` are not
 * present at all) -- the strongest possible red, since nothing here could pass by accident.
 * [angleStartsAtZeroNotNegativeHalfPi] additionally reproduces, then fixes, the actual bug named
 * in this lane's own brief: reverting the implementation's start angle from `0` to `-PI/2` (Kotlin
 * `Math.PI.toFloat() / -2f`) while running this file made this specific test fail with two bodies
 * landing at the identical `leftFraction` (0.5f), which is the web lane's own defect (two worlds
 * stacked vertically through the sun); restoring the `angle = index/total * 2π` start at 0 makes it
 * pass again. That direct revert-and-rerun is recorded in the delivering receipt.
 */
class SystemGeometryTest {

    @Test fun `single world sits on the wide axis, not the top`() {
        // angle 0: cos(0)=1, sin(0)=0 -- the right edge of the ellipse, vertically centred.
        val (left, top) = worldBodyFraction(0, 1)
        assertEquals(0.83f, left, 0.0001f)
        assertEquals(0.5f, top, 0.0001f)
    }

    @Test fun `two worlds are not stacked on the same vertical line through the sun`() {
        // This is the literal bug named in the brief: starting the spread at -PI/2 put body 0 at
        // the top and body 1 at the bottom, both at leftFraction 0.5 -- their label columns then
        // ran straight through the sun. Starting at 0 must not reproduce that.
        val (left0, top0) = worldBodyFraction(0, 2)
        val (left1, top1) = worldBodyFraction(1, 2)
        assertNotEquals("both worlds landed on the same horizontal position -- the -PI/2 stacking bug", left0, left1, 0.0001f)
        // At total=2 the two angles are 0 and PI, which are mirror images: same top, opposite left.
        assertEquals(top0, top1, 0.0001f)
        assertNotEquals(left0, left1, 0.0001f)
    }

    @Test fun `three worlds are spread around the full ring, none identical`() {
        val positions = (0 until 3).map { worldBodyFraction(it, 3) }
        val distinct = positions.map { it.first to it.second }.toSet()
        assertEquals("three distinct world bodies must not collapse onto the same point", 3, distinct.size)
    }

    @Test fun `every body stays within the orbit box`() {
        // leftFraction ranges 0.5 +/- 0.33 = [0.17, 0.83]; topFraction ranges 0.5 +/- 0.28 = [0.22, 0.78].
        for (index in 0 until 5) {
            val (left, top) = worldBodyFraction(index, 5)
            assertTrue("leftFraction $left out of [0.17,0.83]", left in 0.1699f..0.8301f)
            assertTrue("topFraction $top out of [0.22,0.78]", top in 0.2199f..0.7801f)
        }
    }

    private fun world(scrollCount: Int, seenCount: Int) =
        WorldSummary("w1", "Source", "https://example.test/source", scrollCount, seenCount)

    @Test fun `fully explored requires every recorded Scroll to be seen, and at least one to exist`() {
        assertTrue(isWorldFullyExplored(world(scrollCount = 1, seenCount = 1)))
        assertTrue(isWorldFullyExplored(world(scrollCount = 3, seenCount = 3)))
        // seenCount can never legitimately exceed scrollCount, but >= is the guarded contract's
        // own comparison (docs/contracts/bootstrap-http.md), not < -- honour it exactly.
        assertTrue(isWorldFullyExplored(world(scrollCount = 2, seenCount = 5)))
    }

    @Test fun `more to explore when real Scrolls remain unseen`() {
        assertTrue(!isWorldFullyExplored(world(scrollCount = 2, seenCount = 1)))
        assertTrue(!isWorldFullyExplored(world(scrollCount = 5, seenCount = 0)))
    }

    @Test fun `a world with no recorded Scrolls is never claimed fully explored`() {
        // ADR-0028: GET /v1/worlds never actually returns this shape (seen_count >= 1 is guarded),
        // but the pure function must still refuse "0 of 0 is complete" rather than divide-by-zero
        // its way into a false claim.
        assertTrue(!isWorldFullyExplored(world(scrollCount = 0, seenCount = 0)))
    }
}
