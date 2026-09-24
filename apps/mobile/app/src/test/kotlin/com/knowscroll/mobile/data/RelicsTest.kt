package com.knowscroll.mobile.data

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #134 (ADR-0039) — Relics are read back exactly as `packages/contracts/src/relics.ts` describes
 * them: strict on every object, a closed kind and state, bounded provenance, and the contract's own
 * refinement that a Relic is `corrected` exactly when its connection is no longer admitted -- a
 * correction is never hidden, and never claimed for a connection that still stands.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RelicsTest {
    private val relicId = "66666666-6666-4666-8666-666666666666"
    private val bridgeId = "22222222-2222-4222-8222-222222222222"
    private val inquiryId = "11111111-1111-4111-8111-111111111111"

    private fun concept(code: String, name: String) = JSONObject().put("code", code).put("name", name)

    private fun connection(bridgeStatus: String = "admitted", bridge: String = bridgeId) = JSONObject().apply {
        put("bridgeId", bridge); put("bridgeStatus", bridgeStatus); put("relationType", "compares_mechanism")
        put("fromConcept", concept("astro.sun", "The Sun")); put("toConcept", concept("physics.gravity", "Gravity"))
        put("sentence", "The Sun keeps every planet on a closed path because its gravity bends each one toward it.")
        put("evidence", JSONArray().put(JSONObject().apply {
            put("claimKey", "clm.gravity.sun_holds_earth"); put("statement", "The Sun's gravity holds Earth in its orbit.")
            put("supports", "mechanism"); put("sourceTitle", "NASA · Our Sun: Facts"); put("sourceUrl", "https://science.nasa.gov/sun/facts/")
        }))
    }

    private fun provenance(inquiry: String? = inquiryId, keys: List<String> = listOf("clm.gravity.sun_holds_earth")) = JSONObject().apply {
        put("inquiryId", inquiry ?: JSONObject.NULL); put("validatorVersion", "bridge-validator-v1"); put("citedClaimKeys", JSONArray(keys))
    }

    private fun relic(state: String = "current", bridgeStatus: String = if (state == "corrected") "revoked" else "admitted", provenance: JSONObject = provenance()) =
        JSONObject().apply {
            put("relicId", relicId); put("kind", "connection"); put("keptAt", "2026-09-24T10:10:00.000Z"); put("state", state)
            put("connection", connection(bridgeStatus)); put("provenance", provenance)
        }

    private fun list(vararg relics: JSONObject, epoch: Long = 4) = JSONObject().put("privacyEpoch", epoch).put("relics", JSONArray(relics.toList()))

    private fun refused(value: JSONObject) {
        try {
            parseRelicsResponse(value)
            fail("expected the Relic list to be refused: $value")
        } catch (_: IllegalArgumentException) {
        } catch (_: org.json.JSONException) {
        }
    }

    @Test
    fun parsesEveryStateWithItsKeptFormAndProvenance() {
        val parsed = parseRelicsResponse(list(relic("current"), relic("doubted"), relic("corrected"), relic("corrected", bridgeStatus = "superseded")))
        assertEquals(4L, parsed.privacyEpoch)
        assertEquals(listOf("current", "doubted", "corrected", "corrected"), parsed.relics.map { it.state })
        val first = parsed.relics.first()
        assertEquals(relicId, first.relicId)
        assertEquals("2026-09-24T10:10:00.000Z", first.keptAt)
        assertEquals(bridgeId, first.connection.bridgeId)
        assertEquals(inquiryId, first.provenance.inquiryId)
        assertEquals("bridge-validator-v1", first.provenance.validatorVersion)
        assertEquals(listOf("clm.gravity.sun_holds_earth"), first.provenance.citedClaimKeys)
        assertEquals("the kept form stays readable when corrected", first.connection.sentence, parsed.relics[2].connection.sentence)
    }

    @Test
    fun aRelicKeptOutsideAnInquiryHasNoInquiry() {
        assertNull(parseRelicsResponse(list(relic(provenance = provenance(inquiry = null)))).relics.single().provenance.inquiryId)
    }

    @Test
    fun correctedExactlyWhenTheConnectionIsNoLongerAdmitted() {
        refused(list(relic("corrected", bridgeStatus = "admitted")))
        refused(list(relic("current", bridgeStatus = "revoked")))
        refused(list(relic("doubted", bridgeStatus = "superseded")))
    }

    @Test
    fun closedKindAndStateAndStrictShapes() {
        refused(list(relic().put("kind", "question")))
        refused(list(relic("forgotten", bridgeStatus = "admitted")))
        refused(list(relic().put("note", "model text")))
        refused(list(relic().apply { remove("keptAt") }))
        refused(list(relic(provenance = provenance().put("attemptId", inquiryId))))
        refused(list(relic(provenance = provenance().apply { remove("inquiryId") })))
        refused(list().put("more", 0))
        refused(JSONObject().put("privacyEpoch", 4))
    }

    @Test
    fun boundsAndFormatsAreEnforced() {
        refused(list(epoch = -1))
        refused(list(relic().put("relicId", "not-a-uuid")))
        refused(list(relic().put("keptAt", "yesterday")))
        refused(list(relic(provenance = provenance(keys = emptyList()))))
        refused(list(relic(provenance = provenance(keys = List(13) { "clm.key_$it" }))))
        refused(list(relic(provenance = provenance(keys = listOf("")))))
        refused(list(relic(provenance = provenance(keys = listOf("x".repeat(201))))))
        refused(list(relic(provenance = provenance().put("validatorVersion", ""))))
        refused(list(relic(provenance = provenance(inquiry = "not-a-uuid"))))
        refused(list(*Array(101) { relic() }))
    }

    @Test
    fun keepAndReleaseReceiptsAreParsedStrictlyToo() {
        val kept = parseRelicKeepResponse(JSONObject().put("privacyEpoch", 4).put("relic", relic()))
        assertEquals(relicId, kept.relic.relicId)
        val released = parseRelicReleaseResponse(JSONObject().put("privacyEpoch", 4).put("relicId", relicId).put("released", true))
        assertEquals(relicId, released.relicId)
        for (bad in listOf(
            { parseRelicReleaseResponse(JSONObject().put("privacyEpoch", 4).put("relicId", relicId).put("released", false)) },
            { parseRelicReleaseResponse(JSONObject().put("privacyEpoch", 4).put("relicId", relicId)) },
            { parseRelicKeepResponse(JSONObject().put("privacyEpoch", 4).put("relic", relic()).put("created", true)) },
        )) {
            try {
                bad()
                fail("expected the receipt to be refused")
            } catch (_: IllegalArgumentException) {
            } catch (_: org.json.JSONException) {
            }
        }
    }

    // ---- Over the wire (ApiClient) ----

    private fun api(server: TestHttpServer, attempts: Int = 1) =
        ApiClient(server.baseUrl, "", maxAttempts = attempts, credential = CredentialProvider { "session-1" }, onUnauthorized = {})

    private val keep = RelicKeepRequest("77777777-7777-4777-8777-777777777777", 4, bridgeId)

    @Test
    fun getRelicsReadsTheList() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to list(relic("doubted")).toString())
            val parsed = api(server).getRelics()
            server.join()
            assertTrue(server.requests.single().requestLine.startsWith("GET /v1/relics "))
            assertEquals("doubted", parsed.relics.single().state)
        }
    }

    @Test
    fun keepSendsTheContractsBodyAndAcceptsANewOrAnAlreadyKeptRelic() = runBlocking {
        for (status in listOf(201, 200)) {
            TestHttpServer.open().use { server ->
                server.serve(status to JSONObject().put("privacyEpoch", 4).put("relic", relic()).toString())
                val receipt = api(server).keepRelic(keep)
                server.join()
                val request = server.requests.single()
                assertTrue(request.requestLine.startsWith("POST /v1/relics "))
                val body = JSONObject(request.body)
                assertEquals(setOf("clientRequestId", "expectedPrivacyEpoch", "kind", "bridgeId"), body.keys().asSequence().toSet())
                assertEquals("connection", body.getString("kind"))
                assertEquals(bridgeId, body.getString("bridgeId"))
                assertEquals(keep.clientRequestId, body.getString("clientRequestId"))
                assertEquals(4L, body.getLong("expectedPrivacyEpoch"))
                assertEquals(relicId, receipt.relic.relicId)
            }
        }
    }

    @Test
    fun aKeepReceiptForAnotherEpochOrConnectionIsAProtocolError() = runBlocking {
        val other = "88888888-8888-4888-8888-888888888888"
        for (reply in listOf(
            JSONObject().put("privacyEpoch", 5).put("relic", relic()),
            JSONObject().put("privacyEpoch", 4).put("relic", relic().put("connection", connection(bridge = other))),
        )) {
            TestHttpServer.open().use { server ->
                server.serve(201 to reply.toString())
                val error = runCatching { api(server).keepRelic(keep) }.exceptionOrNull()
                assertTrue("$error", error is ApiException.Protocol)
            }
        }
    }

    @Test
    fun aWithdrawnOrDoubtedConnectionIsADefinitiveRefusal() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(422 to """{"error":"You marked this connection as seeming wrong"}""")
            val error = runCatching { api(server, attempts = 2).keepRelic(keep) }.exceptionOrNull()
            assertTrue("$error", error is ApiException.Server && error.statusCode == 422 && !error.mayHaveLanded)
            assertEquals(1, server.requests.size)
        }
    }

    @Test
    fun releaseNamesTheRelicInThePathAndChecksTheReceipt() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to JSONObject().put("privacyEpoch", 4).put("relicId", relicId).put("released", true).toString())
            api(server).releaseRelic(relicId, 4)
            server.join()
            val request = server.requests.single()
            assertTrue(request.requestLine.startsWith("POST /v1/relics/$relicId/release "))
            assertEquals("""{"expectedPrivacyEpoch":4}""", request.body)
        }
        for (reply in listOf(
            JSONObject().put("privacyEpoch", 5).put("relicId", relicId).put("released", true),
            JSONObject().put("privacyEpoch", 4).put("relicId", bridgeId).put("released", true),
        )) {
            TestHttpServer.open().use { server ->
                server.serve(200 to reply.toString())
                val error = runCatching { api(server).releaseRelic(relicId, 4) }.exceptionOrNull()
                assertTrue("$error", error is ApiException.Protocol)
            }
        }
    }

    @Test
    fun seemsWrongIsTheConnectionFeedbackRouteAsOneReplayableRequest() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(201 to """{"feedbackId":"99999999-9999-4999-8999-999999999999","bridgeId":"$bridgeId","objection":"seems_wrong","suppressed":true}""")
            api(server).postConnectionFeedback(ConnectionFeedbackRequest("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bridgeId, 4))
            server.join()
            val request = server.requests.single()
            assertTrue(request.requestLine.startsWith("POST /v1/connections/feedback "))
            val body = JSONObject(request.body)
            assertEquals(setOf("clientFeedbackId", "bridgeId", "expectedPrivacyEpoch", "objection"), body.keys().asSequence().toSet())
            assertEquals("seems_wrong", body.getString("objection"))
            assertEquals("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", body.getString("clientFeedbackId"))
        }
    }
}
