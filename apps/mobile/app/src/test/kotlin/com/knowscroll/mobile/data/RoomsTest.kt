package com.knowscroll.mobile.data

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #163 (ADR-0045) — Idea Rooms are read back exactly as `packages/contracts/src/rooms.ts` describes
 * them: a place's live rooms on the atlas, and one room with its chronicle and evidence. The contract
 * is `.strict()`: an unknown role, state or kind, an unexpected key (a source above all), a missing
 * field, or a ladder that does not follow the doubter is refused, never shown -- mirrors [AwayTest].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoomsTest {
    private val roomId = "11111111-1111-4111-8111-111111111111"
    private val placeId = "22222222-2222-4222-8222-222222222222"
    private val deltaId = "33333333-3333-4333-8333-333333333333"
    private val askId = "44444444-4444-4444-8444-444444444444"

    private fun claim(key: String = "clm.gravity.definition", supportKind: String = "supports") = JSONObject().apply {
        put("key", key); put("statement", "Gravity is the force by which a planet draws objects toward its center.")
        put("truthState", "documented"); put("supportKind", supportKind)
    }
    private fun seat(role: String, vararg claims: JSONObject) = JSONObject().put("role", role).put("claims", JSONArray(claims.toList()))
    private fun summary(state: String = "arguing", seats: List<JSONObject> = listOf(seat("reader_of_record", claim()), seat("doubter", claim("clm.journey.gravity_curvature", "qualifies")))) =
        JSONObject().apply {
            put("roomId", roomId); put("question", "So what is gravity, really?"); put("state", state)
            put("inhabitants", JSONArray(seats)); put("openedAt", "2026-09-25T10:00:00.000Z")
        }
    private fun evidence(asks: JSONArray = JSONArray(), claims: JSONArray = JSONArray(), previous: JSONArray = JSONArray()) =
        JSONObject().put("asks", asks).put("claims", claims).put("previous", previous)
    private fun entry(kind: String = "room_opened", role: Any = JSONObject.NULL, evidence: JSONObject = evidence(JSONArray().put(JSONObject().put("askId", askId).put("day", "2026-09-24")))) =
        JSONObject().apply {
            put("deltaId", deltaId); put("kind", kind); put("causalClass", "personal_exploration"); put("role", role)
            put("at", "2026-09-25T10:00:00.000Z"); put("line", "A question you keep asking opened a room on Gravity."); put("evidence", evidence)
        }
    private fun room(state: String = "arguing", chronicle: JSONArray = JSONArray().put(entry())) = summary(state).apply {
        put("placeId", placeId); put("placeName", "Gravity"); put("chronicle", chronicle)
    }

    private fun refused(what: String, parse: () -> Unit) {
        try { parse(); fail("accepted $what") } catch (e: IllegalArgumentException) { /* refused */ }
    }

    @Test
    fun readsALiveRoomWithItsInhabitantsInTheirOwnWords() {
        val room = parseAtlasRoom(summary())
        assertEquals("So what is gravity, really?", room.question)
        assertEquals("arguing", room.state)
        assertEquals(listOf("reader_of_record", "doubter"), room.inhabitants.map { it.role })
        assertEquals(RoomClaim("clm.journey.gravity_curvature", "Gravity is the force by which a planet draws objects toward its center.", "documented", "qualifies"),
            room.inhabitants[1].claims.single())
    }

    @Test
    fun readsARoomWithItsChronicleAndEachLinesEvidence() {
        val seated = entry("inhabitant_seated", "doubter", evidence(claims = JSONArray().put(claim("clm.journey.gravity_curvature", "qualifies"))))
        val room = parseRoomResponse(room(chronicle = JSONArray().put(seated).put(entry())))
        assertEquals("Gravity", room.placeName)
        assertEquals(listOf("inhabitant_seated", "room_opened"), room.chronicle.map { it.kind })
        assertEquals("doubter", room.chronicle[0].role)
        assertEquals(listOf("clm.journey.gravity_curvature"), room.chronicle[0].evidence.claims.map { it.key })
        assertEquals(listOf(RoomAskEvidence(askId, "2026-09-24")), room.chronicle[1].evidence.asks)
        // A set-aside room seats no one.
        assertTrue(parseRoomResponse(room("set_aside").put("inhabitants", JSONArray())).inhabitants.isEmpty())
    }

    @Test
    fun refusesASourceOrAnyKeyTheContractDoesNotDescribe() {
        refused("a source title") { parseAtlasRoom(summary(seats = listOf(seat("reader_of_record", claim().put("sourceTitle", "NASA · What is gravity?"))))) }
        refused("a source url on a room") { parseAtlasRoom(summary().put("sourceUrl", "https://example.test")) }
        refused("an unknown key in evidence") { parseRoomResponse(room(chronicle = JSONArray().put(entry(evidence = evidence().put("source", "x"))))) }
        refused("a missing question") { parseAtlasRoom(summary().apply { remove("question") }) }
    }

    @Test
    fun refusesUnknownRolesStatesKindsAndSupport() {
        refused("an unknown role") { parseAtlasRoom(summary(seats = listOf(seat("visitor", claim())))) }
        refused("a room that is not live on the atlas") { parseAtlasRoom(summary("set_aside", emptyList())) }
        refused("an unknown support kind") { parseAtlasRoom(summary(seats = listOf(seat("reader_of_record", claim(supportKind = "rumoured"))))) }
        refused("an unknown delta kind") { parseRoomResponse(room(chronicle = JSONArray().put(entry("room_moved")))) }
        refused("an empty chronicle") { parseRoomResponse(room(chronicle = JSONArray())) }
        refused("a seat with no claims") { parseAtlasRoom(summary("opened", listOf(seat("reader_of_record")))) }
        refused("five claims") { parseAtlasRoom(summary("opened", listOf(seat("reader_of_record", claim(), claim(), claim(), claim(), claim())))) }
        refused("two seats for one role") { parseAtlasRoom(summary("opened", listOf(seat("reader_of_record", claim()), seat("reader_of_record", claim())))) }
    }

    @Test
    fun theLadderFollowsTheDoubter() {
        refused("arguing without a doubter") { parseAtlasRoom(summary("arguing", listOf(seat("reader_of_record", claim())))) }
        refused("open with a doubter seated") { parseAtlasRoom(summary("opened")) }
        refused("a set-aside room still seating someone") { parseRoomResponse(room("set_aside")) }
    }

    @Test
    fun aRoomAndItsSettingAsideTravelTheWireExactly() = runBlocking {
        val emptyAtlas = JSONObject().put("policyVersion", "cartographer-v2").put("places", JSONArray()).put("relations", JSONArray()).put("chronicle", JSONArray())
        TestHttpServer.open().use { server ->
            server.serve(200 to room().toString(), 200 to emptyAtlas.toString())
            val api = ApiClient(server.baseUrl, "fixture-token", maxAttempts = 1)
            assertEquals("Gravity", api.getRoom(roomId).placeName)
            val clientRequestId = "55555555-5555-4555-8555-555555555555"
            assertTrue(api.setRoomAside(roomId, clientRequestId, 4L).places.isEmpty())
            server.join()
            val (read, setAside) = server.snapshot()
            assertTrue(read.requestLine.startsWith("GET /v1/rooms/$roomId "))
            assertTrue(setAside.requestLine.startsWith("POST /v1/rooms/$roomId/set-aside "))
            val body = JSONObject(setAside.body)
            assertEquals(setOf("clientRequestId", "expectedPrivacyEpoch"), body.keys().asSequence().toSet())
            assertEquals(listOf(clientRequestId, "4"), listOf(body.getString("clientRequestId"), body.get("expectedPrivacyEpoch").toString()))
        }
        // A room answered for another room, or a shape the contract does not describe, is never shown.
        TestHttpServer.open().use { server ->
            server.serve(200 to room().put("roomId", askId).toString())
            val error = runCatching { ApiClient(server.baseUrl, "fixture-token", maxAttempts = 1).getRoom(roomId) }.exceptionOrNull()
            assertTrue("$error", error is ApiException.Protocol)
        }
    }

    @Test
    fun anAtlasPlaceCarriesItsRoomsAndASightingNone() {
        fun place(kind: String, rooms: JSONArray) = JSONObject().apply {
            put("placeId", placeId); put("kind", kind); put("parentPlaceId", if (kind == "sighting") roomId else JSONObject.NULL)
            put("anchor", JSONObject().put("code", "physics.gravity").put("name", "Gravity").put("description", "The force that pulls masses together."))
            put("basis", if (kind == "sighting") JSONObject().put("kind", "explains").put("from", "Gravity").put("to", "Tides").put("claim", JSONObject.NULL).put("bridge", JSONObject().put("mechanism", "m")) else JSONObject.NULL)
            put("attention", JSONObject.NULL); put("scrolls", JSONObject().put("total", 1).put("seen", 1))
            put("formedAt", "2026-09-23T00:00:00.000Z"); put("formedBy", "place_formed"); put("foundation", JSONObject.NULL); put("rooms", rooms); put("demand", JSONObject.NULL)
        }
        assertEquals(listOf(roomId), parseAtlasPlace(place("planet", JSONArray().put(summary()))).rooms.map { it.roomId })
        refused("a room on a sighting") { parseAtlasPlace(place("sighting", JSONArray().put(summary()))) }
        refused("a place that does not say") { parseAtlasPlace(place("planet", JSONArray()).apply { remove("rooms") }) }
        refused("four live rooms on one place") { parseAtlasPlace(place("planet", JSONArray(List(4) { summary() }))) }
    }
}
