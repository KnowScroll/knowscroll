package com.knowscroll.mobile.ui.system

import org.junit.Assert.*
import org.junit.Test

class AtlasCameraTest {
    @Test
    fun pinchRetainsWorldPointUnderCentroid() {
        val before = AtlasCamera(24f, -16f, 1.2f)
        val after = before.transform(70f, 90f, 0f, 0f, 1.8f)
        assertEquals(before.x + 70 / before.zoom, after.x + 70 / after.zoom, .001f)
        assertEquals(before.y + 90 / before.zoom, after.y + 90 / after.zoom, .001f)
    }

    @Test
    fun panIsScaledAndBoundsAreFinite() {
        val moved = AtlasCamera(0f, 0f, 2f).transform(0f, 0f, 100f, -80f, 1f)
        assertEquals(-50f, moved.x, .001f)
        assertEquals(40f, moved.y, .001f)
        val limited = AtlasCamera(100000f, -100000f, 90f).bounded(atlasLayout(listOf("one")))
        assertEquals(180f, limited.x, .001f)
        assertEquals(-180f, limited.y, .001f)
        assertEquals(3.2f, limited.zoom, .001f)
        assertEquals(moved, moved.transform(Float.NaN, 0f, 0f, 0f, 1f))
    }

    @Test
    fun layoutDoesNotDependOnResponseOrdering() {
        assertEquals(atlasLayout(listOf("a", "b", "c")), atlasLayout(listOf("c", "a", "b")))
        assertEquals(100, atlasLayout((1..100).map { it.toString() }).map { it.id }.toSet().size)
    }
}
