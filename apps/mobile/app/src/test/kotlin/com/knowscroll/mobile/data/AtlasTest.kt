package com.knowscroll.mobile.data

import com.knowscroll.mobile.ui.system.SetAsideConflict
import com.knowscroll.mobile.ui.system.basisSentence
import com.knowscroll.mobile.ui.system.evidenceSummary
import com.knowscroll.mobile.ui.system.setAsideConflict
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.json.JSONException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #134: the reader's places (ADR-0036) are read back exactly as `packages/contracts/src/atlas.ts`
 * describes them, and a shape the server contract does not describe is refused, never shown --
 * mirrors `BranchesTest`/`WhyTest`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AtlasTest {
    private val gravityId = "11111111-1111-1111-1111-111111111111"
    private val sightingId = "22222222-2222-2222-2222-222222222222"
    private val deltaId = "33333333-3333-3333-3333-333333333333"

    private fun atlasJson(
        places: String = defaultPlaces(),
        relations: String = "[]",
        chronicle: String = defaultChronicle(),
    ) = JSONObject(
        """{"policyVersion":"cartographer-v1","places":$places,"relations":$relations,"chronicle":$chronicle}""",
    )

    private fun defaultPlaces() = """[
        {"placeId":"$gravityId","kind":"planet","parentPlaceId":null,
         "anchor":{"code":"physics.gravity","name":"Gravity","description":"The force that pulls masses together."},
         "basis":null,
         "attention":{"state":"anchored","episodes":3,"daysActive":2,"sourceFamilies":2},
         "scrolls":{"total":3,"seen":3},"formedAt":"2026-09-23T00:00:00.000Z","formedBy":"place_formed","foundation":null,"rooms":[],"demand":null},
        {"placeId":"$sightingId","kind":"sighting","parentPlaceId":"$gravityId",
         "anchor":{"code":"astro.star-formation","name":"Star formation","description":"How stars are born."},
         "basis":{"kind":"explains","from":"Gravity","to":"Star formation",
             "claim":{"text":"Gravity pulls gas clouds together until they ignite.","sourceTitle":"NASA · Star formation"},"bridge":null},
         "attention":null,"scrolls":{"total":0,"seen":0},"formedAt":"2026-09-24T00:00:00.000Z","formedBy":"sighting_appeared","foundation":null,"rooms":[],"demand":null}
    ]"""

    private fun defaultChronicle() = """[
        {"deltaId":"$deltaId","placeId":"$gravityId","parentPlaceId":null,"kind":"place_formed","causalClass":"personal_exploration",
         "at":"2026-09-23T00:00:00.000Z","line":"A place formed around Gravity."}
    ]"""

    @Test
    fun parsesLivePlacesTheirSightingsAndTheChronicle() {
        val atlas = parseAtlasResponse(atlasJson())
        assertEquals("cartographer-v1", atlas.policyVersion)
        val planet = atlas.places.single { it.kind == "planet" }
        assertEquals("Gravity", planet.anchor.name)
        assertEquals("anchored", planet.attention?.state)
        assertEquals(AtlasScrollCounts(3, 3), planet.scrolls)
        val sighting = atlas.places.single { it.kind == "sighting" }
        assertEquals(gravityId, sighting.parentPlaceId)
        assertNull("a sighting is something the reader has not been shown", sighting.attention)
        assertEquals("Gravity", sighting.basis?.from)
        assertEquals("Gravity explains Star formation", basisSentence(sighting.basis!!))
        assertEquals("A place formed around Gravity.", atlas.chronicle.single().line)
        assertNull("a planet's own delta carries no parent", atlas.chronicle.single().parentPlaceId)
    }

    /** A sighting the reader has now read retires as their own exploration (server review B1) --
     * `sighting_retired` + `personal_exploration` together, and the parent it retired out of. */
    @Test
    fun acceptsASightingRetiredByTheReadersOwnExplorationAndItsParent() {
        val retirement = """[{"deltaId":"$deltaId","placeId":"$sightingId","parentPlaceId":"$gravityId",
            "kind":"sighting_retired","causalClass":"personal_exploration",
            "at":"2026-09-24T00:00:00.000Z","line":"You came across Star formation."}]"""
        val atlas = parseAtlasResponse(atlasJson(chronicle = retirement))
        val entry = atlas.chronicle.single()
        assertEquals("sighting_retired", entry.kind)
        assertEquals("personal_exploration", entry.causalClass)
        assertEquals(gravityId, entry.parentPlaceId)
        assertEquals("You came across Star formation.", entry.line)
    }

    private val tidesId = "44444444-4444-4444-4444-444444444444"
    private val orbitsId = "55555555-5555-5555-5555-555555555555"

    /** ADR-0037: Gravity holds up Tides and Orbits, citing each sourced connection. */
    private fun foundationPlaces(foundation: String = """{"holdsUp":["$tidesId","$orbitsId"],"relations":[
            {"kind":"explains","from":"Gravity","to":"Tides","claim":{"text":"The Moon's gravity pulls on the ocean.","sourceTitle":"NOAA · Tides"},"bridge":null},
            {"kind":"explains","from":"Gravity","to":"Orbits","claim":{"text":"Gravity keeps planets in orbit.","sourceTitle":"NASA · Orbits"},"bridge":null}]}""") = """[
        {"placeId":"$gravityId","kind":"planet","parentPlaceId":null,
         "anchor":{"code":"physics.gravity","name":"Gravity","description":"The force that pulls masses together."},
         "basis":null,"attention":{"state":"anchored","episodes":3,"daysActive":2,"sourceFamilies":2},
         "scrolls":{"total":3,"seen":3},"formedAt":"2026-09-23T00:00:00.000Z","formedBy":"place_formed","foundation":$foundation,"rooms":[],"demand":null},
        {"placeId":"$tidesId","kind":"planet","parentPlaceId":null,
         "anchor":{"code":"earth.tides","name":"Tides","description":"The rise and fall of the sea."},
         "basis":null,"attention":{"state":"anchored","episodes":3,"daysActive":2,"sourceFamilies":2},
         "scrolls":{"total":2,"seen":2},"formedAt":"2026-09-23T00:00:00.000Z","formedBy":"place_formed","foundation":null,"rooms":[],"demand":null},
        {"placeId":"$orbitsId","kind":"planet","parentPlaceId":null,
         "anchor":{"code":"astro.orbit","name":"Orbits","description":"Paths around a larger body."},
         "basis":null,"attention":{"state":"anchored","episodes":3,"daysActive":2,"sourceFamilies":2},
         "scrolls":{"total":2,"seen":2},"formedAt":"2026-09-23T00:00:00.000Z","formedBy":"place_formed","foundation":null,"rooms":[],"demand":null}
    ]"""

    @Test
    fun parsesAFoundationWithWhatItHoldsUpAndTheClaimsThatSaySo() {
        val recognised = """[{"deltaId":"$deltaId","placeId":"$gravityId","parentPlaceId":null,"kind":"foundation_recognised",
            "causalClass":"substrate_neighbourhood","at":"2026-09-24T00:00:00.000Z","line":"Gravity holds up Orbits and Tides."}]"""
        val atlas = parseAtlasResponse(atlasJson(places = foundationPlaces(), chronicle = recognised))
        val gravity = atlas.places.single { it.anchor.name == "Gravity" }
        assertEquals(listOf(tidesId, orbitsId), gravity.foundation?.holdsUp)
        assertEquals(listOf("Tides", "Orbits"), gravity.foundation?.relations?.map { it.to })
        assertEquals("NOAA · Tides", gravity.foundation?.relations?.first()?.claim?.sourceTitle)
        assertNull("a held-up place is not itself a foundation", atlas.places.single { it.anchor.name == "Tides" }.foundation)
        assertEquals("foundation_recognised", atlas.chronicle.single().kind)
    }

    @Test
    fun acceptsAWithdrawnFoundationAsTheReadersCorrection() {
        val withdrawn = """[{"deltaId":"$deltaId","placeId":"$gravityId","parentPlaceId":null,"kind":"foundation_withdrawn",
            "causalClass":"reader_correction","at":"2026-09-24T00:00:00.000Z","line":"Gravity no longer holds up the places around it."}]"""
        val atlas = parseAtlasResponse(atlasJson(chronicle = withdrawn))
        assertEquals("foundation_withdrawn", atlas.chronicle.single().kind)
    }

    @Test
    fun refusesAFoundationOnASighting() {
        val dishonest = defaultPlaces().replace(
            "\"formedBy\":\"sighting_appeared\",\"foundation\":null",
            "\"formedBy\":\"sighting_appeared\",\"foundation\":{\"holdsUp\":[\"$gravityId\"],\"relations\":[{\"kind\":\"explains\",\"from\":\"Star formation\",\"to\":\"Gravity\",\"claim\":null,\"bridge\":{\"mechanism\":\"m\"}}]}",
        )
        assertNotEquals(defaultPlaces(), dishonest)
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = dishonest)) }
    }

    @Test
    fun refusesAFoundationThatHoldsNothingUpOrCitesNothing() {
        val holdsNothing = foundationPlaces("""{"holdsUp":[],"relations":[{"kind":"explains","from":"Gravity","to":"Tides","claim":null,"bridge":{"mechanism":"m"}}]}""")
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = holdsNothing)) }
        val citesNothing = foundationPlaces("""{"holdsUp":["$tidesId"],"relations":[]}""")
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = citesNothing)) }
        val unknownKind = foundationPlaces("""{"holdsUp":["$tidesId"],"relations":[{"kind":"vibes","from":"Gravity","to":"Tides","claim":null,"bridge":{"mechanism":"m"}}]}""")
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = unknownKind)) }
    }

    @Test
    fun refusesAPlaceThatDoesNotSayWhetherItIsAFoundation() {
        val silent = defaultPlaces().replace(",\"foundation\":null,", ",")
        assertNotEquals(defaultPlaces(), silent)
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = silent)) }
    }

    private val scrollId = "66666666-6666-4666-8666-666666666666"
    private val demandId = "77777777-7777-4777-8777-777777777777"

    /** #164 (ADR-0046 §6): the planet carries [demand] as its live need for more about it. */
    private fun withDemand(demand: String) = defaultPlaces().replaceFirst("\"rooms\":[],\"demand\":null}", "\"rooms\":[],\"demand\":$demand}")

    private fun demand(status: String, reason: String? = null, scroll: String = "null", withdrawn: Boolean = false) =
        """{"demandId":"$demandId","status":"$status","reason":${reason?.let { "\"$it\"" } ?: "null"},"scroll":$scroll,"withdrawn":$withdrawn}"""

    @Test
    fun parsesEachPlacesLiveNeedForMore() {
        assertTrue(parseAtlasResponse(atlasJson()).places.all { it.demand == null })
        val waiting = parseAtlasResponse(atlasJson(places = withDemand(demand("waiting", withdrawn = true)))).places.first()
        assertEquals(PlaceDemand(demandId, "waiting", null, null, withdrawn = true), waiting.demand)
        val bound = parseAtlasResponse(atlasJson(places = withDemand(demand("bound", scroll = """{"assetId":"$scrollId","title":"Two bulges of water"}""")))).places.first()
        assertEquals(BoundScroll(scrollId, "Two bulges of water"), bound.demand?.scroll)
        val cannot = parseAtlasResponse(atlasJson(places = withDemand(demand("cannot_meet", reason = "no_budget")))).places.first()
        assertEquals("no_budget", cannot.demand?.reason)
    }

    @Test
    fun refusesANeedTheContractForbids() {
        val scroll = """{"assetId":"$scrollId","title":"Two bulges of water"}"""
        for (bad in listOf(
            demand("bound"),
            demand("waiting", scroll = scroll),
            demand("cannot_meet"),
            demand("cannot_meet", reason = "felt_like_it"),
            demand("waiting", reason = "no_budget"),
            demand("open"),
            demand("bound", scroll = """{"assetId":"$scrollId","title":""}"""),
            demand("bound", scroll = """{"assetId":"$scrollId","title":"Two bulges of water","sourceTitle":"NOAA · Tides"}"""),
            demand("waiting").replace("}", ",\"sourceUrl\":\"https://oceanservice.noaa.gov/\"}"),
        )) assertThrows(bad, IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = withDemand(bad))) }
    }

    @Test
    fun refusesAPlaceThatDoesNotSayWhetherItHasANeedForMore() {
        val silent = defaultPlaces().replace(",\"demand\":null}", "}")
        assertNotEquals(defaultPlaces(), silent)
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = silent)) }
    }

    @Test
    fun evidenceSummaryForAFoundationSaysOnlyWhatItsDeltaRecords() {
        fun delta(kind: String, causalClass: String, evidence: String) = parseAtlasDelta(JSONObject(
            """{"deltaId":"$deltaId","placeId":"$gravityId","kind":"$kind","causalClass":"$causalClass",
                "policyVersion":"cartographer-v2","at":"2026-09-24T00:00:00.000Z",
                "anchor":{"code":"physics.gravity","name":"Gravity"},"before":{"loadBearing":false},
                "after":{"loadBearing":true},"evidence":$evidence}""",
        ))
        val relations = """[{"from":"physics.gravity","to":"earth.tides","kind":"explains"},{"from":"physics.gravity","to":"astro.orbit","kind":"explains"},{"from":"physics.gravity","to":"astro.star.birth","kind":"explains"}]"""
        assertEquals(
            "Recognised from 3 connections to 3 of your places.",
            evidenceSummary(delta("foundation_recognised", "substrate_neighbourhood", """{"relations":$relations,"holdsUp":["earth.tides","astro.orbit","astro.star.birth"]}""")),
        )
        assertEquals(
            "After you set a place aside, it no longer has enough connections to your places.",
            evidenceSummary(delta("foundation_withdrawn", "reader_correction", """{"relations":$relations}""")),
        )
        assertEquals(
            "What one of its connections was based on changed.",
            evidenceSummary(delta("foundation_withdrawn", "source_correction", """{"relations":$relations}""")),
        )
        // The foundation itself was set aside: it did not lose its connections (verification review).
        assertEquals(
            "You set this place aside, so it no longer holds anything up.",
            evidenceSummary(delta("foundation_withdrawn", "reader_correction", """{"relations":$relations,"setAside":true}""")),
        )
    }

    /** Review I1: a standing foundation whose connections change is re-recorded (before and after
     * both load-bearing), and the evidence says why it changed, not that it was newly recognised. */
    @Test
    fun evidenceSummaryForARerecordedFoundationSaysWhatChanged() {
        fun revised(causalClass: String) = parseAtlasDelta(JSONObject(
            """{"deltaId":"$deltaId","placeId":"$gravityId","kind":"foundation_recognised","causalClass":"$causalClass",
                "policyVersion":"cartographer-v2","at":"2026-09-24T00:00:00.000Z",
                "anchor":{"code":"physics.gravity","name":"Gravity"},"before":{"loadBearing":true},
                "after":{"loadBearing":true},"evidence":{"relations":[{},{},{}],"holdsUp":["a","b"]}}""",
        ))
        assertEquals("After you set a place aside, it still stands on 3 connections to 2 of your places.", evidenceSummary(revised("reader_correction")))
        assertEquals("What it was based on changed; it now stands on 3 connections to 2 of your places.", evidenceSummary(revised("source_correction")))
        assertEquals("It now holds up 2 of your places, through 3 connections.", evidenceSummary(revised("substrate_neighbourhood")))
    }

    @Test
    fun refusesAnUnknownKind() {
        val bad = defaultPlaces().replace("\"kind\":\"planet\"", "\"kind\":\"moon\"")
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = bad)) }
    }

    @Test
    fun refusesAnUnknownRelationKindOnASightingsBasis() {
        val bad = defaultPlaces().replace("\"kind\":\"explains\"", "\"kind\":\"because_i_said_so\"")
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = bad)) }
    }

    @Test
    fun refusesASightingThatCarriesAttention() {
        val dishonest = defaultPlaces().replace(
            "\"attention\":null,\"scrolls\":{\"total\":0,\"seen\":0}",
            "\"attention\":{\"state\":\"seen\",\"episodes\":1,\"daysActive\":1,\"sourceFamilies\":1},\"scrolls\":{\"total\":0,\"seen\":0}",
        )
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(places = dishonest)) }
    }

    @Test
    fun refusesAChronicleOverTheTwentyLineCap() {
        val lines = (1..21).joinToString(",") {
            """{"deltaId":"$deltaId","placeId":"$gravityId","kind":"place_formed","causalClass":"personal_exploration","at":"2026-09-23T00:00:00.000Z","line":"line $it"}"""
        }
        assertThrows(IllegalArgumentException::class.java) { parseAtlasResponse(atlasJson(chronicle = "[$lines]")) }
    }

    @Test
    fun refusesAMissingRequiredField() {
        val missing = JSONObject(atlasJson().toString()).apply { remove("policyVersion") }
        assertThrows(JSONException::class.java) { parseAtlasResponse(missing) }
    }

    @Test
    fun aDeltasEvidenceAndBeforeAfterAreStructurallyComparableMaps() {
        val delta = JSONObject(
            """{"deltaId":"$deltaId","placeId":"$gravityId","kind":"place_formed","causalClass":"personal_exploration",
                "policyVersion":"cartographer-v1","at":"2026-09-23T00:00:00.000Z",
                "anchor":{"code":"physics.gravity","name":"Gravity"},"before":null,
                "after":{"kind":"planet","state":"live","parentPlaceId":null},
                "evidence":{"account":{"episodes":3,"daysActive":2,"sourceFamilies":2,"episodeIds":["e1","e2"],"markIds":["m1"]}}}""",
        )
        val parsed = parseAtlasDelta(delta)
        assertNull(parsed.before)
        assertEquals(mapOf("kind" to "planet", "state" to "live", "parentPlaceId" to null), parsed.after)
        // #161: the account's source families are parsed but never said.
        assertEquals("Formed from 3 readings across 2 days.", evidenceSummary(parsed))
        // Structural, not identity, equality -- two independent parses of the same JSON match.
        assertEquals(parseAtlasDelta(JSONObject(delta.toString())), parsed)
    }

    /** Review 2: a sighting retired by the reader's own exploration is honestly described as met
     * ("evidence.met" -- `packages/core/src/atlas/cartographer.ts`), never as a dead connection. */
    @Test
    fun evidenceSummaryHonestlyDescribesASightingTheReaderCameAcross() {
        val delta = JSONObject(
            """{"deltaId":"$deltaId","placeId":"$sightingId","kind":"sighting_retired","causalClass":"personal_exploration",
                "policyVersion":"cartographer-v1","at":"2026-09-24T00:00:00.000Z",
                "anchor":{"code":"astro.star-formation","name":"Star formation"},"before":null,
                "after":{"kind":"sighting","state":"retired","parentPlaceId":"$gravityId"},
                "evidence":{"met":{"state":"seen","episodes":2}}}""",
        )
        val summary = evidenceSummary(parseAtlasDelta(delta))
        assertEquals("You came across it (2 readings), so it is no longer on the horizon.", summary)
        assertFalse("never claims the connection itself is inactive", summary.contains("no longer active"))
    }

    @Test
    fun setAsideConflictMatchesPausedExplicitlyAndLeavesAnyOtherReasonGeneric() {
        assertEquals(SetAsideConflict.StaleEpoch, setAsideConflict(ApiException.Server(409, """{"error":"Privacy epoch changed"}""")))
        assertEquals(SetAsideConflict.Paused, setAsideConflict(ApiException.Server(409, """{"error":"Recording is paused"}""")))
        // Review M6: a 409 for neither known reason (e.g. a sighting refused set-aside) is not
        // assumed to mean paused -- the caller maps it to a generic message instead.
        assertNull(setAsideConflict(ApiException.Server(409, """{"error":"Only a live planet or region can be set aside"}""")))
        // #163: a room no longer live is refused the same way.
        assertNull(setAsideConflict(ApiException.Server(409, """{"error":"Only a live room can be set aside"}""")))
        assertNull(setAsideConflict(ApiException.Server(404, "{}")))
    }

    @Test
    fun theAtlasDeltaAndRejectTravelTheWireExactly() = runBlocking {
        ServerSocket(0).use { server ->
            val requests = java.util.Collections.synchronizedList(mutableListOf<Pair<String, String>>())
            val evidenceBody = """{"deltaId":"$deltaId","placeId":"$gravityId","kind":"place_formed","causalClass":"personal_exploration",
                "policyVersion":"cartographer-v1","at":"2026-09-23T00:00:00.000Z",
                "anchor":{"code":"physics.gravity","name":"Gravity"},"before":null,
                "after":{"kind":"planet","state":"live","parentPlaceId":null},"evidence":{}}"""
            val replies = listOf(
                200 to atlasJson().toString(),
                200 to evidenceBody,
                200 to atlasJson(places = "[]", chronicle = "[]").toString(),
            )
            val worker = thread {
                replies.forEach { (status, body) ->
                    server.accept().use { socket ->
                        val input = socket.getInputStream().bufferedReader()
                        val requestLine = input.readLine()
                        var length = 0
                        while (true) {
                            val line = input.readLine()
                            if (line.isNullOrEmpty()) break
                            if (line.startsWith("Content-Length:", true)) length = line.substringAfter(":").trim().toInt()
                        }
                        requests += requestLine to input.readBody(length)
                        socket.getOutputStream().write(("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body").toByteArray())
                    }
                }
            }
            val api = ApiClient("http://127.0.0.1:${server.localPort}", "fixture-token", maxAttempts = 1)
            assertEquals(2, api.getAtlas().places.size)
            assertEquals("place_formed", api.getAtlasDelta(deltaId).kind)
            val afterReject = api.rejectPlace(gravityId, 4L)
            assertTrue(afterReject.places.isEmpty())
            assertTrue(requests[0].first.startsWith("GET /v1/atlas "))
            assertTrue(requests[1].first.startsWith("GET /v1/atlas/deltas/$deltaId "))
            assertTrue(requests[2].first.startsWith("POST /v1/atlas/places/$gravityId/reject "))
            assertEquals(setOf("expectedPrivacyEpoch"), JSONObject(requests[2].second).keys().asSequence().toSet())
            assertEquals(4L, JSONObject(requests[2].second).getLong("expectedPrivacyEpoch"))
            worker.join(2_000)
        }
    }

    @Test
    fun aMalformedAtlasResponseIsAProtocolErrorNeverShown() = runBlocking {
        ServerSocket(0).use { server ->
            val worker = thread {
                server.accept().use { socket ->
                    val input = socket.getInputStream().bufferedReader()
                    while (!input.readLine().isNullOrEmpty()) {}
                    val body = """{"policyVersion":"cartographer-v1","places":[{"placeId":"$gravityId","kind":"moon"}],"relations":[],"chronicle":[]}"""
                    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body").toByteArray())
                }
            }
            val api = ApiClient("http://127.0.0.1:${server.localPort}", "fixture-token", maxAttempts = 1)
            assertTrue(runCatching { api.getAtlas() }.exceptionOrNull() is ApiException.Protocol)
            worker.join(2_000)
        }
    }
}
