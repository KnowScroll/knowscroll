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
        assertEquals(atlasLayout(listOf("one")).single().x + 180f, limited.x, .001f)
        assertEquals(atlasLayout(listOf("one")).single().y - 180f, limited.y, .001f)
        assertEquals(12f, limited.zoom, .001f)
        assertEquals(moved, moved.transform(Float.NaN, 0f, 0f, 0f, 1f))
    }

    @Test
    fun insertionRemovalAndSingletonGrowthPreserveExactBodyCoordinates() {
        val before = atlasLayout(listOf("b", "e"))
        val after = atlasLayout(listOf("a", "b", "c", "e", "f"))
        before.forEach { point -> assertEquals(point, after.single { it.id == point.id }) }
        assertEquals(before.first(), atlasLayout(listOf("b")).single())
        assertEquals(1, atlasLayout(listOf("b", "b")).size)
    }

    @Test
    fun layoutDoesNotDependOnResponseOrdering() {
        assertEquals(atlasLayout(listOf("a", "b", "c")), atlasLayout(listOf("c", "a", "b")))
        assertEquals(100, atlasLayout((1..100).map { it.toString() }).map { it.id }.toSet().size)
    }

    @Test
    fun authoredSystemKeepsAllThreeDestinationsVisible() {
        val points =
            atlasLayout(listOf("authored-orbits-v1", "authored-models-v1", "authored-demos-v1"))
        assertEquals(points, separatedPoints(points, .86f))
        assertTrue(stationVisible(points, .86f))
    }

    @Test
    fun regionAreaLayoutIsIdentityDerivedLikeAtlasLayout() {
        val before = regionAreaLayout(listOf("r1", "r2"))
        val after = regionAreaLayout(listOf("r0", "r1", "r2", "r3"))
        before.forEach { point -> assertEquals(point, after.single { it.id == point.id }) }
        assertEquals(regionAreaLayout(listOf("r1", "r2")), regionAreaLayout(listOf("r2", "r1")))
        assertEquals(1, regionAreaLayout(listOf("r1", "r1")).size)
    }

    @Test
    fun sightingOffsetIsSmallAndDeterministic() {
        val offset = sightingOffset("sighting-1")
        assertEquals(offset, sightingOffset("sighting-1"))
        assertTrue(kotlin.math.abs(offset.x) <= 30f && kotlin.math.abs(offset.y) <= 30f)
        assertNotEquals(sightingOffset("sighting-1").let { it.x to it.y }, sightingOffset("sighting-2").let { it.x to it.y })
    }

    @Test
    fun denseBodiesNeverShareATouchTargetAtAnyScale() {
        val points = atlasLayout((1..100).map { "dense-$it" })
        for (zoom in listOf(.35f, .86f, 1.5f, 3f, 12f)) {
            val shown = separatedPoints(points, zoom)
            assertTrue(shown.isNotEmpty())
            for ((i, a) in shown.withIndex()) for (b in shown.drop(i + 1)) {
                val dx = (a.x - b.x) * zoom
                val dy = (a.y - b.y) * zoom
                assertTrue(kotlin.math.abs(dx) >= 48f || kotlin.math.abs(dy) >= 48f)
                assertEquals(a, points.first { it.id == a.id })
            }
        }
    }
}
