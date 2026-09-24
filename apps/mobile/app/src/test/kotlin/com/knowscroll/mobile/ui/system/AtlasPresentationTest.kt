package com.knowscroll.mobile.ui.system

import com.knowscroll.mobile.data.AtlasAnchor
import com.knowscroll.mobile.data.AtlasAttention
import com.knowscroll.mobile.data.AtlasBasis
import com.knowscroll.mobile.data.AtlasBridgeSupport
import com.knowscroll.mobile.data.AtlasClaim
import com.knowscroll.mobile.data.AtlasDelta
import com.knowscroll.mobile.data.AtlasFoundation
import com.knowscroll.mobile.data.AtlasPlace
import com.knowscroll.mobile.data.AtlasRelation
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.data.AtlasRoom
import com.knowscroll.mobile.data.AtlasScrollCounts
import com.knowscroll.mobile.data.BoundScroll
import com.knowscroll.mobile.data.PlaceDemand
import com.knowscroll.mobile.data.RoomAskEvidence
import com.knowscroll.mobile.data.RoomChronicleEntry
import com.knowscroll.mobile.data.RoomClaim
import com.knowscroll.mobile.data.RoomEvidence
import com.knowscroll.mobile.data.RoomInhabitant
import com.knowscroll.mobile.ui.pointsAtASource
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

    /** #164 (ADR-0046 §6): a place's need for more is said from its own state, the place's name and a
     * bound Scroll's title -- never from where anything came from. */
    @Test
    fun aPlacesNeedForMoreIsSaidFromItsStateAlone() {
        val tides = planet("p1", "Tides")
        assertNull(placeDemandView(tides))
        fun viewOf(demand: PlaceDemand) = placeDemandView(tides.copy(demand = demand))!!
        assertEquals(PlaceDemandView("Being written: more about Tides", emptyList(), null), viewOf(PlaceDemand("d", "waiting", null, null, false)))
        assertEquals(
            PlaceDemandView("New for you: Two bulges of water", emptyList(), "s1"),
            viewOf(PlaceDemand("d", "bound", null, BoundScroll("s1", "Two bulges of water"), false)),
        )
        assertEquals(
            PlaceDemandView("Nothing more about Tides for now", listOf("Writing more has reached its limit for now."), null),
            viewOf(PlaceDemand("d", "cannot_meet", "no_budget", null, false)),
        )
        // The Scroll last bound to it was withdrawn: the need is met again, and the sheet says why it went.
        assertEquals(listOf("Withdrawn: what it was based on changed"), viewOf(PlaceDemand("d", "waiting", null, null, true)).notes)
        assertEquals(
            listOf("Withdrawn: what it was based on changed", "The last attempt to write more did not finish."),
            viewOf(PlaceDemand("d", "cannot_meet", "request_failed", null, true)).notes,
        )
        for (reason in listOf("no_route", "no_budget", "no_material", "checks_failed", "request_failed")) {
            val notes = viewOf(PlaceDemand("d", "cannot_meet", reason, null, false)).notes
            assertEquals(reason, 1, notes.size)
            assertFalse(reason, pointsAtASource(notes.single()))
        }
    }

    /** #161: a connection rests on its claim, shown without the source it came from. */
    @Test
    fun aConnectionsSupportIsItsClaimOrMechanismNeverItsSource() {
        assertEquals("\"Gravity pulls gas clouds together.\"", supportLine(AtlasClaim("Gravity pulls gas clouds together.", "NASA · Star formation"), null))
        assertEquals("Tidal forces synchronise rotation.", supportLine(null, AtlasBridgeSupport("Tidal forces synchronise rotation.")))
        assertNull(supportLine(null, null))
    }

    @Test
    fun aSightingsEvidenceQuotesItsClaimAndAWithdrawalNeverNamesASource() {
        fun delta(kind: String, causalClass: String, evidence: Map<String, Any?>) = AtlasDelta(
            "d1", "s1", kind, causalClass, "cartographer-v1", "2026-09-24T00:00:00.000Z", "c.stars", "Star formation", null, emptyMap(), evidence,
        )
        val appeared = delta("sighting_appeared", "substrate_neighbourhood", mapOf(
            "relation" to mapOf("kind" to "explains"),
            "relationSupport" to mapOf("claim" to mapOf("text" to "Gravity pulls gas clouds together.", "sourceTitle" to "NASA · Star formation")),
        ))
        assertEquals("A connection that explains. \"Gravity pulls gas clouds together.\"", evidenceSummary(appeared))
        assertEquals("What this connection was based on changed.", evidenceSummary(delta("sighting_retired", "source_correction", emptyMap())))
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

    /** ADR-0037: a foundation is a property of its place -- marked on the marker, and named with
     * the live places it holds up (an id no longer among them is dropped, never guessed). */
    @Test
    fun aFoundationIsMarkedAndNamedWithTheLivePlacesItHoldsUp() {
        val gravity = planet("p1", "Gravity").copy(
            foundation = AtlasFoundation(listOf("p2", "p3", "gone"), listOf(AtlasBasis("explains", "Gravity", "Tides", null, null))),
        )
        val tides = planet("p2", "Tides")
        val places = listOf(gravity, tides, region("p3", "Orbits", "p2"))
        val markers = planetMarkersOf(places)
        assertTrue(markers.single { it.id == "p1" }.foundation)
        assertFalse(markers.single { it.id == "p2" }.foundation)
        assertEquals("Holds up Tides and Orbits", holdsUpLine(gravity, places))
        assertNull("not a foundation: nothing to say", holdsUpLine(tides, places))
        assertNull("holds up nothing still live: nothing to say", holdsUpLine(gravity, listOf(gravity)))
        assertEquals("2 of 3 Scrolls read · Foundation", placeListRows(places).single { it.placeId == "p1" }.detail)
        assertEquals("2 of 3 Scrolls read", placeListRows(places).single { it.placeId == "p2" }.detail)
    }

    @Test
    fun aPlacesConnectionsLeaveOutWhatItsFoundationAlreadyLists() {
        val gravity = planet("p1", "Gravity").copy(
            foundation = AtlasFoundation(listOf("p2"), listOf(AtlasBasis("explains", "Gravity", "Tides", null, null))),
        )
        val places = listOf(gravity, planet("p2", "Tides"), planet("p3", "Light"), planet("p4", "Orbits"))
        val atlas = AtlasResponse("cartographer-v2", places, listOf(
            AtlasRelation("p1", "p2", "explains", null, null),
            AtlasRelation("p1", "p3", "explains", null, null),
            AtlasRelation("p4", "p1", "applies_to", null, null),
        ), emptyList())
        assertEquals(listOf("Gravity explains Light", "Orbits applies to Gravity"), placeConnections(gravity, atlas).map { it.first })
        // Tides is not a foundation: from its own side the same relation is an ordinary connection.
        assertEquals(listOf("Gravity explains Tides"), placeConnections(places[1], atlas).map { it.first })
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
                chronicleEntry("d4", "s1", "p1", "sighting_retired", "personal_exploration", "You came across Star formation."),
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

    /** Review 3: a place naming a parent this payload does not itself carry (paged, stale, or a
     * foreign reference) is a top-level row, never silently dropped. */
    @Test
    fun placeListRowsTreatsAnOrphanedParentAsTopLevel() {
        val orphan = region("r1", "Tides", "gone")
        val rows = placeListRows(listOf(planet("p1", "Gravity"), orphan))
        assertEquals(setOf("Gravity", "Tides"), rows.map { it.name }.toSet())
        assertEquals(0, rows.single { it.name == "Tides" }.depth)
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

    private fun room(state: String = "opened") = AtlasRoom(
        "r1", "So what is gravity, really?", state,
        listOf(RoomInhabitant("reader_of_record", listOf(RoomClaim("clm.gravity.definition", "Gravity draws objects toward a planet's center.", "documented", "supports")))),
        "2026-09-25T10:00:00.000Z",
    )

    /** #163 (ADR-0045): a place that holds a room says so on its marker, its region area and its
     * row -- a property of the place, never a new object -- and a sighting never does. */
    @Test
    fun aPlaceThatHoldsARoomIsMarkedAsOneWithoutANewObject() {
        val gravity = planet("p1", "Gravity").copy(rooms = listOf(room()))
        val light = planet("p2", "Light")
        val tides = region("r1", "Tides", "p1").copy(rooms = listOf(room(), room("arguing")))
        val places = listOf(gravity, light, tides)
        assertEquals(listOf(true, false), planetMarkersOf(places).map { it.room })
        assertEquals(2, planetMarkersOf(places).size)
        assertEquals(listOf(true), regionAreasOf(places, "p1").map { it.room })
        assertEquals(
            listOf("2 of 3 Scrolls read · Idea room", "1 of 1 Scroll read · 2 idea rooms", "2 of 3 Scrolls read"),
            placeListRows(places).map { it.detail },
        )
    }

    @Test
    fun aRoomIsWordedByItsLadderItsSeatsAndTheClaimsTheyHoldNeverTheirSource() {
        assertEquals(listOf("One reading so far", "Two readings disagree", "You set this room aside", "This room has closed"),
            listOf("opened", "arguing", "set_aside", "retired").map(::roomStateWords))
        assertEquals(listOf("The reader of record", "The doubter", "The connector"), listOf("reader_of_record", "doubter", "connector").map(::roomRoleTitle))
        fun claim(kind: String) = RoomClaim("clm.k", "Gravity is the curving of space and time.", "documented", kind)
        assertEquals("\"Gravity is the curving of space and time.\"", roomClaimLine(claim("supports")))
        assertEquals("\"Gravity is the curving of space and time.\" (qualified)", roomClaimLine(claim("qualifies")))
        assertEquals("\"Gravity is the curving of space and time.\" (contested)", roomClaimLine(claim("contradicts")))
    }

    @Test
    fun aRoomLinesEvidenceSaysOnlyWhatItsChangeRecorded() {
        val held = listOf(RoomClaim("clm.k", "Gravity is the curving of space and time.", "documented", "qualifies"))
        fun entry(kind: String, evidence: RoomEvidence) = RoomChronicleEntry("d1", kind, "source_correction", "doubter", "2026-09-25T10:00:00.000Z", "line", evidence)
        val asks = RoomEvidence(listOf(RoomAskEvidence("a1", "2026-09-24"), RoomAskEvidence("a2", "2026-09-25"), RoomAskEvidence("a3", "2026-09-25")), emptyList(), emptyList())
        assertEquals("Asked 3 times, on 2026-09-24 and 2026-09-25.", roomEvidenceSummary(entry("room_opened", asks)))
        assertEquals("It holds \"Gravity is the curving of space and time.\" (qualified)", roomEvidenceSummary(entry("inhabitant_seated", RoomEvidence(emptyList(), held, emptyList()))))
        assertEquals("It held \"Gravity is the curving of space and time.\" (qualified)", roomEvidenceSummary(entry("inhabitant_unseated", RoomEvidence(emptyList(), held, emptyList()))))
        val moved = roomEvidenceSummary(entry("position_changed", RoomEvidence(emptyList(), held, held)))
        assertEquals(listOf("It holds", "Before, it held"), moved.lines().map { it.substringBefore(" \"") })
        assertEquals("Nothing more was recorded for this change.", roomEvidenceSummary(entry("room_set_aside", RoomEvidence(emptyList(), emptyList(), emptyList()))))
    }

    private fun chronicleEntry(deltaId: String, placeId: String, parentPlaceId: String?, kind: String, causalClass: String, line: String) =
        com.knowscroll.mobile.data.AtlasChronicleEntry(deltaId, placeId, parentPlaceId, kind, causalClass, "2026-09-23T00:00:00.000Z", line)
}
