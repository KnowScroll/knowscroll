package com.knowscroll.mobile.data

import com.knowscroll.mobile.ui.system.RejectPlaceConflict
import com.knowscroll.mobile.ui.system.basisSentence
import com.knowscroll.mobile.ui.system.evidenceSummary
import com.knowscroll.mobile.ui.system.rejectPlaceConflict
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
         "scrolls":{"total":3,"seen":3},"formedAt":"2026-09-23T00:00:00.000Z","formedBy":"place_formed"},
        {"placeId":"$sightingId","kind":"sighting","parentPlaceId":"$gravityId",
         "anchor":{"code":"astro.star-formation","name":"Star formation","description":"How stars are born."},
         "basis":{"kind":"explains","from":"Gravity","to":"Star formation",
             "claim":{"text":"Gravity pulls gas clouds together until they ignite.","sourceTitle":"NASA · Star formation"},"bridge":null},
         "attention":null,"scrolls":{"total":0,"seen":0},"formedAt":"2026-09-24T00:00:00.000Z","formedBy":"sighting_appeared"}
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
        assertEquals("Formed from 3 readings across 2 days and 2 source families.", evidenceSummary(parsed))
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
    fun rejectPlaceConflictMatchesPausedExplicitlyAndLeavesAnyOtherReasonGeneric() {
        assertEquals(RejectPlaceConflict.StaleEpoch, rejectPlaceConflict(ApiException.Server(409, """{"error":"Privacy epoch changed"}""")))
        assertEquals(RejectPlaceConflict.Paused, rejectPlaceConflict(ApiException.Server(409, """{"error":"Recording is paused"}""")))
        // Review M6: a 409 for neither known reason (e.g. a sighting refused set-aside) is not
        // assumed to mean paused -- the caller maps it to a generic message instead.
        assertNull(rejectPlaceConflict(ApiException.Server(409, """{"error":"Only a live planet or region can be set aside"}""")))
        assertNull(rejectPlaceConflict(ApiException.Server(404, "{}")))
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
                        requests += requestLine to String(CharArray(length).also { input.read(it, 0, length) })
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
