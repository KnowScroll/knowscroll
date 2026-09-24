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

    /** Review I2: a place's sheet shows its own lines (`placeId == place`) and the lines of what
     * belonged to it at the time (`parentPlaceId == place`) -- a sighting's own appearance/
     * retirement, or a region's release -- never only a bare `placeId` match. */
    @Test
    fun chronicleForShowsAPlacesOwnLinesAndTheLinesOfWhatBelongedToIt() {
        val response = AtlasResponse(
            "cartographer-v1", places = listOf(planet("p1", "Gravity"), planet("p2", "Tides")),
            relations = emptyList(),
            chronicle = listOf(
                chronicleEntry("d1", "p1", null, "place_formed", "personal_exploration", "A place formed around Gravity."),
                chronicleEntry("d2", "p2", null, "place_formed", "personal_exploration", "A place formed around Tides."),
                // A sighting's own line: its placeId is the sighting's, parentPlaceId is p1's.
                chronicleEntry("d3", "s1", "p1", "sighting_appeared", "substrate_neighbourhood", "Star formation appeared near Gravity."),
                chronicleEntry("d4", "s1", "p1", "sighting_retired", "personal_exploration", "You reached Star formation."),
                // p1's own rejection: placeId is p1's, no parent (it is a planet).
                chronicleEntry("d5", "p1", null, "place_rejected", "reader_correction", "You set Gravity aside."),
            ),
        )
        assertEquals(listOf("d1", "d3", "d4", "d5"), chronicleFor(response, "p1").map { it.deltaId })
        assertEquals(listOf("d2"), chronicleFor(response, "p2").map { it.deltaId })
    }

    @Test
    fun placeListRowsWalksEveryLivePlaceRegardlessOfNestingDepth() {
        val places = listOf(
            planet("p1", "Gravity"),
            region("r1", "Tides", "p1"),
            // A region nested inside another region -- invisible to regionAreasOf/the map (review I3).
            region("r2", "Neap tides", "r1"),
            sighting("s1", "Star formation", "p1", "Gravity", "Star formation"),
            sighting("s2", "Spin-orbit locking", "r2", "Neap tides", "Spin-orbit locking"),
        )
        val rows = placeListRows(places)
        assertEquals(
            listOf("Gravity" to 0, "Star formation" to 1, "Tides" to 1, "Neap tides" to 2, "Spin-orbit locking" to 3),
            rows.map { it.name to it.depth },
        )
        assertEquals("Sighting", rows.single { it.name == "Star formation" }.detail)
        assertEquals("region", rows.single { it.name == "Neap tides" }.kind)
    }

    @Test
    fun topmostAncestorResolvesAnyDepthBackToItsOwnPlanet() {
        val places = listOf(
            planet("p1", "Gravity"), region("r1", "Tides", "p1"), region("r2", "Neap tides", "r1"),
            sighting("s1", "Spin-orbit locking", "r2", "Neap tides", "Spin-orbit locking"),
        )
        assertEquals("p1", topmostAncestor(places, "p1"))
        assertEquals("p1", topmostAncestor(places, "r1"))
        assertEquals("p1", topmostAncestor(places, "r2"))
        assertEquals("p1", topmostAncestor(places, "s1"))
        // Defensive: an id the atlas does not carry resolves to itself, never throws.
        assertEquals("gone", topmostAncestor(places, "gone"))
    }

    @Test
    fun placesSubtitleCountsLivePlacesAndSightingsSeparately() {
        val places = listOf(
            planet("p1", "Gravity"), region("r1", "Tides", "p1"),
            sighting("s1", "Star formation", "p1", "Gravity", "Star formation"),
        )
        assertEquals("2 PLACES · 1 SIGHTING", placesSubtitle(places))
        assertEquals("0 PLACES · 0 SIGHTINGS", placesSubtitle(emptyList()))
    }

    private fun chronicleEntry(deltaId: String, placeId: String, parentPlaceId: String?, kind: String, causalClass: String, line: String) =
        com.knowscroll.mobile.data.AtlasChronicleEntry(deltaId, placeId, parentPlaceId, kind, causalClass, "2026-09-23T00:00:00.000Z", line)
}
