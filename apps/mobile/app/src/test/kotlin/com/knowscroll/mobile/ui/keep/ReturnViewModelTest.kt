package com.knowscroll.mobile.ui.keep

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.CredentialProvider
import com.knowscroll.mobile.data.TestHttpServer
import com.knowscroll.mobile.data.awaitUntil
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.SocketTimeoutException

/**
 * #134 (ADR-0039): the return and Relics against a fixture API. Every action is one explicit
 * request with a client request id made once per intent; a failure that may have landed keeps that
 * same request for an explicit retry (which the server replays), a definitive refusal (409, 422,
 * 400) is surfaced, never re-sent, and what is current is read again -- `InquiriesViewModel`'s
 * model. A 401 goes to the app's sign-out path. Reads run concurrently, so the fixture answers by
 * route rather than by order.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReturnViewModelTest {
    private val bridgeId = "22222222-2222-4222-8222-222222222222"
    private val relicId = "66666666-6666-4666-8666-666666666666"
    private val lost = TestHttpServer.HANG to ""

    /** Replies queued per `METHOD /path`, served to whichever request asks for that route. */
    private class Routes(vararg replies: Pair<String, Pair<Int, String>>) {
        private val queues = replies.groupBy({ it.first }, { it.second }).mapValues { ArrayDeque(it.value) }
        val count = replies.size
        fun reply(request: TestHttpServer.Recorded): Pair<Int, String> =
            queues.entries.firstOrNull { request.requestLine.startsWith("${it.key} ") }?.value?.removeFirstOrNull()
                ?: (500 to """{"error":"unexpected ${request.requestLine}"}""")
    }

    private fun TestHttpServer.serve(routes: Routes) = serveBy(routes.count, routes::reply)

    private fun viewModel(server: TestHttpServer, onUnauthorized: () -> Unit = {}): ReturnViewModel {
        // A short read timeout: `TestHttpServer.HANG` stands for a response that never arrives.
        val api = ApiClient(server.baseUrl, "", readTimeoutMs = 700, maxAttempts = 1, credential = CredentialProvider { "session-1" }, onUnauthorized = onUnauthorized)
        return ReturnViewModel(ApplicationProvider.getApplicationContext<Application>(), api)
    }

    private fun connection(bridgeStatus: String = "admitted") = """{"bridgeId":"$bridgeId","bridgeStatus":"$bridgeStatus","relationType":"compares_mechanism",
        "fromConcept":{"code":"astro.sun","name":"The Sun"},"toConcept":{"code":"physics.gravity","name":"Gravity"},
        "sentence":"The Sun keeps every planet on a closed path because its gravity bends each one toward it.",
        "evidence":[{"claimKey":"clm.gravity.sun_holds_earth","statement":"The Sun's gravity holds Earth in its orbit.","supports":"mechanism",
        "sourceTitle":"NASA · Our Sun: Facts","sourceUrl":"https://science.nasa.gov/sun/facts/"}]}"""

    private val found = """{"kind":"connection_found","at":"2026-09-24T10:05:00.000Z","inquiryId":"11111111-1111-4111-8111-111111111111","found":${connection()}}"""
    private val nothing = """{"kind":"nothing_found","at":"2026-09-24T10:01:00.000Z","inquiryId":"33333333-3333-4333-8333-333333333333",
        "pairs":[{"a":{"code":"astro.orbit","name":"Orbit"},"b":{"code":"earth.tides","name":"Tides"}}]}"""

    private fun away(vararg items: String, epoch: Long = 4, paused: Boolean = false) =
        "GET /v1/away" to (200 to """{"privacyEpoch":$epoch,"since":null,"items":[${items.joinToString(",")}],"more":0,"recordingPaused":$paused}""")

    private fun relic(state: String = "current") =
        """{"relicId":"$relicId","kind":"connection","keptAt":"2026-09-24T10:10:00.000Z","state":"$state",
        "connection":${connection(if (state == "corrected") "revoked" else "admitted")},
        "provenance":{"inquiryId":"11111111-1111-4111-8111-111111111111","validatorVersion":"bridge-validator-v1","citedClaimKeys":["clm.gravity.sun_holds_earth"]}}"""

    private fun relics(vararg relics: String, epoch: Long = 4) = "GET /v1/relics" to (200 to """{"privacyEpoch":$epoch,"relics":[${relics.joinToString(",")}]}""")
    private fun acknowledged(epoch: Long = 4, since: String = "2026-09-24T10:05:00.000Z") =
        "POST /v1/away/acknowledge" to (200 to """{"privacyEpoch":$epoch,"since":"$since"}""")
    private fun kept(status: Int = 201, state: String = "current", epoch: Long = 4) = "POST /v1/relics" to (status to """{"privacyEpoch":$epoch,"relic":${relic(state)}}""")
    private val feedback = "POST /v1/connections/feedback" to
        (201 to """{"feedbackId":"99999999-9999-4999-8999-999999999999","bridgeId":"$bridgeId","objection":"seems_wrong","suppressed":true}""")
    private val released = "POST /v1/relics/$relicId/release" to (200 to """{"privacyEpoch":4,"relicId":"$relicId","released":true}""")

    private fun sent(server: TestHttpServer, route: String): List<JSONObject> =
        server.snapshot().filter { it.requestLine.startsWith("$route ") }.map { JSONObject(it.body) }

    private fun loadedAway(model: ReturnViewModel) = (model.away.value as AwayState.Loaded).response
    private fun loadedRelics(model: ReturnViewModel) = (model.relics.value as RelicsState.Loaded).response
    // For waits: a reload passes through Loading, which is not yet the answer (never a cast failure).
    private fun awayOrNull(model: ReturnViewModel) = (model.away.value as? AwayState.Loaded)?.response
    private fun relicsOrNull(model: ReturnViewModel) = (model.relics.value as? RelicsState.Loaded)?.response
    private fun awayEpoch(model: ReturnViewModel) = awayOrNull(model)?.privacyEpoch
    private fun relicsEpoch(model: ReturnViewModel) = relicsOrNull(model)?.privacyEpoch

    private fun openAtlas(model: ReturnViewModel) {
        model.openAtlas()
        awaitUntil { model.away.value is AwayState.Loaded && model.relics.value is RelicsState.Loaded }
    }

    private fun connectionState(model: ReturnViewModel) = model.connections.value[bridgeId] ?: ConnectionState()

    // ---- Reading ----

    @Test
    fun openingTheAtlasReadsWhatChangedAndTheRelicsTogether() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found, nothing), relics()))
            val model = viewModel(server)
            assertEquals(AwayState.Loading, model.away.value)
            openAtlas(model)
            assertEquals(2, loadedAway(model).items.size)
            assertTrue(loadedRelics(model).relics.isEmpty())
            assertEquals(ConnectionState(), connectionState(model))
        }
    }

    @Test
    fun aKeptRelicSaysItsConnectionIsKeptAndADoubtedOneThatItWasMarkedWrong() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(relic("doubted"))))
            val model = viewModel(server)
            openAtlas(model)
            assertTrue(connectionState(model).kept)
            assertTrue(connectionState(model).markedWrong)
        }
    }

    @Test
    fun aFailedReadIsUnavailableAndOpeningAgainReadsAgain() {
        TestHttpServer.open().use { server ->
            server.serve(Routes("GET /v1/relics" to (503 to """{"error":"unavailable"}"""), relics(relic())))
            val model = viewModel(server)
            model.openKeep()
            awaitUntil { model.relics.value is RelicsState.Unavailable }
            model.openKeep()
            awaitUntil { model.relics.value is RelicsState.Loaded }
            assertEquals(1, loadedRelics(model).relics.size)
        }
    }

    // ---- "Mark as seen" ----

    @Test
    fun markAsSeenAcknowledgesThroughTheNewestItemShownThenReadsAgain() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found, nothing), relics(), acknowledged(), away()))
            val model = viewModel(server)
            openAtlas(model)
            model.markSeen()
            assertEquals(ReturnActionState.Working, model.acknowledge.value)
            awaitUntil { awayOrNull(model)?.items?.isEmpty() == true && model.acknowledge.value == ReturnActionState.Idle }
            val body = sent(server, "POST /v1/away/acknowledge").single()
            assertEquals("the newest item displayed, not the time of the tap", "2026-09-24T10:05:00.000Z", body.getString("through"))
            assertEquals(4L, body.getLong("expectedPrivacyEpoch"))
            assertTrue(Regex("^[0-9a-f-]{36}$").matches(body.getString("clientRequestId")))
        }
    }

    @Test
    fun whileRecordingIsPausedMarkAsSeenSendsNothing() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found, paused = true), relics()))
            val model = viewModel(server)
            openAtlas(model)
            model.markSeen()
            model.retryMarkSeen()
            assertEquals(ReturnActionState.Idle, model.acknowledge.value)
            server.join(200)
            assertEquals(2, server.requests.size)
        }
    }

    @Test
    fun aLostAcknowledgementKeepsTheSameRequestAndRetrySendsItAgain() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(), "POST /v1/away/acknowledge" to lost, acknowledged(), away()))
            val model = viewModel(server)
            openAtlas(model)
            model.markSeen()
            awaitUntil { model.acknowledge.value is ReturnActionState.Failed }
            assertTrue("an unconfirmed acknowledgement may have landed: retry is offered", (model.acknowledge.value as ReturnActionState.Failed).canRetry)
            model.retryMarkSeen()
            awaitUntil { model.acknowledge.value == ReturnActionState.Idle && awayOrNull(model)?.items?.isEmpty() == true }
            val (first, retry) = sent(server, "POST /v1/away/acknowledge")
            assertEquals("the retry is the same request: id, epoch and time", first.toString(), retry.toString())
        }
    }

    @Test
    fun tappingMarkAsSeenAgainAfterAnUnconfirmedOneResendsThatSameRequest() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(), "POST /v1/away/acknowledge" to (502 to "{}"), acknowledged(), away()))
            val model = viewModel(server)
            openAtlas(model)
            model.markSeen()
            awaitUntil { (model.acknowledge.value as? ReturnActionState.Failed)?.canRetry == true }
            model.markSeen()
            awaitUntil { model.acknowledge.value == ReturnActionState.Idle }
            val (first, again) = sent(server, "POST /v1/away/acknowledge")
            assertEquals(first.getString("clientRequestId"), again.getString("clientRequestId"))
        }
    }

    @Test
    fun aConflictIsNeverRetriedAndWhatIsCurrentIsReadAgain() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(
                away(found), relics(), "POST /v1/away/acknowledge" to (409 to """{"error":"Recording is paused"}"""),
                away(found, paused = true), relics(),
            ))
            val model = viewModel(server)
            openAtlas(model)
            model.markSeen()
            awaitUntil { model.acknowledge.value is ReturnActionState.Failed && awayOrNull(model)?.recordingPaused == true }
            assertTrue("a definitive refusal offers no retry", !(model.acknowledge.value as ReturnActionState.Failed).canRetry)
            model.retryMarkSeen()
            model.markSeen()
            server.join(300)
            assertEquals("nothing is re-sent, and paused recording sends nothing new", 1, sent(server, "POST /v1/away/acknowledge").size)
        }
    }

    // ---- "Keep" ----

    @Test
    fun keepKeepsTheConnectionAndReadsTheRelicsAgain() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(), kept(), relics(relic())))
            val model = viewModel(server)
            openAtlas(model)
            model.keep(bridgeId)
            assertEquals(ReturnActionState.Working, connectionState(model).keep)
            awaitUntil { connectionState(model).kept && relicsOrNull(model)?.relics?.size == 1 }
            val body = sent(server, "POST /v1/relics").single()
            assertEquals(bridgeId, body.getString("bridgeId"))
            assertEquals("connection", body.getString("kind"))
            assertEquals(4L, body.getLong("expectedPrivacyEpoch"))
            assertEquals(ReturnActionState.Idle, connectionState(model).keep)
            model.keep(bridgeId)
            server.join(300)
            assertEquals("a kept connection is not kept twice", 1, sent(server, "POST /v1/relics").size)
        }
    }

    @Test
    fun anAlreadyKeptRelicIsAcceptedToo() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(), kept(status = 200), relics(relic())))
            val model = viewModel(server)
            openAtlas(model)
            model.keep(bridgeId)
            awaitUntil { connectionState(model).kept }
        }
    }

    @Test
    fun anUnconfirmedKeepIsSentAgainAsTheSameRequest() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(), "POST /v1/relics" to (503 to "{}"), kept(), relics(relic())))
            val model = viewModel(server)
            openAtlas(model)
            model.keep(bridgeId)
            awaitUntil { (connectionState(model).keep as? ReturnActionState.Failed)?.canRetry == true }
            model.retryKeep(bridgeId)
            awaitUntil { connectionState(model).kept }
            val (first, retry) = sent(server, "POST /v1/relics")
            assertEquals(first.toString(), retry.toString())
        }
    }

    @Test
    fun aWithdrawnConnectionIsRefusedNotRetriedAndBothListsAreReadAgain() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(
                away(found), relics(), "POST /v1/relics" to (422 to """{"error":"Unknown or withdrawn connection"}"""),
                away(found), relics(),
            ))
            val model = viewModel(server)
            openAtlas(model)
            model.keep(bridgeId)
            awaitUntil { connectionState(model).keep is ReturnActionState.Failed && server.requests.size == 5 }
            val failed = connectionState(model).keep as ReturnActionState.Failed
            assertTrue(!failed.canRetry)
            assertEquals("This connection can no longer be kept: it was withdrawn, or you marked it as seeming wrong.", failed.message)
            model.retryKeep(bridgeId)
            server.join(300)
            assertEquals(1, sent(server, "POST /v1/relics").size)
            assertTrue(!connectionState(model).kept)
        }
    }

    // ---- "Seems wrong" ----

    @Test
    fun seemsWrongMarksTheConnectionAndReadsBothListsAgain() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(relic()), feedback, away(found), relics(relic("doubted"))))
            val model = viewModel(server)
            openAtlas(model)
            assertTrue(connectionState(model).kept)
            model.seemsWrong(bridgeId)
            awaitUntil { connectionState(model).markedWrong && relicsOrNull(model)?.relics?.singleOrNull()?.state == "doubted" }
            val body = sent(server, "POST /v1/connections/feedback").single()
            assertEquals("seems_wrong", body.getString("objection"))
            assertEquals(bridgeId, body.getString("bridgeId"))
            assertEquals(4L, body.getLong("expectedPrivacyEpoch"))
            awaitUntil { server.requests.size == 5 }
            assertTrue("still kept: a doubt does not release the Relic", connectionState(model).kept)
        }
    }

    @Test
    fun anUnconfirmedSeemsWrongIsSentAgainAsTheSameRequest() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(), "POST /v1/connections/feedback" to lost, feedback, away(found), relics()))
            val model = viewModel(server)
            openAtlas(model)
            model.seemsWrong(bridgeId)
            awaitUntil { (connectionState(model).seemsWrong as? ReturnActionState.Failed)?.canRetry == true }
            model.retrySeemsWrong(bridgeId)
            awaitUntil { connectionState(model).markedWrong }
            val (first, retry) = sent(server, "POST /v1/connections/feedback")
            assertEquals(first.getString("clientFeedbackId"), retry.getString("clientFeedbackId"))
        }
    }

    // ---- "Let go" ----

    @Test
    fun letGoRemovesTheRelicAtOnceAndReadsTheListAgain() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(relics(relic()), released, relics()))
            val model = viewModel(server)
            model.openKeep()
            awaitUntil { model.relics.value is RelicsState.Loaded }
            model.letGo(relicId)
            assertEquals(ReturnActionState.Working, model.releases.value[relicId])
            awaitUntil { relicsOrNull(model)?.relics?.isEmpty() == true && model.releases.value[relicId] == null }
            assertEquals("""{"expectedPrivacyEpoch":4}""", server.snapshot()[1].body)
            awaitUntil { server.requests.size == 3 }
            assertTrue(!connectionState(model).kept)
        }
    }

    @Test
    fun anUnconfirmedLetGoIsRetriedForTheSameRelic() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(relics(relic()), "POST /v1/relics/$relicId/release" to lost, released, relics()))
            val model = viewModel(server)
            model.openKeep()
            awaitUntil { model.relics.value is RelicsState.Loaded }
            model.letGo(relicId)
            awaitUntil { (model.releases.value[relicId] as? ReturnActionState.Failed)?.canRetry == true }
            assertEquals("still listed until the server confirms", 1, loadedRelics(model).relics.size)
            model.retryLetGo(relicId)
            awaitUntil { relicsOrNull(model)?.relics?.isEmpty() == true }
        }
    }

    @Test
    fun aKeepTheListConfirmsIsSettledSoARetryNeverBringsBackALetGoRelic() {
        TestHttpServer.open().use { server ->
            // Review M1: the keep landed but its answer was lost; the list then shows the Relic.
            server.serve(Routes(away(found), relics(), "POST /v1/relics" to (503 to "{}"), relics(relic()), released, relics()))
            val model = viewModel(server)
            openAtlas(model)
            model.keep(bridgeId)
            awaitUntil { (connectionState(model).keep as? ReturnActionState.Failed)?.canRetry == true }
            model.openKeep()
            awaitUntil { relicsOrNull(model)?.relics?.size == 1 }
            assertEquals("the list confirms it: nothing is left to retry", ReturnActionState.Idle, connectionState(model).keep)
            model.letGo(relicId)
            awaitUntil { relicsOrNull(model)?.relics?.isEmpty() == true }
            model.retryKeep(bridgeId)
            server.join(300)
            assertEquals("a Relic the reader let go is never kept again by a stale retry", 1, sent(server, "POST /v1/relics").size)
        }
    }

    // ---- Session and epoch ----

    @Test
    fun a401GoesToTheSignOutPathAndKeepsNothing() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(away(found), relics(), "POST /v1/relics" to (401 to """{"error":"Unauthorized"}""")))
            var signalled = 0
            val model = viewModel(server, onUnauthorized = { signalled += 1 })
            openAtlas(model)
            model.keep(bridgeId)
            awaitUntil { model.away.value is AwayState.Unavailable && model.relics.value is RelicsState.Unavailable }
            assertEquals(1, signalled)
            assertTrue(model.connections.value.isEmpty())
            model.retryKeep(bridgeId)
            server.join(300)
            assertEquals("nothing of the dead session is kept to re-send", 1, sent(server, "POST /v1/relics").size)
        }
    }

    @Test
    fun anEpochChangeDropsWhatWasKeptForTheOldEpoch() {
        TestHttpServer.open().use { server ->
            server.serve(Routes(
                away(found), relics(), "POST /v1/relics" to (503 to "{}"),
                away(found, epoch = 5), relics(epoch = 5), kept(epoch = 5), relics(relic(), epoch = 5),
            ))
            val model = viewModel(server)
            openAtlas(model)
            model.keep(bridgeId)
            awaitUntil { (connectionState(model).keep as? ReturnActionState.Failed)?.canRetry == true }
            model.openAtlas()
            awaitUntil { awayEpoch(model) == 5L && relicsEpoch(model) == 5L }
            assertEquals("a request for the old epoch could only be refused", ConnectionState(), connectionState(model))
            model.retryKeep(bridgeId)
            server.join(300)
            assertEquals(1, sent(server, "POST /v1/relics").size)
            model.keep(bridgeId)
            awaitUntil { connectionState(model).kept }
            assertEquals("a new intent carries the current epoch", 5L, sent(server, "POST /v1/relics").last().getLong("expectedPrivacyEpoch"))
            assertNotEquals(sent(server, "POST /v1/relics").first().getString("clientRequestId"), sent(server, "POST /v1/relics").last().getString("clientRequestId"))
        }
    }

    // ---- Decisions and wiring ----

    @Test
    fun whatAFailureMeansForARetry() {
        assertEquals(ReturnFailure.SessionEnded, returnFailure(ApiException.MissingToken))
        assertEquals(ReturnFailure.SessionEnded, returnFailure(ApiException.Server(401, "")))
        assertEquals(ReturnFailure.Conflict, returnFailure(ApiException.Server(409, "")))
        assertEquals(ReturnFailure.Refused, returnFailure(ApiException.Server(422, "")))
        assertEquals(ReturnFailure.Refused, returnFailure(ApiException.Server(400, "")))
        assertEquals(ReturnFailure.Unconfirmed, returnFailure(ApiException.Server(408, "")))
        assertEquals(ReturnFailure.Unconfirmed, returnFailure(ApiException.Server(429, "")))
        assertEquals(ReturnFailure.Unconfirmed, returnFailure(ApiException.Server(503, "")))
        assertEquals(ReturnFailure.Unconfirmed, returnFailure(ApiException.Network("timed out", mayHaveLanded = true)))
        assertEquals(ReturnFailure.Unconfirmed, returnFailure(ApiException.Protocol("unreadable receipt")))
        assertEquals(ReturnFailure.Unconfirmed, returnFailure(SocketTimeoutException()))
    }

    /** The app obtains it through the standard factory (`viewModel()` in KnowScrollApp). */
    @Test
    fun theStandardViewModelFactoryCanCreateIt() {
        val application = ApplicationProvider.getApplicationContext<Application>()
        val created = androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.getInstance(application).create(ReturnViewModel::class.java)
        assertNotNull(created)
    }
}
