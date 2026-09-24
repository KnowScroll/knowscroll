package com.knowscroll.mobile.ui.system

import com.knowscroll.mobile.data.AtlasAnchor
import com.knowscroll.mobile.data.AtlasAttention
import com.knowscroll.mobile.data.AtlasBasis
import com.knowscroll.mobile.data.AtlasPlace
import com.knowscroll.mobile.data.AtlasRelation
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.data.AtlasScrollCounts
import org.junit.Assert.*
import org.junit.Test

/** #134: pure mapping from the reader's live places to `SpatialAtlas`'s existing marker/region
 * seams, and the copy shown for a place's basis, relations and chronicle -- unit-testable without
 * a live ViewModel or a running server, mirrors `BranchesTest`'s `branchAvailabilityOf`. */
class AtlasPresentationTest {
    private fun anchor(code: String, name: String) = AtlasAnchor(code, name, "$name description")
    private fun planet(id: String, name: String, seen: Int = 2, total: Int = 3, state: String = "anchored") = AtlasPlace(
        placeId = id, kind = "planet", parentPlaceId = null, anchor = anchor("c.$id", name),
        basis = null, attention = AtlasAttention(state, 3, 2, 2), scrolls = AtlasScrollCounts(total, seen),
        formedAt = "2026-09-23T00:00:00.000Z", formedBy = "place_formed",
    )
    private fun region(id: String, name: String, parentId: String) = AtlasPlace(
        placeId = id, kind = "region", parentPlaceId = parentId, anchor = anchor("c.$id", name),
        basis = null, attention = AtlasAttention("anchored", 1, 1, 1), scrolls = AtlasScrollCounts(1, 1),
        formedAt = "2026-09-23T00:00:00.000Z", formedBy = "place_formed",
    )
    private fun sighting(id: String, name: String, parentId: String, from: String, to: String) = AtlasPlace(
        placeId = id, kind = "sighting", parentPlaceId = parentId, anchor = anchor("c.$id", name),
        basis = AtlasBasis("explains", from, to, null, null), attention = null, scrolls = AtlasScrollCounts(0, 0),
        formedAt = "2026-09-24T00:00:00.000Z", formedBy = "sighting_appeared",
    )

    @Test
    fun defaultsToPlacesOnlyWhenAtLeastOnePlanetExists() {
        assertEquals(AtlasLayer.Sources, defaultAtlasLayer(emptyList()))
        assertEquals(AtlasLayer.Sources, defaultAtlasLayer(listOf(region("r1", "Region", "p1"))))
        assertEquals(AtlasLayer.Places, defaultAtlasLayer(listOf(planet("p1", "Gravity"))))
    }

    @Test
    fun planetMarkersCarryTheirRealCountsAndStatusOnly() {
        val places = listOf(planet("p1", "Gravity", seen = 2, total = 3), sighting("s1", "Star formation", "p1", "Gravity", "Star formation"))
        val markers = planetMarkersOf(places)
        assertEquals(1, markers.size)
        assertEquals("Gravity", markers.single().title)
        assertEquals("2 of 3 Scrolls read", markers.single().detail)
        assertEquals("ANCHORED", markers.single().status)
        assertNull(markers.single().parentId)
    }

    @Test
    fun sightingMarkersNameTheirParentAndCarryNoStatus() {
        val places = listOf(planet("p1", "Gravity"), sighting("s1", "Star formation", "p1", "Gravity", "Star formation"))
        val markers = sightingMarkersOf(places)
        assertEquals("p1", markers.single().parentId)
        assertEquals("Star formation", markers.single().title)
        assertTrue("a sighting carries no status: it is something the reader has not been shown", markers.single().status.isEmpty())
    }

    @Test
    fun regionAreasAreScopedToTheirOwnPlanetAndPositionedById() {
        val places = listOf(
            planet("p1", "Gravity"), region("r1", "Tides", "p1"), region("r2", "Orbits", "p1"),
            planet("p2", "Light"), region("r3", "Refraction", "p2"),
        )
        val forP1 = regionAreasOf(places, "p1")
        assertEquals(setOf("Tides", "Orbits"), forP1.map { it.name }.toSet())
        assertTrue(forP1.none { it.name == "Refraction" })
        assertTrue("Places form a land area, not the origin", forP1.all { it.x != 0f || it.y != 0f })
        assertEquals(emptyList<AtlasRegionArea>(), regionAreasOf(places, "p2").filter { it.name == "Tides" })
    }

    @Test
    fun basisAndRelationSentencesUseTheSharedCartographerVerbTable() {
        val basis = AtlasBasis("prerequisite_for", "Masses attract", "Orbits", null, null)
        assertEquals("Masses attract comes before Orbits", basisSentence(basis))
        val places = listOf(planet("p1", "Gravity"), planet("p2", "Tides"))
        val forward = AtlasRelation("p1", "p2", "explains", null, null)
        assertEquals("Gravity explains Tides", placeRelationSentence(forward, "p1", places))
        assertEquals("Gravity explains Tides", placeRelationSentence(forward, "p2", places))
        assertNull(placeRelationSentence(AtlasRelation("p1", "gone", "explains", null, null), "p1", places))
    }

    /** #134: the debug-only Authored Atlas preview (under `ui/preview`) reads this same data and
     * must stay labelled authored -- this pins that the Places work left it byte-for-byte unchanged. */
    @Test
    fun theAuthoredRegionCatalogItselfIsUntouchedByPlaces() {
        assertEquals(
            listOf(
                AuthoredRegion("coast", "North coast", -42f, -28f, true),
                AuthoredRegion("inland", "Inland", 46f, 38f, true),
                AuthoredRegion("unknown", "Uncharted", 58f, -52f, false),
            ),
            authoredRegions,
        )
    }

    @Test
    fun chronicleForFiltersToOnePlaceOnly() {
        val response = AtlasResponse(
            "cartographer-v1", places = listOf(planet("p1", "Gravity"), planet("p2", "Tides")),
            relations = emptyList(),
            chronicle = listOf(
                com.knowscroll.mobile.data.AtlasChronicleEntry("d1", "p1", "place_formed", "personal_exploration", "2026-09-23T00:00:00.000Z", "A place formed around Gravity."),
                com.knowscroll.mobile.data.AtlasChronicleEntry("d2", "p2", "place_formed", "personal_exploration", "2026-09-23T00:00:00.000Z", "A place formed around Tides."),
            ),
        )
        assertEquals(listOf("d1"), chronicleFor(response, "p1").map { it.deltaId })
    }
}
