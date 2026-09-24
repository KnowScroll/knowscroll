package com.knowscroll.mobile.ui.account

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.CredentialProvider
import com.knowscroll.mobile.data.FakeSessionVault
import com.knowscroll.mobile.data.InquiryConsentRequest
import com.knowscroll.mobile.data.SessionInvalidation
import com.knowscroll.mobile.data.StateStore
import com.knowscroll.mobile.data.TestHttpServer
import com.knowscroll.mobile.data.awaitUntil
import com.knowscroll.mobile.data.selectCredential
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #132 (ADR-0038): the reader's standing consent and what was looked for, against a fixture API.
 * Every consent change is one explicit request whose whole envelope (client request id, content,
 * epoch) is persisted before dispatch; only an ambiguous failure keeps it for an explicit retry of
 * the same request. A definitive refusal (a stale epoch, a reused key) is never re-sent: the list
 * reloads and the change is offered again at the current epoch -- the model #135's review fixed
 * for Delete/Reset (`AccountViewModel.runSelfEndingRequest`). A 401 goes to the app's sign-out path.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InquiriesViewModelTest {
    private fun freshStore(): StateStore {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        return StateStore(context)
    }

    private fun viewModel(
        server: TestHttpServer,
        store: StateStore = freshStore(),
        onUnauthorized: () -> Unit = {},
        credential: CredentialProvider = CredentialProvider { "session-1" },
    ): InquiriesViewModel {
        // A short read timeout: `TestHttpServer.HANG` stands for a response that never arrives.
        val api = ApiClient(server.baseUrl, "", readTimeoutMs = 700, maxAttempts = 1, credential = credential, onUnauthorized = onUnauthorized)
        return InquiriesViewModel(ApplicationProvider.getApplicationContext<Application>(), api, store)
    }

    private fun consentJson(enabled: Boolean, dailyLimit: Int, available: Boolean = true, usedToday: Int = 0) =
        """{"enabled":$enabled,"dailyLimit":$dailyLimit,"changedAt":${if (enabled) "\"2026-09-24T10:00:00.000Z\"" else "null"},"available":$available,"usedToday":$usedToday}"""

    private fun list(epoch: Long = 4, enabled: Boolean = false, dailyLimit: Int = 3, inquiries: String = "[]", available: Boolean = true) =
        200 to """{"privacyEpoch":$epoch,"consent":${consentJson(enabled, dailyLimit, available)},"inquiries":$inquiries}"""

    private fun receipt(epoch: Long = 4, enabled: Boolean, dailyLimit: Int = 3) =
        200 to """{"privacyEpoch":$epoch,"consent":${consentJson(enabled, dailyLimit)}}"""

    private val waiting = """{"inquiryId":"11111111-1111-4111-8111-111111111111","status":"waiting","requestedAt":"2026-09-24T10:00:00.000Z",
        "closedAt":null,"pairs":[],"reasons":[],"found":null}"""
    private val withdrawn = """{"inquiryId":"11111111-1111-4111-8111-111111111111","status":"withdrawn","requestedAt":"2026-09-24T10:00:00.000Z",
        "closedAt":"2026-09-24T10:01:00.000Z","pairs":[],"reasons":["consent_off"],"found":null}"""
    private val lost = TestHttpServer.HANG to ""
    private val staleEpoch = 409 to """{"error":"Consent privacy epoch is stale"}"""
    private val unauthorized = 401 to """{"error":"Unauthorized"}"""

    private fun body(server: TestHttpServer, index: Int) = JSONObject(server.requests[index].body)
    private fun loaded(model: InquiriesViewModel) = model.state.value as InquiriesState.Loaded

    private fun openLoaded(model: InquiriesViewModel) {
        model.open()
        awaitUntil { model.state.value is InquiriesState.Loaded }
    }

    @Test
    fun openingLoadsTheConsentAndWhatWasLookedFor() {
        TestHttpServer.open().use { server ->
            server.serve(list(enabled = true, dailyLimit = 5, inquiries = "[$waiting]"))
            val model = viewModel(server)
            assertEquals(InquiriesState.Loading, model.state.value)
            openLoaded(model)
            server.join()
            assertTrue(server.requests.single().requestLine.startsWith("GET /v1/inquiries "))
            val state = loaded(model)
            assertEquals(4L, state.response.privacyEpoch)
            assertTrue(state.response.consent.enabled)
            assertEquals(5, state.response.consent.dailyLimit)
            assertEquals("waiting", state.response.inquiries.single().status)
            assertEquals(ConsentChangeState.Idle, model.change.value)
        }
    }

    @Test
    fun turningItOnIsOneExplicitRequestAtTheLoadedEpochAndShowsTheServersAnswer() {
        TestHttpServer.open().use { server ->
            server.serve(list(epoch = 4, enabled = false, dailyLimit = 3), receipt(epoch = 4, enabled = true, dailyLimit = 3))
            val store = freshStore()
            val model = viewModel(server, store)
            openLoaded(model)

            server.holdAnswers()
            model.setEnabled(true)
            assertTrue("the change is working until the server answers", model.change.value is ConsentChangeState.Working)
            server.releaseAnswers()
            awaitUntil { loaded(model).response.consent.enabled && model.change.value == ConsentChangeState.Idle }
            server.join()

            assertTrue(server.requests[1].requestLine.startsWith("PUT /v1/inquiries/consent "))
            val sent = body(server, 1)
            assertEquals(true, sent.getBoolean("enabled"))
            assertEquals("the limit the reader saw is sent explicitly", 3, sent.getInt("dailyLimit"))
            assertEquals(4L, sent.getLong("expectedPrivacyEpoch"))
            assertTrue(Regex("^[0-9a-f-]{36}$").matches(sent.getString("clientRequestId")))
            assertNull("a confirmed change keeps no envelope", store.readPendingInquiryConsent())
            assertEquals("turning it on changes nothing already listed: no reload", 2, server.requests.size)
        }
    }

    @Test
    fun turningItOffReloadsTheListSoWhatItWithdrewShows() {
        TestHttpServer.open().use { server ->
            server.serve(list(enabled = true, inquiries = "[$waiting]"), receipt(enabled = false), list(enabled = false, inquiries = "[$withdrawn]"))
            val model = viewModel(server)
            openLoaded(model)
            model.setEnabled(false)
            awaitUntil { loaded(model).response.inquiries.singleOrNull()?.status == "withdrawn" }
            server.join()
            assertEquals(false, body(server, 1).getBoolean("enabled"))
            assertTrue(!loaded(model).response.consent.enabled)
        }
    }

    @Test
    fun aLostResponseKeepsTheWholeEnvelopeAndRetrySendsTheSameRequestAgain() {
        TestHttpServer.open().use { server ->
            server.serve(list(epoch = 4, enabled = false, dailyLimit = 3), lost, receipt(epoch = 4, enabled = true))
            val store = freshStore()
            val model = viewModel(server, store)
            openLoaded(model)

            model.setEnabled(true)
            awaitUntil { model.change.value is ConsentChangeState.Failed }
            val failed = model.change.value as ConsentChangeState.Failed
            assertTrue("an unconfirmed change may have landed: retry is offered", failed.canRetry)
            val pending = store.readPendingInquiryConsent()
            assertNotNull(pending)
            assertEquals(true, pending!!.enabled)
            assertEquals(4L, pending.expectedPrivacyEpoch)

            model.retryChange()
            awaitUntil { model.change.value == ConsentChangeState.Idle && loaded(model).response.consent.enabled }
            server.join()
            assertEquals(3, server.requests.size)
            val first = body(server, 1)
            val retry = body(server, 2)
            assertEquals("the retry reuses the client request id", first.getString("clientRequestId"), retry.getString("clientRequestId"))
            assertEquals(pending.clientRequestId, retry.getString("clientRequestId"))
            assertEquals("and exactly the same content and epoch", first.toString(), retry.toString())
            assertNull(store.readPendingInquiryConsent())
        }
    }

    @Test
    fun aServerErrorIsAmbiguousTooAndKeepsTheEnvelope() {
        TestHttpServer.open().use { server ->
            server.serve(list(), 503 to """{"error":"unavailable"}""")
            val store = freshStore()
            val model = viewModel(server, store)
            openLoaded(model)
            model.setEnabled(true)
            awaitUntil { model.change.value is ConsentChangeState.Failed }
            assertTrue((model.change.value as ConsentChangeState.Failed).canRetry)
            assertNotNull(store.readPendingInquiryConsent())
        }
    }

    @Test
    fun aStaleEpochIsNeverRetriedTheListReloadsAndTheChangeIsOfferedAgainAtTheCurrentEpoch() {
        TestHttpServer.open().use { server ->
            server.serve(list(epoch = 4, enabled = false), staleEpoch, list(epoch = 5, enabled = false), receipt(epoch = 5, enabled = true))
            val store = freshStore()
            val model = viewModel(server, store)
            openLoaded(model)

            model.setEnabled(true)
            awaitUntil { model.change.value is ConsentChangeState.Failed && loaded(model).response.privacyEpoch == 5L }
            assertTrue("a definitive refusal offers no retry of the stale request", !(model.change.value as ConsentChangeState.Failed).canRetry)
            assertNull("nothing is kept to re-send with its stale epoch", store.readPendingInquiryConsent())
            model.retryChange()
            assertEquals("retry has nothing to send", 3, server.requests.size)

            model.setEnabled(true)
            awaitUntil { model.change.value == ConsentChangeState.Idle && loaded(model).response.consent.enabled }
            server.join()
            assertEquals(4L, body(server, 1).getLong("expectedPrivacyEpoch"))
            assertEquals("the change offered again carries the current epoch", 5L, body(server, 3).getLong("expectedPrivacyEpoch"))
            assertNotEquals(body(server, 1).getString("clientRequestId"), body(server, 3).getString("clientRequestId"))
        }
    }

    @Test
    fun aRefusedRequestIsNotRetriedEither() {
        TestHttpServer.open().use { server ->
            server.serve(list(), 400 to """{"error":"Invalid consent request"}""")
            val store = freshStore()
            val model = viewModel(server, store)
            openLoaded(model)
            model.setEnabled(true)
            awaitUntil { model.change.value is ConsentChangeState.Failed }
            assertTrue(!(model.change.value as ConsentChangeState.Failed).canRetry)
            assertNull(store.readPendingInquiryConsent())
            server.join()
            assertEquals("a 400 is not a stale view: no reload", 2, server.requests.size)
        }
    }

    @Test
    fun a401OnTheListGoesToTheSignOutPathAndKeepsNothing() {
        TestHttpServer.open().use { server ->
            server.serve(unauthorized)
            var signalled = 0
            val store = freshStore()
            store.writePendingInquiryConsent(InquiryConsentRequest("55555555-5555-4555-8555-555555555555", true, 3, 4))
            val model = viewModel(server, store, onUnauthorized = { signalled += 1 })
            model.open()
            awaitUntil { model.state.value is InquiriesState.Unavailable }
            assertEquals(1, signalled)
            assertNull(store.readPendingInquiryConsent())
            assertEquals(ConsentChangeState.Idle, model.change.value)
        }
    }

    @Test
    fun a401OnAChangeGoesToTheSignOutPathAndKeepsNothing() {
        TestHttpServer.open().use { server ->
            server.serve(list(), unauthorized)
            var signalled = 0
            val store = freshStore()
            val model = viewModel(server, store, onUnauthorized = { signalled += 1 })
            openLoaded(model)
            model.setEnabled(true)
            awaitUntil { model.state.value is InquiriesState.Unavailable }
            assertEquals(1, signalled)
            assertNull(store.readPendingInquiryConsent())
            assertEquals(ConsentChangeState.Idle, model.change.value)
        }
    }

    /** The whole path: this screen's ApiClient reports the 401 the way every reader client does, and
     * the account view model -- the one owner of sign-out -- ends the session. */
    @Test
    fun a401SignsTheDeviceOutThroughTheAccountViewModel() {
        TestHttpServer.open().use { server ->
            server.serve(unauthorized)
            val store = freshStore()
            val vault = FakeSessionVault("session-1")
            val application = ApplicationProvider.getApplicationContext<Application>()
            val accountApi = ApiClient(server.baseUrl, "", maxAttempts = 1, credential = CredentialProvider { vault.readToken() }, onUnauthorized = {})
            val account = AccountViewModel(application, vault, accountApi, store, "", true)
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1,
                credential = CredentialProvider { selectCredential(vault.readToken(), "", true) }, onUnauthorized = SessionInvalidation::reportUnauthorized)
            val model = InquiriesViewModel(application, api, store)
            model.open()
            awaitUntil { account.authState.value is AuthState.SignedOut }
            assertEquals(SignedOutReason.SESSION_EXPIRED, account.signedOutReason.value)
            assertNull(vault.readToken())
        }
    }

    @Test
    fun aChangeFromAnEarlierProcessIsOfferedForRetryWithoutTouchingTheNetwork() {
        TestHttpServer.open().use { server ->
            server.serve(list(epoch = 4), receipt(epoch = 4, enabled = true, dailyLimit = 6))
            val store = freshStore()
            val earlier = InquiryConsentRequest("66666666-6666-4666-8666-666666666666", enabled = true, dailyLimit = 6, expectedPrivacyEpoch = 4)
            store.writePendingInquiryConsent(earlier)
            val model = viewModel(server, store)
            assertTrue((model.change.value as ConsentChangeState.Failed).canRetry)
            assertEquals(0, server.requests.size)

            openLoaded(model)
            assertTrue("same epoch: still offered", (model.change.value as? ConsentChangeState.Failed)?.canRetry == true)
            model.retryChange()
            awaitUntil { model.change.value == ConsentChangeState.Idle && loaded(model).response.consent.dailyLimit == 6 }
            server.join()
            val sent = body(server, 1)
            assertEquals(earlier.clientRequestId, sent.getString("clientRequestId"))
            assertEquals(6, sent.getInt("dailyLimit"))
            assertEquals(4L, sent.getLong("expectedPrivacyEpoch"))
        }
    }

    /** Clear and Reset start a new epoch with consent off: a change kept from the old epoch could
     * only be refused, and whatever consent was shown for it is gone. */
    @Test
    fun anEpochChangePurgesTheOldEpochsPendingChangeAndItsConsent() {
        TestHttpServer.open().use { server ->
            server.serve(list(epoch = 4, enabled = true, dailyLimit = 7), list(epoch = 5, enabled = false, dailyLimit = 3))
            val store = freshStore()
            val model = viewModel(server, store)
            openLoaded(model)
            assertTrue(loaded(model).response.consent.enabled)

            store.writePendingInquiryConsent(InquiryConsentRequest("77777777-7777-4777-8777-777777777777", false, 7, 4))
            model.refresh()
            awaitUntil { loaded(model).response.privacyEpoch == 5L }
            assertTrue(!loaded(model).response.consent.enabled)
            assertEquals(3, loaded(model).response.consent.dailyLimit)
            assertNull("the old epoch's change is dropped, never replayed", store.readPendingInquiryConsent())
            assertEquals(ConsentChangeState.Idle, model.change.value)
        }
    }

    @Test
    fun aRestoredChangeFromAnOlderEpochIsDroppedOnLoad() {
        TestHttpServer.open().use { server ->
            server.serve(list(epoch = 5))
            val store = freshStore()
            store.writePendingInquiryConsent(InquiryConsentRequest("88888888-8888-4888-8888-888888888888", true, 3, 4))
            val model = viewModel(server, store)
            openLoaded(model)
            assertNull(store.readPendingInquiryConsent())
            assertEquals(ConsentChangeState.Idle, model.change.value)
            model.retryChange()
            server.join()
            assertEquals(1, server.requests.size)
        }
    }

    @Test
    fun changingTheDailyLimitKeepsTheConsentAndSendsOnlyAnInRangeLimit() {
        TestHttpServer.open().use { server ->
            server.serve(list(enabled = true, dailyLimit = 3), receipt(enabled = true, dailyLimit = 4))
            val model = viewModel(server)
            openLoaded(model)
            model.setDailyLimit(0)
            model.setDailyLimit(11)
            assertEquals(ConsentChangeState.Idle, model.change.value)
            model.setDailyLimit(4)
            awaitUntil { loaded(model).response.consent.dailyLimit == 4 && model.change.value == ConsentChangeState.Idle }
            server.join()
            assertEquals(2, server.requests.size)
            assertEquals(true, body(server, 1).getBoolean("enabled"))
            assertEquals(4, body(server, 1).getInt("dailyLimit"))
        }
    }

    @Test
    fun aSecondChangeWhileOneIsWorkingIsIgnored() {
        TestHttpServer.open().use { server ->
            server.serve(list(), lost)
            val model = viewModel(server)
            openLoaded(model)
            model.setEnabled(true)
            model.setEnabled(true)
            model.setDailyLimit(5)
            awaitUntil { model.change.value is ConsentChangeState.Failed }
            server.join()
            assertEquals(2, server.requests.size)
        }
    }

    @Test
    fun aFailedRefreshKeepsWhatWasShownAndSaysSo() {
        TestHttpServer.open().use { server ->
            server.serve(list(enabled = true, inquiries = "[$waiting]"), 503 to """{"error":"unavailable"}""")
            val model = viewModel(server)
            openLoaded(model)
            model.refresh()
            awaitUntil { loaded(model).refreshFailed != null }
            assertEquals("waiting", loaded(model).response.inquiries.single().status)
            assertTrue(!loaded(model).refreshing)
        }
    }

    @Test
    fun aFailedFirstLoadOffersARetry() {
        TestHttpServer.open().use { server ->
            server.serve(503 to """{"error":"unavailable"}""", list())
            val model = viewModel(server)
            model.open()
            awaitUntil { model.state.value is InquiriesState.Unavailable }
            model.open()
            awaitUntil { model.state.value is InquiriesState.Loaded }
        }
    }

    /** The app obtains it through the standard factory (`viewModel()` in KnowScrollApp). */
    @Test
    fun theStandardViewModelFactoryCanCreateIt() {
        val application = ApplicationProvider.getApplicationContext<Application>()
        val created = androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.getInstance(application).create(InquiriesViewModel::class.java)
        assertNotNull(created)
    }
}
