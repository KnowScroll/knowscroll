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
 * #132 (ADR-0038) — background bridge inquiries are read back exactly as
 * `packages/contracts/src/inquiries.ts` describes them. The contract is `.strict()` on both sides:
 * an unknown status, kind or key, a missing required field, or a combination the contract's own
 * refinements forbid is refused, never shown -- mirrors [AtlasTest].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InquiriesTest {
    private val inquiryId = "11111111-1111-4111-8111-111111111111"
    private val bridgeId = "22222222-2222-4222-8222-222222222222"

    private fun consentJson(
        enabled: Boolean = true, dailyLimit: Int = 3, changedAt: String? = "2026-09-24T10:00:00.000Z",
        available: Boolean = true, usedToday: Int = 0,
    ) = JSONObject().apply {
        put("enabled", enabled); put("dailyLimit", dailyLimit); put("changedAt", changedAt ?: JSONObject.NULL)
        put("available", available); put("usedToday", usedToday)
    }

    private fun pair(a: String = "astro.sun", aName: String = "The Sun", b: String = "physics.gravity", bName: String = "Gravity") =
        JSONObject().put("a", JSONObject().put("code", a).put("name", aName)).put("b", JSONObject().put("code", b).put("name", bName))

    private fun found() = JSONObject().apply {
        put("bridgeId", bridgeId); put("bridgeStatus", "admitted"); put("relationType", "compares_mechanism")
        put("fromConcept", JSONObject().put("code", "astro.sun").put("name", "The Sun"))
        put("toConcept", JSONObject().put("code", "physics.gravity").put("name", "Gravity"))
        put("sentence", "The Sun keeps every planet on a closed path because its gravity bends each one toward it.")
        put("evidence", JSONArray().put(JSONObject().apply {
            put("claimKey", "clm.gravity.sun_holds_earth"); put("statement", "The Sun's gravity holds Earth in its orbit.")
            put("supports", "mechanism"); put("sourceTitle", "NASA · Our Sun: Facts"); put("sourceUrl", "https://science.nasa.gov/sun/facts/")
            put("withdrawn", false)
        }))
    }

    private fun inquiry(
        status: String = "found", reasons: List<String> = emptyList(),
        closedAt: String? = "2026-09-24T10:05:00.000Z", pairs: JSONArray = JSONArray().put(pair()),
        found: JSONObject? = if (status == "found") found() else null,
    ) = JSONObject().apply {
        put("inquiryId", inquiryId); put("status", status); put("requestedAt", "2026-09-24T10:00:00.000Z")
        put("closedAt", closedAt ?: JSONObject.NULL); put("pairs", pairs); put("reasons", JSONArray(reasons))
        put("found", found ?: JSONObject.NULL)
    }

    private fun response(vararg inquiries: JSONObject, epoch: Long = 4, consent: JSONObject = consentJson()) = JSONObject().apply {
        put("privacyEpoch", epoch); put("consent", consent); put("inquiries", JSONArray(inquiries.toList()))
    }

    private fun refused(value: JSONObject) {
        try {
            parseInquiriesResponse(value)
            fail("expected the inquiry list to be refused: $value")
        } catch (_: IllegalArgumentException) {
        } catch (_: org.json.JSONException) {
        }
    }

    @Test
    fun parsesConsentAndEveryStatusExactlyAsTheContractDescribes() {
        val parsed = parseInquiriesResponse(response(
            inquiry("waiting", closedAt = null, pairs = JSONArray()),
            inquiry("looking", closedAt = null),
            inquiry("found"),
            inquiry("nothing_found"),
            inquiry("did_not_hold_up", listOf("shape", "claim_not_offered")),
            inquiry("nothing_to_ask", listOf("no_candidate_pair"), pairs = JSONArray()),
            inquiry("failed", listOf("outcome_unknown")),
            inquiry("withdrawn", listOf("consent_off"), pairs = JSONArray()),
        ))
        assertEquals(4L, parsed.privacyEpoch)
        assertEquals(InquiryConsent(enabled = true, dailyLimit = 3, changedAt = "2026-09-24T10:00:00.000Z", available = true, usedToday = 0), parsed.consent)
        assertEquals(
            listOf("waiting", "looking", "found", "nothing_found", "did_not_hold_up", "nothing_to_ask", "failed", "withdrawn"),
            parsed.inquiries.map { it.status },
        )
        val found = parsed.inquiries[2]
        assertEquals(listOf(InquiryPair(InquiryConcept("astro.sun", "The Sun"), InquiryConcept("physics.gravity", "Gravity"))), found.pairs)
        assertEquals(bridgeId, found.found!!.bridgeId)
        assertEquals("admitted", found.found!!.bridgeStatus)
        assertEquals("NASA · Our Sun: Facts", found.found!!.evidence.single().sourceTitle)
        assertFalse(found.found!!.evidence.single().withdrawn)
        assertNull(parsed.inquiries[0].closedAt)
        assertEquals(listOf("shape", "claim_not_offered"), parsed.inquiries[4].reasons)
    }

    @Test
    fun aReaderWhoNeverSetConsentHasNoChangeTimeAndAnUnavailableRouteIsCarried() {
        val parsed = parseInquiriesResponse(response(consent = consentJson(enabled = false, changedAt = null, available = false)))
        assertFalse(parsed.consent.enabled)
        assertNull(parsed.consent.changedAt)
        assertFalse(parsed.consent.available)
        assertTrue(parsed.inquiries.isEmpty())
    }

    @Test
    fun anUnknownStatusIsRefused() = refused(response(inquiry("thinking", closedAt = null)))

    @Test
    fun anUnknownBridgeStatusRelationOrEvidenceRoleIsRefused() {
        refused(response(inquiry(found = found().put("bridgeStatus", "maybe"))))
        refused(response(inquiry(found = found().put("relationType", "contradicts"))))
        val badRole = found().apply { getJSONArray("evidence").getJSONObject(0).put("supports", "vibes") }
        refused(response(inquiry(found = badRole)))
    }

    @Test
    fun aMissingRequiredFieldIsRefused() {
        refused(response(inquiry().apply { remove("reasons") }))
        refused(response(inquiry().apply { remove("closedAt") }))
        refused(response(inquiry().apply { remove("found") }))
        refused(response().apply { remove("consent") })
        refused(response(consent = consentJson().apply { remove("available") }))
        refused(response(consent = consentJson().apply { remove("changedAt") }))
    }

    @Test
    fun anUnexpectedKeyIsRefusedBecauseTheContractIsStrict() {
        refused(response(inquiry().put("text", "provider prose")))
        refused(response(consent = consentJson().put("extra", 1)))
        refused(response().put("more", true))
        refused(response(inquiry(found = found().put("proposal", "raw"))))
    }

    @Test
    fun theContractsOwnRefinementsAreEnforced() {
        // Only a found inquiry carries a bridge, and a found one must.
        refused(response(inquiry("nothing_found", found = found())))
        refused(response(inquiry("found", found = null).put("found", JSONObject.NULL)))
        // Reasons belong to refused, failed, withdrawn and nothing-to-ask inquiries -- and they must have them.
        refused(response(inquiry("waiting", listOf("consent_off"), closedAt = null)))
        refused(response(inquiry("failed", emptyList())))
        refused(response(inquiry("did_not_hold_up", emptyList())))
        // Only an open inquiry has no close time.
        refused(response(inquiry("found", closedAt = null)))
        refused(response(inquiry("looking", closedAt = "2026-09-24T10:05:00.000Z")))
    }

    @Test
    fun boundsAndFormatsAreEnforced() {
        refused(response(consent = consentJson(dailyLimit = 11)))
        refused(response(consent = consentJson(dailyLimit = 0)))
        refused(response(consent = consentJson(usedToday = -1)))
        refused(response(consent = consentJson().put("enabled", "true")))
        refused(response(epoch = -1))
        refused(response(inquiry(pairs = JSONArray(List(4) { pair() }))))
        refused(response(inquiry("failed", listOf("Not A Code"))))
        refused(response(inquiry(pairs = JSONArray().put(pair(a = "Not.A.Code")))))
        refused(response(inquiry().put("inquiryId", "not-a-uuid")))
        refused(response(inquiry().put("requestedAt", "yesterday")))
        refused(response(inquiry(found = found().put("evidence", JSONArray()))))
        refused(response(inquiry(found = found().apply { getJSONArray("evidence").getJSONObject(0).put("sourceUrl", "not a url") })))
        // ADR-0044 M4: every claim says whether its support was withdrawn.
        refused(response(inquiry(found = found().apply { getJSONArray("evidence").getJSONObject(0).remove("withdrawn") })))
        refused(response(inquiry(found = found().apply { getJSONArray("evidence").getJSONObject(0).put("withdrawn", "no") })))
        refused(response(*Array(51) { inquiry() }))
    }

    @Test
    fun theConsentReceiptIsParsedStrictlyToo() {
        val receipt = parseInquiryConsentResponse(JSONObject().put("privacyEpoch", 2).put("consent", consentJson(dailyLimit = 5)))
        assertEquals(2L, receipt.privacyEpoch)
        assertEquals(5, receipt.consent.dailyLimit)
        try {
            parseInquiryConsentResponse(JSONObject().put("privacyEpoch", 2).put("consent", consentJson()).put("inquiries", JSONArray()))
            fail("an unexpected key must be refused")
        } catch (_: IllegalArgumentException) {
        }
    }

    // ---- Over the wire (ApiClient) ----

    @Test
    fun getInquiriesReadsTheListWithTheAppsCredential() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to response(inquiry("found")).toString())
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1, credential = CredentialProvider { "session-1" }, onUnauthorized = {})
            val parsed = api.getInquiries()
            server.join()
            assertTrue(server.requests.single().requestLine.startsWith("GET /v1/inquiries "))
            assertEquals("found", parsed.inquiries.single().status)
        }
    }

    @Test
    fun aMalformedListIsAProtocolErrorNeverShown() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to response(inquiry("thinking", closedAt = null)).toString())
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1, credential = CredentialProvider { "session-1" }, onUnauthorized = {})
            val error = runCatching { api.getInquiries() }.exceptionOrNull()
            assertTrue("$error", error is ApiException.Protocol)
        }
    }

    @Test
    fun putInquiryConsentSendsTheWholeEnvelopeAndParsesTheReceipt() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to JSONObject().put("privacyEpoch", 4).put("consent", consentJson(dailyLimit = 5)).toString())
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1, credential = CredentialProvider { "session-1" }, onUnauthorized = {})
            val receipt = api.putInquiryConsent(InquiryConsentRequest("33333333-3333-4333-8333-333333333333", enabled = true, dailyLimit = 5, expectedPrivacyEpoch = 4))
            server.join()
            val request = server.requests.single()
            assertTrue(request.requestLine.startsWith("PUT /v1/inquiries/consent "))
            val body = JSONObject(request.body)
            assertEquals(setOf("enabled", "dailyLimit", "clientRequestId", "expectedPrivacyEpoch"), body.keys().asSequence().toSet())
            assertEquals(true, body.getBoolean("enabled"))
            assertEquals(5, body.getInt("dailyLimit"))
            assertEquals("33333333-3333-4333-8333-333333333333", body.getString("clientRequestId"))
            assertEquals(4L, body.getLong("expectedPrivacyEpoch"))
            assertEquals(5, receipt.consent.dailyLimit)
        }
    }

    @Test
    fun aConsentReceiptForAnotherEpochIsAProtocolError() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to JSONObject().put("privacyEpoch", 5).put("consent", consentJson()).toString())
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1, credential = CredentialProvider { "session-1" }, onUnauthorized = {})
            val error = runCatching {
                api.putInquiryConsent(InquiryConsentRequest("33333333-3333-4333-8333-333333333333", enabled = true, dailyLimit = 3, expectedPrivacyEpoch = 4))
            }.exceptionOrNull()
            assertTrue("$error", error is ApiException.Protocol)
        }
    }

    @Test
    fun aStaleEpochOrReusedKeyIsAConflictTheCallerSees() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(409 to """{"error":"Consent privacy epoch is stale"}""")
            val api = ApiClient(server.baseUrl, "", maxAttempts = 2, credential = CredentialProvider { "session-1" }, onUnauthorized = {})
            val error = runCatching {
                api.putInquiryConsent(InquiryConsentRequest("33333333-3333-4333-8333-333333333333", enabled = false, dailyLimit = 3, expectedPrivacyEpoch = 1))
            }.exceptionOrNull()
            assertTrue("$error", error is ApiException.Server && error.statusCode == 409)
            assertEquals("a 409 is definitive: the client never re-sends it on its own", 1, server.requests.size)
        }
    }
}
