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
 * #134/#165 (ADR-0039, ADR-0044) — Relics are read back exactly as `packages/contracts/src/relics.ts`
 * describes them: strict on every object, a closed kind and state, bounded provenance, and the
 * contract's own refinements -- a connection is `corrected` exactly when it is no longer admitted, a
 * passage whose claim was withdrawn is corrected, a next page comes only after a full one. The new
 * kinds carry their kept form and state, never a source.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RelicsTest {
    private val relicId = "66666666-6666-4666-8666-666666666666"
    private val bridgeId = "22222222-2222-4222-8222-222222222222"
    private val inquiryId = "11111111-1111-4111-8111-111111111111"
    private val placeId = "44444444-4444-4444-8444-444444444444"
    private val assetId = "55555555-5555-4555-8555-555555555555"
    private val askId = "99999999-9999-4999-8999-999999999999"
    private val cursor = "2026-09-24T10:10:00.123456Z|$relicId"

    private fun concept(code: String, name: String) = JSONObject().put("code", code).put("name", name)

    private fun connection(bridgeStatus: String = "admitted", bridge: String = bridgeId) = JSONObject().apply {
        put("bridgeId", bridge); put("bridgeStatus", bridgeStatus); put("relationType", "compares_mechanism")
        put("fromConcept", concept("astro.sun", "The Sun")); put("toConcept", concept("physics.gravity", "Gravity"))
        put("sentence", "The Sun keeps every planet on a closed path because its gravity bends each one toward it.")
        put("evidence", JSONArray().put(JSONObject().apply {
            put("claimKey", "clm.gravity.sun_holds_earth"); put("statement", "The Sun's gravity holds Earth in its orbit.")
            put("supports", "mechanism"); put("sourceTitle", "NASA · Our Sun: Facts"); put("sourceUrl", "https://science.nasa.gov/sun/facts/")
            put("withdrawn", false)
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

    private fun kept(kind: String, state: String, body: JSONObject) = JSONObject().apply {
        put("relicId", relicId); put("kind", kind); put("keptAt", "2026-09-24T10:10:00.000Z"); put("state", state); put(kind, body)
    }

    private fun place(state: String = "current") = kept("place", state, JSONObject().apply {
        put("placeId", placeId); put("kind", "sighting"); put("anchor", concept("earth.tides", "Tides"))
        put("formedAt", "2026-09-24T09:00:00.000Z"); put("formation", "Tides appeared near Gravity: Gravity explains Tides.")
    })

    private fun passage(state: String = "current", withdrawn: Boolean = false) = kept("passage", state, JSONObject().apply {
        put("assetId", assetId); put("revision", 1); put("title", "The pull you can't see")
        put("claim", JSONObject().put("claimKey", "clm.gravity.mass").put("statement", "Every mass attracts every other mass.").put("withdrawn", withdrawn))
    })

    private fun answer(state: String = "current") = kept("answer", state, JSONObject().apply {
        put("askId", askId); put("assetId", assetId); put("revision", 1); put("title", "The pull you can't see")
        put("question", "What pulls things together?"); put("answer", "Gravity: every mass attracts every other mass.")
        put("basis", JSONArray().put(JSONObject().put("quote", "Every mass attracts every other mass"))); put("limits", "Only what this Scroll says.")
    })

    private fun list(vararg relics: JSONObject, epoch: Long = 4, nextPage: String? = null, paused: Boolean = false) = JSONObject()
        .put("privacyEpoch", epoch).put("relics", JSONArray(relics.toList())).put("nextPage", nextPage ?: JSONObject.NULL).put("recordingPaused", paused)

    private fun refused(value: JSONObject) = refusedBy { parseRelicsResponse(value) }

    private fun refusedBy(parse: () -> Any) {
        try {
            parse()
            fail("expected it to be refused")
        } catch (_: IllegalArgumentException) {
        } catch (_: org.json.JSONException) {
        }
    }

    @Test
    fun parsesEveryStateWithItsKeptFormAndProvenance() {
        val parsed = parseRelicsResponse(list(relic("current"), relic("doubted"), relic("corrected"), relic("corrected", bridgeStatus = "superseded")))
        assertEquals(4L, parsed.privacyEpoch)
        assertEquals(listOf("current", "doubted", "corrected", "corrected"), parsed.relics.map { it.state })
        val first = parsed.relics.first() as Relic.Connection
        assertEquals(relicId, first.relicId)
        assertEquals("2026-09-24T10:10:00.000Z", first.keptAt)
        assertEquals(bridgeId, first.connection.bridgeId)
        assertEquals(RelicTarget.Connection(bridgeId), first.target)
        assertEquals(inquiryId, first.provenance.inquiryId)
        assertEquals("bridge-validator-v1", first.provenance.validatorVersion)
        assertEquals(listOf("clm.gravity.sun_holds_earth"), first.provenance.citedClaimKeys)
        assertEquals("the kept form stays readable when corrected", first.connection.sentence, (parsed.relics[2] as Relic.Connection).connection.sentence)
        assertNull(parsed.nextPage)
        assertFalse(parsed.recordingPaused)
    }

    @Test
    fun aRelicKeptOutsideAnInquiryHasNoInquiry() {
        assertNull((parseRelicsResponse(list(relic(provenance = provenance(inquiry = null)))).relics.single() as Relic.Connection).provenance.inquiryId)
    }

    @Test
    fun aPlaceAPassageAndAnAnswerAreReadWithTheirKeptFormAndWhatTheyKeep() {
        val parsed = parseRelicsResponse(list(place("doubted"), passage("corrected", withdrawn = true), answer(), paused = true))
        assertTrue(parsed.recordingPaused)
        val p = parsed.relics[0] as Relic.Place
        assertEquals(listOf("doubted", "sighting", "Tides", "Tides appeared near Gravity: Gravity explains Tides."), listOf(p.state, p.placeKind, p.anchor.name, p.formation))
        assertEquals(RelicTarget.Place(placeId), p.target)
        val q = parsed.relics[1] as Relic.Passage
        assertEquals(listOf("The pull you can't see", "Every mass attracts every other mass."), listOf(q.title, q.statement))
        assertTrue(q.withdrawn)
        assertEquals(RelicTarget.Passage(assetId, 1, "clm.gravity.mass"), q.target)
        val a = parsed.relics[2] as Relic.Answer
        assertEquals(listOf("What pulls things together?", "Gravity: every mass attracts every other mass.", "Only what this Scroll says."), listOf(a.question, a.answer, a.limits))
        assertEquals(listOf("Every mass attracts every other mass"), a.basis)
        assertEquals(RelicTarget.Answer(askId), a.target)
    }

    @Test
    fun theNewKindsAreStrictAndCarryNoSource() {
        refused(list(place().apply { getJSONObject("place").put("sourceTitle", "NASA") }))
        refused(list(place().apply { getJSONObject("place").put("kind", "moon") }))
        refused(list(place().put("provenance", provenance())))
        refused(list(passage().apply { getJSONObject("passage").getJSONObject("claim").put("sourceUrl", "https://science.nasa.gov/") }))
        refused(list(passage().apply { getJSONObject("passage").put("revision", 0) }))
        refused(list(passage().apply { getJSONObject("passage").getJSONObject("claim").put("claimKey", "X") }))
        refused(list(answer().apply { getJSONObject("answer").put("basis", JSONArray()) }))
        refused(list(answer().apply { getJSONObject("answer").put("sourceTitle", "NASA") }))
        refused(list(answer().put("kind", "place")))
    }

    @Test
    fun aWithdrawnClaimIsNeverShownUnderACurrentOrDoubtedPassage() {
        refused(list(passage("current", withdrawn = true)))
        refused(list(passage("doubted", withdrawn = true)))
    }

    @Test
    fun aNextPageComesOnlyAfterAFullOneAndInTheContractsForm() {
        val full = Array(100) { place() }
        assertEquals(cursor, parseRelicsResponse(list(*full, nextPage = cursor)).nextPage)
        refused(list(place(), nextPage = cursor))
        refused(list(*full, nextPage = "2026-09-24T10:10:00.123Z|$relicId"))
        refused(list(*full, nextPage = relicId))
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
        refused(list().apply { remove("recordingPaused") })
        refused(list().apply { remove("nextPage") })
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
    fun keepReleaseObjectionAndPassageAnswersAreParsedStrictlyToo() {
        val kept = parseRelicKeepResponse(JSONObject().put("privacyEpoch", 4).put("relic", relic()))
        assertEquals(relicId, kept.relic.relicId)
        val released = parseRelicReleaseResponse(JSONObject().put("privacyEpoch", 4).put("relicId", relicId).put("released", true))
        assertEquals(relicId, released.relicId)
        assertEquals(askId, parseObjectionReceipt(JSONObject().put("privacyEpoch", 4).put("objectionId", askId)).objectionId)
        val passages = JSONObject().put("privacyEpoch", 4).put("assetId", assetId).put("revision", 2).put("recordingPaused", false)
            .put("passages", JSONArray().put(JSONObject().put("claimKey", "clm.gravity.mass").put("statement", "Every mass attracts every other mass.")
                .put("withdrawn", false).put("kept", true).put("seemsWrong", false)))
        val parsed = parsePassagesResponse(passages)
        assertEquals(2, parsed.revision)
        assertEquals(ScrollPassage("clm.gravity.mass", "Every mass attracts every other mass.", withdrawn = false, kept = true, seemsWrong = false), parsed.passages.single())
        refusedBy { parseRelicReleaseResponse(JSONObject().put("privacyEpoch", 4).put("relicId", relicId).put("released", false)) }
        refusedBy { parseRelicReleaseResponse(JSONObject().put("privacyEpoch", 4).put("relicId", relicId)) }
        refusedBy { parseRelicKeepResponse(JSONObject().put("privacyEpoch", 4).put("relic", relic()).put("created", true)) }
        refusedBy { parseObjectionReceipt(JSONObject().put("privacyEpoch", 4).put("objectionId", "not-a-uuid")) }
        refusedBy { parsePassagesResponse(JSONObject(passages.toString()).apply { getJSONArray("passages").getJSONObject(0).put("sourceTitle", "NASA") }) }
        refusedBy { parsePassagesResponse(JSONObject(passages.toString()).apply { remove("recordingPaused") }) }
        refusedBy { parsePassagesResponse(JSONObject(passages.toString()).put("revision", 0)) }
    }

    // ---- Over the wire (ApiClient) ----

    private fun api(server: TestHttpServer, attempts: Int = 1) =
        ApiClient(server.baseUrl, "", maxAttempts = attempts, credential = CredentialProvider { "session-1" }, onUnauthorized = {})

    private val keep = RelicKeepRequest("77777777-7777-4777-8777-777777777777", 4, RelicTarget.Connection(bridgeId))

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
    fun aLaterPageSendsBackTheCursorItWasGiven() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to list(place()).toString())
            api(server).getRelics(cursor)
            server.join()
            val line = server.requests.single().requestLine
            assertTrue(line, line.startsWith("GET /v1/relics?page=2026-09-24T10%3A10%3A00.123456Z%7C$relicId "))
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
    fun eachNewKindIsKeptWithExactlyTheContractsBodyAndItsReceiptMustNameIt() = runBlocking {
        for ((target, reply, fields) in listOf(
            Triple(RelicTarget.Place(placeId), place(), mapOf("kind" to "place", "placeId" to placeId)),
            Triple(RelicTarget.Passage(assetId, 1, "clm.gravity.mass"), passage(), mapOf("kind" to "passage", "assetId" to assetId, "revision" to 1, "claimKey" to "clm.gravity.mass")),
            Triple(RelicTarget.Answer(askId), answer(), mapOf("kind" to "answer", "askId" to askId)),
        )) {
            val request = RelicKeepRequest("77777777-7777-4777-8777-777777777777", 4, target)
            TestHttpServer.open().use { server ->
                server.serve(201 to JSONObject().put("privacyEpoch", 4).put("relic", reply).toString())
                assertEquals(target, api(server).keepRelic(request).relic.target)
                server.join()
                val body = JSONObject(server.requests.single().body)
                assertEquals(fields.keys + setOf("clientRequestId", "expectedPrivacyEpoch"), body.keys().asSequence().toSet())
                for ((key, value) in fields) assertEquals(value, body.get(key))
            }
            TestHttpServer.open().use { server ->
                server.serve(201 to JSONObject().put("privacyEpoch", 4).put("relic", if (target is RelicTarget.Answer) place() else answer()).toString())
                val error = runCatching { api(server).keepRelic(request) }.exceptionOrNull()
                assertTrue("a receipt for another thing: $error", error is ApiException.Protocol)
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

    @Test
    fun anObjectionNamesAPassageByItsClaimOrAnAnswer() = runBlocking {
        for ((target, fields) in listOf(
            RelicTarget.Passage(assetId, 3, "clm.gravity.mass") to mapOf("kind" to "passage", "assetId" to assetId, "claimKey" to "clm.gravity.mass"),
            RelicTarget.Answer(askId) to mapOf("kind" to "answer", "askId" to askId),
        )) {
            TestHttpServer.open().use { server ->
                server.serve(201 to JSONObject().put("privacyEpoch", 4).put("objectionId", relicId).toString())
                api(server).postObjection(ObjectionRequest("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 4, target))
                server.join()
                val request = server.requests.single()
                assertTrue(request.requestLine.startsWith("POST /v1/objections "))
                val body = JSONObject(request.body)
                assertEquals(fields.keys + setOf("clientRequestId", "expectedPrivacyEpoch"), body.keys().asSequence().toSet())
                for ((key, value) in fields) assertEquals(value, body.get(key))
            }
        }
        TestHttpServer.open().use { server ->
            server.serve(201 to JSONObject().put("privacyEpoch", 5).put("objectionId", relicId).toString())
            val error = runCatching { api(server).postObjection(ObjectionRequest("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 4, RelicTarget.Answer(askId))) }.exceptionOrNull()
            assertTrue("a receipt for another epoch: $error", error is ApiException.Protocol)
        }
    }

    @Test
    fun passagesAreReadForTheScrollAsked() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to JSONObject().put("privacyEpoch", 4).put("assetId", assetId).put("revision", 1).put("recordingPaused", false).put("passages", JSONArray()).toString())
            api(server).getPassages(assetId)
            server.join()
            assertTrue(server.requests.single().requestLine.startsWith("GET /v1/scrolls/$assetId/passages "))
        }
        TestHttpServer.open().use { server ->
            server.serve(200 to JSONObject().put("privacyEpoch", 4).put("assetId", placeId).put("revision", 1).put("recordingPaused", false).put("passages", JSONArray()).toString())
            val error = runCatching { api(server).getPassages(assetId) }.exceptionOrNull()
            assertTrue("passages of another Scroll: $error", error is ApiException.Protocol)
        }
    }
}
