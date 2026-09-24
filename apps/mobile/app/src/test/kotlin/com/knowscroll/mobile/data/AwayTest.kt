package com.knowscroll.mobile.data

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #134 (ADR-0039) — the return is read back exactly as `packages/contracts/src/away.ts` describes
 * it. The contract is `.strict()`: an unknown kind, change, cause or correction status, an
 * unexpected key, a missing field, or a list its own refinements forbid (not newest first, an item
 * at or before the marker, `more` without a full list) is refused, never shown -- mirrors
 * [InquiriesTest].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AwayTest {
    private val inquiryId = "11111111-1111-4111-8111-111111111111"
    private val bridgeId = "22222222-2222-4222-8222-222222222222"
    private val deltaId = "33333333-3333-4333-8333-333333333333"
    private val placeId = "44444444-4444-4444-8444-444444444444"

    private fun concept(code: String, name: String) = JSONObject().put("code", code).put("name", name)
    private fun pair() = JSONObject().put("a", concept("astro.sun", "The Sun")).put("b", concept("physics.gravity", "Gravity"))

    private fun found(bridgeStatus: String = "admitted") = JSONObject().apply {
        put("bridgeId", bridgeId); put("bridgeStatus", bridgeStatus); put("relationType", "compares_mechanism")
        put("fromConcept", concept("astro.sun", "The Sun")); put("toConcept", concept("physics.gravity", "Gravity"))
        put("sentence", "The Sun keeps every planet on a closed path because its gravity bends each one toward it.")
        put("evidence", JSONArray().put(JSONObject().apply {
            put("claimKey", "clm.gravity.sun_holds_earth"); put("statement", "The Sun's gravity holds Earth in its orbit.")
            put("supports", "mechanism"); put("sourceTitle", "NASA · Our Sun: Facts"); put("sourceUrl", "https://science.nasa.gov/sun/facts/")
        }))
    }

    private fun connectionFound(at: String = "2026-09-24T10:05:00.000Z") =
        JSONObject().put("kind", "connection_found").put("at", at).put("inquiryId", inquiryId).put("found", found())

    private fun didNotHoldUp(at: String = "2026-09-24T10:04:00.000Z", reasons: List<String> = listOf("from_side_unsupported")) =
        JSONObject().put("kind", "connection_did_not_hold_up").put("at", at).put("inquiryId", inquiryId)
            .put("pairs", JSONArray().put(pair())).put("reasons", JSONArray(reasons))

    private fun nothingFound(at: String = "2026-09-24T10:03:00.000Z", pairs: JSONArray = JSONArray().put(pair())) =
        JSONObject().put("kind", "nothing_found").put("at", at).put("inquiryId", inquiryId).put("pairs", pairs)

    private fun placeChanged(at: String = "2026-09-24T10:02:00.000Z") = JSONObject().apply {
        put("kind", "place_changed"); put("at", at); put("deltaId", deltaId); put("placeId", placeId)
        put("change", "foundation_withdrawn"); put("cause", "source_correction")
        put("line", "Gravity no longer holds up Tides: a source was corrected.")
    }

    private fun corrected(at: String = "2026-09-24T10:01:00.000Z", status: String = "revoked") = JSONObject().apply {
        put("kind", "connection_corrected"); put("at", at); put("bridgeId", bridgeId); put("status", status)
        put("fromConcept", concept("astro.sun", "The Sun")); put("toConcept", concept("physics.gravity", "Gravity"))
    }

    private fun response(vararg items: JSONObject, epoch: Long = 4, since: String? = null, more: Long = 0, paused: Boolean = false) = JSONObject().apply {
        put("privacyEpoch", epoch); put("since", since ?: JSONObject.NULL); put("items", JSONArray(items.toList()))
        put("more", more); put("recordingPaused", paused)
    }

    private fun refused(value: JSONObject) {
        try {
            parseAwayResponse(value)
            fail("expected the away list to be refused: $value")
        } catch (_: IllegalArgumentException) {
        } catch (_: org.json.JSONException) {
        }
    }

    /** Ten items a minute apart, newest first. */
    private fun fullList(): Array<JSONObject> = Array(10) { i -> nothingFound(at = "2026-09-24T10:%02d:00.000Z".format(59 - i)) }

    @Test
    fun parsesEveryKindExactlyAsTheContractDescribes() {
        val parsed = parseAwayResponse(response(connectionFound(), didNotHoldUp(), nothingFound(), placeChanged(), corrected(), since = "2026-09-24T09:00:00.000Z"))
        assertEquals(4L, parsed.privacyEpoch)
        assertEquals("2026-09-24T09:00:00.000Z", parsed.since)
        assertEquals(0L, parsed.more)
        assertFalse(parsed.recordingPaused)
        val found = parsed.items[0] as AwayItem.ConnectionFound
        assertEquals(inquiryId, found.inquiryId)
        assertEquals(bridgeId, found.found.bridgeId)
        assertEquals("NASA · Our Sun: Facts", found.found.evidence.single().sourceTitle)
        val refused = parsed.items[1] as AwayItem.ConnectionDidNotHoldUp
        assertEquals(listOf("from_side_unsupported"), refused.reasons)
        assertEquals("The Sun", refused.pairs.single().a.name)
        assertEquals("Gravity", (parsed.items[2] as AwayItem.NothingFound).pairs.single().b.name)
        val change = parsed.items[3] as AwayItem.PlaceChanged
        assertEquals("foundation_withdrawn", change.change)
        assertEquals("source_correction", change.cause)
        assertEquals("Gravity no longer holds up Tides: a source was corrected.", change.line)
        assertEquals(placeId, change.placeId)
        val correction = parsed.items[4] as AwayItem.ConnectionCorrected
        assertEquals("revoked", correction.status)
        assertEquals("The Sun", correction.fromConcept.name)
    }

    @Test
    fun anEmptyListWithNoMarkerAndPausedRecordingIsCarried() {
        val parsed = parseAwayResponse(response(paused = true))
        assertNull(parsed.since)
        assertTrue(parsed.items.isEmpty())
        assertTrue(parsed.recordingPaused)
    }

    @Test
    fun aFullListMayCountMore() {
        val parsed = parseAwayResponse(response(*fullList(), more = 7))
        assertEquals(10, parsed.items.size)
        assertEquals(7L, parsed.more)
    }

    @Test
    fun theContractsOwnRefinementsAreEnforced() {
        // Newest first.
        refused(response(nothingFound(at = "2026-09-24T10:00:00.000Z"), nothingFound(at = "2026-09-24T10:01:00.000Z")))
        // Every item after the marker -- never at it.
        refused(response(nothingFound(at = "2026-09-24T10:00:00.000Z"), since = "2026-09-24T10:00:00.000Z"))
        refused(response(nothingFound(at = "2026-09-24T09:59:00.000Z"), since = "2026-09-24T10:00:00.000Z"))
        // `more` only with a full list.
        refused(response(nothingFound(), more = 1))
        refused(response(*fullList().take(9).toTypedArray(), more = 3))
        // Items at the same time are allowed (newest first is not strict).
        assertEquals(2, parseAwayResponse(response(nothingFound(at = "2026-09-24T10:00:00.000Z"), corrected(at = "2026-09-24T10:00:00.000Z"))).items.size)
    }

    @Test
    fun closedEnumsAreRefusedWhenUnknown() {
        refused(response(JSONObject().put("kind", "rumour").put("at", "2026-09-24T10:00:00.000Z")))
        refused(response(placeChanged().put("change", "place_renamed")))
        refused(response(placeChanged().put("cause", "personal_exploration")))
        refused(response(placeChanged().put("cause", "reader_correction")))
        refused(response(corrected(status = "admitted")))
        refused(response(JSONObject(connectionFound().toString()).put("found", found().put("bridgeStatus", "maybe"))))
    }

    @Test
    fun aMissingOrUnexpectedKeyIsRefusedBecauseTheContractIsStrict() {
        refused(response(connectionFound().put("line", "provider prose")))
        refused(response(placeChanged().put("text", "model text")))
        refused(response(corrected().apply { remove("toConcept") }))
        refused(response(didNotHoldUp().apply { remove("reasons") }))
        refused(response().put("extra", 1))
        refused(response().apply { remove("recordingPaused") })
        refused(response().apply { remove("since") })
        refused(response(connectionFound().apply { remove("kind") }))
    }

    @Test
    fun boundsAndFormatsAreEnforced() {
        refused(response(epoch = -1))
        refused(response(more = -1))
        refused(response(*fullList(), nothingFound(at = "2026-09-24T09:00:00.000Z")))
        refused(response(didNotHoldUp(reasons = emptyList())))
        refused(response(didNotHoldUp(reasons = listOf("Not A Code"))))
        refused(response(didNotHoldUp(reasons = List(25) { "reason_$it" })))
        refused(response(nothingFound(pairs = JSONArray())))
        refused(response(nothingFound(pairs = JSONArray(List(4) { pair() }))))
        refused(response(placeChanged().put("line", "")))
        refused(response(placeChanged().put("line", "x".repeat(601))))
        // The server shortens a longer chronicle line to fit (review I1): 600 is accepted.
        assertEquals(600, (parseAwayResponse(response(placeChanged().put("line", "x".repeat(600)))).items.single() as AwayItem.PlaceChanged).line.length)
        refused(response(placeChanged().put("deltaId", "not-a-uuid")))
        refused(response(connectionFound(at = "yesterday")))
        refused(response(since = "2026-09-24 10:00"))
        refused(response().put("recordingPaused", "false"))
        refused(response().put("more", "0"))
    }

    @Test
    fun theAcknowledgementReceiptIsParsedStrictlyToo() {
        val receipt = parseAwayAcknowledgeResponse(JSONObject().put("privacyEpoch", 4).put("since", "2026-09-24T10:05:00.000Z"))
        assertEquals(4L, receipt.privacyEpoch)
        assertEquals("2026-09-24T10:05:00.000Z", receipt.since)
        for (bad in listOf(
            JSONObject().put("privacyEpoch", 4).put("since", JSONObject.NULL),
            JSONObject().put("privacyEpoch", 4).put("since", "2026-09-24T10:05:00.000Z").put("items", JSONArray()),
        )) {
            try {
                parseAwayAcknowledgeResponse(bad)
                fail("expected the receipt to be refused: $bad")
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    // ---- Over the wire (ApiClient) ----

    private fun api(server: TestHttpServer, attempts: Int = 1) =
        ApiClient(server.baseUrl, "", maxAttempts = attempts, credential = CredentialProvider { "session-1" }, onUnauthorized = {})

    @Test
    fun getAwayReadsTheListWithTheAppsCredential() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to response(connectionFound()).toString())
            val parsed = api(server).getAway()
            server.join()
            assertTrue(server.requests.single().requestLine.startsWith("GET /v1/away "))
            assertEquals(bridgeId, (parsed.items.single() as AwayItem.ConnectionFound).found.bridgeId)
        }
    }

    @Test
    fun aMalformedListIsAProtocolErrorNeverShown() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to response(nothingFound(at = "2026-09-24T10:00:00.000Z"), nothingFound(at = "2026-09-24T10:01:00.000Z")).toString())
            val error = runCatching { api(server).getAway() }.exceptionOrNull()
            assertTrue("$error", error is ApiException.Protocol)
        }
    }

    @Test
    fun acknowledgeSendsExactlyTheContractsBodyAndChecksTheReceipt() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to """{"privacyEpoch":4,"since":"2026-09-24T10:05:00.000Z"}""")
            val receipt = api(server).acknowledgeAway(AwayAcknowledgeRequest("55555555-5555-4555-8555-555555555555", 4, "2026-09-24T10:05:00.000Z"))
            server.join()
            val request = server.requests.single()
            assertTrue(request.requestLine.startsWith("POST /v1/away/acknowledge "))
            val body = JSONObject(request.body)
            assertEquals(setOf("clientRequestId", "expectedPrivacyEpoch", "through"), body.keys().asSequence().toSet())
            assertEquals("55555555-5555-4555-8555-555555555555", body.getString("clientRequestId"))
            assertEquals(4L, body.getLong("expectedPrivacyEpoch"))
            assertEquals("2026-09-24T10:05:00.000Z", body.getString("through"))
            assertEquals("2026-09-24T10:05:00.000Z", receipt.since)
        }
    }

    @Test
    fun aReceiptForAnotherEpochOrAMarkerBeforeWhatWasSeenIsAProtocolError() = runBlocking {
        for (reply in listOf(
            """{"privacyEpoch":5,"since":"2026-09-24T10:05:00.000Z"}""",
            """{"privacyEpoch":4,"since":"2026-09-24T10:04:59.999Z"}""",
        )) {
            TestHttpServer.open().use { server ->
                server.serve(200 to reply)
                val error = runCatching {
                    api(server).acknowledgeAway(AwayAcknowledgeRequest("55555555-5555-4555-8555-555555555555", 4, "2026-09-24T10:05:00.000Z"))
                }.exceptionOrNull()
                assertTrue("$reply: $error", error is ApiException.Protocol)
            }
        }
    }

    @Test
    fun aMarkerAlreadyPastWhatWasSeenIsAcceptedBecauseMarkersOnlyMoveForward() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to """{"privacyEpoch":4,"since":"2026-09-24T11:00:00.000Z"}""")
            val receipt = api(server).acknowledgeAway(AwayAcknowledgeRequest("55555555-5555-4555-8555-555555555555", 4, "2026-09-24T10:05:00.000Z"))
            assertEquals("2026-09-24T11:00:00.000Z", receipt.since)
        }
    }

    @Test
    fun aConflictIsDefinitiveAndNeverReSentByTheClient() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(409 to """{"error":"Recording is paused"}""")
            val error = runCatching {
                api(server, attempts = 2).acknowledgeAway(AwayAcknowledgeRequest("55555555-5555-4555-8555-555555555555", 4, "2026-09-24T10:05:00.000Z"))
            }.exceptionOrNull()
            assertTrue("$error", error is ApiException.Server && error.statusCode == 409 && !error.mayHaveLanded)
            assertEquals(1, server.requests.size)
        }
    }
}
