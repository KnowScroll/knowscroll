package com.knowscroll.mobile.ui.account

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.CredentialProvider
import com.knowscroll.mobile.data.FakeSessionVault
import com.knowscroll.mobile.data.SessionInvalidation
import com.knowscroll.mobile.data.StateStore
import com.knowscroll.mobile.data.TestHttpServer
import com.knowscroll.mobile.data.awaitUntil
import com.knowscroll.mobile.data.selectCredential
import com.knowscroll.mobile.ui.SignOutState
import com.knowscroll.mobile.ui.recordDeviceSignedOut
import com.knowscroll.mobile.ui.signOutRestoreState
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #135: AccountViewModel's flows against a fake (fixture) API -- see `TestHttpServer` and
 * `awaitUntil` (Robolectric's main looper must be pumped for a `viewModelScope` continuation to
 * ever land, since this project has no `kotlinx-coroutines-test`; the wire shapes themselves are
 * already covered directly in `AccountApiTest`).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AccountViewModelTest {
    private companion object {
        /** `TestHttpServer.HANG` stands for a response that never arrives; a short read timeout
         * notices it quickly. Only the tests that serve one use it (#177). */
        const val LOST_RESPONSE_READ_TIMEOUT_MS = 700
    }

    private fun freshContext(): android.content.Context {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        return context
    }

    /** [developmentToken] defaults to none -- the owner build's shape -- so no test here depends on
     * whatever development token the local Gradle build happened to bake into BuildConfig.
     * [readTimeoutMs] is the app's own unless a test serves a lost response: an answer a loaded
     * host delays past a short timeout would otherwise fail as if it were lost (#177). */
    private fun viewModel(
        server: TestHttpServer,
        vault: FakeSessionVault = FakeSessionVault("session-1"),
        store: StateStore = StateStore(freshContext()),
        developmentToken: String = "",
        isDebugBuild: Boolean = true,
        maxAttempts: Int = 1,
        readTimeoutMs: Int = ApiClient.DEFAULT_READ_TIMEOUT_MS,
    ): AccountViewModel {
        val application = ApplicationProvider.getApplicationContext<Application>()
        val credential = CredentialProvider { selectCredential(vault.readToken(), developmentToken, isDebugBuild) }
        val api = ApiClient(server.baseUrl, "", readTimeoutMs = readTimeoutMs, maxAttempts = maxAttempts, credential = credential, onUnauthorized = {})
        return AccountViewModel(application, vault, api, store, developmentToken, isDebugBuild)
    }

    // ---- Finding 1: a debug build's development token still counts (every non-owner journey) ----

    @Test
    fun aDebugBuildWithADevelopmentTokenAndNoSignInOpensOnTheReaderNotTheSignInScreen() {
        TestHttpServer.open().use { server ->
            val model = viewModel(server, FakeSessionVault(), developmentToken = "d".repeat(64), isDebugBuild = true)
            assertEquals(AuthState.SignedIn, model.authState.value)
            model.refresh() // what every foreground does
            assertEquals(AuthState.SignedIn, model.authState.value)
            assertEquals(0, server.requests.size)
        }
    }

    @Test
    fun theOwnerJourneyBuildWithNoDevelopmentTokenStillOpensOnTheSignInScreen() {
        TestHttpServer.open().use { server ->
            assertEquals(AuthState.SignedOut, viewModel(server, FakeSessionVault(), developmentToken = "", isDebugBuild = true).authState.value)
            assertEquals(AuthState.SignedOut, viewModel(server, FakeSessionVault(), developmentToken = "   ", isDebugBuild = true).authState.value)
        }
    }

    @Test
    fun aReleaseBuildNeverCountsADevelopmentToken() {
        TestHttpServer.open().use { server ->
            assertEquals(AuthState.SignedOut, viewModel(server, FakeSessionVault(), developmentToken = "d".repeat(64), isDebugBuild = false).authState.value)
        }
    }

    @Test
    fun aMalformedPastedLinkIsRejectedWithoutAnyNetworkCall() {
        TestHttpServer.open().use { server ->
            val model = viewModel(server)
            model.submitPastedLink("not a link")
            assertTrue(model.tokenSubmit.value is TokenSubmitState.InvalidLink)
            assertEquals(0, server.requests.size)
        }
    }

    @Test
    fun signInFlowRequestsALinkThenConsumesAPastedOneAndBecomesSignedIn() {
        TestHttpServer.open().use { server ->
            server.serve(
                202 to """{"status":"requested"}""",
                200 to """{"sessionToken":"session-1","sessionId":"s1","deviceId":"d1","universeId":"u1",
                    "privacyEpoch":0,"expiresAt":"2026-10-01T00:00:00Z","accountId":"a1","origin":"magic_link"}""",
            )
            val vault = FakeSessionVault()
            val model = viewModel(server, vault)
            assertEquals(AuthState.SignedOut, model.authState.value)

            model.requestLink("owner@knowscroll.test")
            awaitUntil { model.linkRequest.value is LinkRequestState.Sent }

            model.submitPastedLink("https://knowscroll.test/sign-in#token=raw-token")
            awaitUntil { model.authState.value is AuthState.SignedIn }
            server.join()

            assertEquals("session-1", vault.readToken())
            val sessionRequest = server.requests[1]
            assertEquals("raw-token", JSONObject(sessionRequest.body).getString("token"))
        }
    }

    @Test
    fun openPrivacyLoadsTheCurrentRecordingAndEpoch() {
        TestHttpServer.open().use { server ->
            server.serve(200 to """{"universeId":"u1","revision":1,"privacyEpoch":5,"traces":[],"capabilities":{},"recordingPausedAt":null}""")
            val model = viewModel(server)
            model.openPrivacy()
            awaitUntil { model.privacy.value is PrivacyState.Loaded }
            val loaded = model.privacy.value as PrivacyState.Loaded
            assertEquals("u1", loaded.universeId)
            assertEquals(5L, loaded.privacyEpoch)
            assertNull(loaded.recordingPausedAt)
        }
    }

    @Test
    fun pauseSucceedsAndUpdatesTheRecordingState() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"universeId":"u1","revision":1,"privacyEpoch":5,"traces":[],"capabilities":{},"recordingPausedAt":null}""",
                200 to """{"receiptId":"r1","action":"pause","privacyEpoch":5,"recordingPausedAt":"2026-09-24T00:00:00Z","appliedAt":"2026-09-24T00:00:00Z"}""",
            )
            val model = viewModel(server)
            model.openPrivacy()
            awaitUntil { model.privacy.value is PrivacyState.Loaded }

            model.requestPause()
            awaitUntil { model.pause.value is PrivacyOperationState.Idle && (model.privacy.value as? PrivacyState.Loaded)?.recordingPausedAt != null }
            server.join()
            assertEquals("2026-09-24T00:00:00Z", (model.privacy.value as PrivacyState.Loaded).recordingPausedAt)
        }
    }

    /** An uncertain failure (a 5xx may follow a commit behind a proxy); a refusal is the #168 tests below. */
    @Test
    fun aFailedPausePersistsItsRequestAndAnExplicitRetryReusesTheSameOne() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"universeId":"u1","revision":1,"privacyEpoch":5,"traces":[],"capabilities":{},"recordingPausedAt":null}""",
                503 to """{"error":"unavailable"}""",
                200 to """{"receiptId":"r1","action":"pause","privacyEpoch":5,"recordingPausedAt":"2026-09-24T00:00:00Z","appliedAt":"2026-09-24T00:00:00Z"}""",
            )
            val store = StateStore(freshContext())
            val model = viewModel(server, store = store)
            model.openPrivacy()
            awaitUntil { model.privacy.value is PrivacyState.Loaded }

            model.requestPause()
            awaitUntil { model.pause.value is PrivacyOperationState.Failed }
            val pending = store.readPendingPrivacyRequest("pause")
            assertNotNull("a failed pause keeps its retry envelope", pending)

            model.retryPause()
            awaitUntil { model.pause.value is PrivacyOperationState.Idle }
            server.join()

            assertEquals(3, server.requests.size)
            val firstRequestId = JSONObject(server.requests[1].body).getString("requestId")
            val retryRequestId = JSONObject(server.requests[2].body).getString("requestId")
            assertEquals("a retry must reuse the exact same requestId", firstRequestId, retryRequestId)
            assertEquals(pending!!.requestId, retryRequestId)
            assertNull("a succeeded retry clears its pending envelope", store.readPendingPrivacyRequest("pause"))
        }
    }

    @Test
    fun confirmingResetEndsTheCallersOwnSessionAndReturnsToSignIn() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"universeId":"u1","revision":1,"privacyEpoch":5,"traces":[],"capabilities":{},"recordingPausedAt":null}""",
                200 to """{"receiptId":"r1","epochBefore":5,"epochAfter":6,"sessionsRevoked":2,"resetAt":"2026-09-24T00:00:00Z"}""",
            )
            val vault = FakeSessionVault("session-1")
            val model = viewModel(server, vault)
            model.openPrivacy()
            awaitUntil { model.privacy.value is PrivacyState.Loaded }

            model.requestResetConfirmation()
            assertEquals(PrivacyOperationState.Confirming, model.reset.value)
            model.confirmReset()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()

            assertEquals(SignedOutReason.RESET, model.signedOutReason.value)
            assertNull("Reset must clear the stored session too", vault.readToken())
            assertEquals("reset-personal-universe", JSONObject(server.requests[1].body).getString("confirmation"))
        }
    }

    @Test
    fun confirmingDeleteEndsTheSessionWithTheAccountDeletedMessage() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"universeId":"u1","revision":1,"privacyEpoch":5,"traces":[],"capabilities":{},"recordingPausedAt":null}""",
                200 to """{"receiptId":"r1","epochBefore":5,"epochAfter":6,"sessionsDeleted":2,"deletedAt":"2026-09-24T00:00:00Z"}""",
            )
            val vault = FakeSessionVault("session-1")
            val model = viewModel(server, vault)
            model.openPrivacy()
            awaitUntil { model.privacy.value is PrivacyState.Loaded }

            model.requestDeleteConfirmation()
            model.confirmDelete()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()

            assertEquals(SignedOutReason.ACCOUNT_DELETED, model.signedOutReason.value)
            assertNull(vault.readToken())
            assertEquals("delete-my-account-and-history", JSONObject(server.requests[1].body).getString("confirmation"))
        }
    }

    // ---- Finding 2: a 401 means "deleted"/"reset" only when an earlier attempt may have landed ----

    private val universeAt5 = 200 to """{"universeId":"u1","revision":1,"privacyEpoch":5,"traces":[],"capabilities":{},"recordingPausedAt":null}"""
    private val unauthorized = 401 to """{"error":"Unauthorized"}"""
    private val lostResponse = TestHttpServer.HANG to ""

    private fun openLoadedPrivacy(model: AccountViewModel) {
        model.openPrivacy()
        awaitUntil { model.privacy.value is PrivacyState.Loaded }
    }

    private fun requestIdOf(server: TestHttpServer, index: Int) = JSONObject(server.requests[index].body).getString("requestId")

    @Test
    fun a401OnTheFirstDeletionAttemptIsNeverReportedAsADeletion() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, unauthorized)
            val store = StateStore(freshContext())
            val vault = FakeSessionVault("session-1")
            val model = viewModel(server, vault, store)
            openLoadedPrivacy(model)

            model.requestDeleteConfirmation()
            model.confirmDelete()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()

            assertEquals(SignedOutReason.SESSION_ENDED_BEFORE_DELETE, model.signedOutReason.value)
            assertNull("the dead session is still cleared", vault.readToken())
            assertEquals(PrivacyOperationState.Idle, model.delete.value)
            assertNull(store.readPendingPrivacyRequest("delete"))
        }
    }

    @Test
    fun aTimeoutThenA401OnTheRetryWithTheSameRequestIsReportedAsDeleted() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, lostResponse, unauthorized)
            val store = StateStore(freshContext())
            val vault = FakeSessionVault("session-1")
            val model = viewModel(server, vault, store, readTimeoutMs = LOST_RESPONSE_READ_TIMEOUT_MS)
            openLoadedPrivacy(model)

            model.requestDeleteConfirmation()
            model.confirmDelete()
            awaitUntil { model.delete.value is PrivacyOperationState.Failed }
            assertEquals(AuthState.SignedIn, model.authState.value)

            model.retryDelete()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()

            assertEquals(SignedOutReason.ACCOUNT_DELETED, model.signedOutReason.value)
            assertEquals("the retry is the same request", requestIdOf(server, 1), requestIdOf(server, 2))
            assertNull(store.readPendingPrivacyRequest("delete"))
        }
    }

    @Test
    fun aLostResponseInsideTheSameCallThenA401IsReportedAsDeleted() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, lostResponse, unauthorized)
            val model = viewModel(server, FakeSessionVault("session-1"), maxAttempts = 2, readTimeoutMs = LOST_RESPONSE_READ_TIMEOUT_MS)
            openLoadedPrivacy(model)

            model.requestDeleteConfirmation()
            model.confirmDelete() // ApiClient's own retry answers 401
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()
            assertEquals(SignedOutReason.ACCOUNT_DELETED, model.signedOutReason.value)
        }
    }

    @Test
    fun aDeletionInFlightWhenTheProcessDiedThenA401OnRetryIsReportedAsDeleted() {
        TestHttpServer.open().use { server ->
            server.serve(unauthorized)
            val store = StateStore(freshContext())
            store.writePendingPrivacyRequest("delete", "earlier-request", 5, inFlight = true)
            val model = viewModel(server, FakeSessionVault("session-1"), store)
            assertTrue(model.delete.value is PrivacyOperationState.Failed)

            model.retryDelete()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()
            assertEquals(SignedOutReason.ACCOUNT_DELETED, model.signedOutReason.value)
            assertEquals("earlier-request", requestIdOf(server, 0))
        }
    }

    @Test
    fun aDefinitiveRefusalThenAnEndedSessionIsNeverReportedAsDeleted() {
        TestHttpServer.open().use { server ->
            // The refusal reloads Privacy (verification N1); that reload meets the ended session.
            server.serve(universeAt5, 409 to """{"error":"stale epoch"}""", unauthorized)
            val model = viewModel(server, FakeSessionVault("session-1"))
            openLoadedPrivacy(model)

            model.requestDeleteConfirmation()
            model.confirmDelete()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()
            assertEquals(SignedOutReason.SESSION_EXPIRED, model.signedOutReason.value)
        }
    }

    @Test
    fun retryAfterARefusalReopensTheConfirmationInsteadOfDoingNothing() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, 409 to """{"error":"stale epoch"}""", universeAt6)
            val model = viewModel(server, FakeSessionVault("session-1"))
            openLoadedPrivacy(model)
            model.requestDeleteConfirmation()
            model.confirmDelete()
            awaitUntil { model.delete.value is PrivacyOperationState.Failed }
            model.retryDelete()
            assertEquals(PrivacyOperationState.Confirming, model.delete.value)
        }
    }

    @Test
    fun a401OnTheFirstResetAttemptIsNeverReportedAsAReset() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, unauthorized)
            val store = StateStore(freshContext())
            val model = viewModel(server, FakeSessionVault("session-1"), store)
            openLoadedPrivacy(model)

            model.requestResetConfirmation()
            model.confirmReset()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()
            assertEquals(SignedOutReason.SESSION_ENDED_BEFORE_RESET, model.signedOutReason.value)
            assertEquals(PrivacyOperationState.Idle, model.reset.value)
            assertNull(store.readPendingPrivacyRequest("reset"))
        }
    }

    @Test
    fun aTimeoutThenA401OnTheResetRetryIsReportedAsReset() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, lostResponse, unauthorized)
            val model = viewModel(server, FakeSessionVault("session-1"), readTimeoutMs = LOST_RESPONSE_READ_TIMEOUT_MS)
            openLoadedPrivacy(model)

            model.requestResetConfirmation()
            model.confirmReset()
            awaitUntil { model.reset.value is PrivacyOperationState.Failed }
            model.retryReset()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()
            assertEquals(SignedOutReason.RESET, model.signedOutReason.value)
            assertEquals(requestIdOf(server, 1), requestIdOf(server, 2))
        }
    }

    @Test
    fun aPendingOperationFromAnEarlierProcessIsOfferedForRetryWithoutTouchingTheNetwork() {
        val context = freshContext()
        StateStore(context).writePendingPrivacyRequest("reset", "earlier-request", 3)
        val application = ApplicationProvider.getApplicationContext<Application>()
        val vault = FakeSessionVault("session-1")
        // No server is ever opened: construction alone must not touch the network.
        val api = ApiClient("http://127.0.0.1:1", "", maxAttempts = 1, credential = CredentialProvider { "x" }, onUnauthorized = {})
        val model = AccountViewModel(application, vault, api, StateStore(context))
        assertTrue(model.reset.value is PrivacyOperationState.Failed)
    }

    @Test
    fun aReaderSessionDyingElsewhereSignsThisScreenOutTooWithTheSessionExpiredReason() {
        TestHttpServer.open().use { server ->
            val vault = FakeSessionVault("session-1")
            val model = viewModel(server, vault)
            assertEquals(AuthState.SignedIn, model.authState.value)
            SessionInvalidation.reportUnauthorized()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            assertEquals(SignedOutReason.SESSION_EXPIRED, model.signedOutReason.value)
            assertNull(vault.readToken())
        }
    }

    // ---- Finding 3: "Sign out this device" leaves the app on sign-in, and signing in again works ----

    @Test
    fun theReadersSignOutLeavesTheAppOnTheSignInScreenNotTheDeadEnd() {
        TestHttpServer.open().use { server ->
            val store = StateStore(freshContext())
            val vault = FakeSessionVault("session-1")
            val model = viewModel(server, vault, store)
            assertEquals(AuthState.SignedIn, model.authState.value)

            // Exactly what AppViewModel.completeSignOut records once its revoke is confirmed.
            recordDeviceSignedOut(store, vault)
            model.onReaderSignedOut()

            assertNull("the revoked session must not stay in the vault", vault.readToken())
            assertEquals(AuthState.SignedOut, model.authState.value)
            assertEquals(SignedOutReason.SIGNED_OUT, model.signedOutReason.value)
            model.refresh() // every foreground, and a restart, re-derive from the same storage
            assertEquals(AuthState.SignedOut, model.authState.value)
        }
    }

    @Test
    fun aDebugBuildsRevokedDevelopmentTokenDoesNotReopenTheReadersDeadEnd() {
        TestHttpServer.open().use { server ->
            val store = StateStore(freshContext())
            val vault = FakeSessionVault()
            val model = viewModel(server, vault, store, developmentToken = "d".repeat(64))
            assertEquals(AuthState.SignedIn, model.authState.value)

            recordDeviceSignedOut(store, vault)
            model.onReaderSignedOut()
            assertEquals(AuthState.SignedOut, model.authState.value)
            model.refresh()
            assertEquals("the revoked development token is no way back in", AuthState.SignedOut, model.authState.value)
        }
    }

    @Test
    fun thePrivacyScreensSignOutInADebugBuildAlsoStaysOnSignIn() {
        TestHttpServer.open().use { server ->
            server.serve(204 to "")
            val store = StateStore(freshContext())
            val model = viewModel(server, FakeSessionVault(), store, developmentToken = "d".repeat(64))
            model.requestSignOutConfirmation()
            model.confirmAccountSignOut()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()
            model.refresh()
            assertEquals(AuthState.SignedOut, model.authState.value)
        }
    }

    @Test
    fun signingInAgainClearsTheStaleSignedOutFlagsSoTheReaderOpensNormally() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"sessionToken":"session-2","sessionId":"s2","deviceId":"d2","universeId":"u1",
                    "privacyEpoch":0,"expiresAt":"2026-10-01T00:00:00Z","accountId":"a1","origin":"magic_link"}""",
            )
            val store = StateStore(freshContext())
            store.writeSignedOut()
            store.writePendingSignOut()
            val vault = FakeSessionVault()
            val model = viewModel(server, vault, store, developmentToken = "d".repeat(64))
            assertEquals(AuthState.SignedOut, model.authState.value)

            model.submitPastedLink("https://knowscroll.test/sign-in#token=raw-token")
            awaitUntil { model.authState.value is AuthState.SignedIn }
            server.join()

            assertEquals("session-2", vault.readToken())
            assertFalse("a new sign-in is not the signed-out device any more", store.readSignedOut())
            assertFalse("an old pending revoke must never be retried against the new session", store.readPendingSignOut())
            // A reader created now (a cold start) opens normally, not on #91's dead end.
            assertEquals(SignOutState.Idle, signOutRestoreState(store.readPendingSignOut(), store.readSignedOut()))
        }
    }

    /** The reader's view model can outlive its sign-out; after a new sign-in it re-enters composition
     * still holding its old SignedOut for a moment (until its foreground revives it). That stale
     * report must not touch the new session. */
    @Test
    fun aStaleReaderSignOutReportAfterANewSignInLeavesTheNewSessionAlone() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"sessionToken":"session-2","sessionId":"s2","deviceId":"d2","universeId":"u1",
                    "privacyEpoch":0,"expiresAt":"2026-10-01T00:00:00Z","accountId":"a1","origin":"magic_link"}""",
            )
            val store = StateStore(freshContext())
            val vault = FakeSessionVault("session-1")
            val model = viewModel(server, vault, store)
            recordDeviceSignedOut(store, vault)
            model.onReaderSignedOut()
            model.submitPastedLink("https://knowscroll.test/sign-in#token=raw-token")
            awaitUntil { model.authState.value is AuthState.SignedIn }
            server.join()

            model.onReaderSignedOut() // the stale reader instance, recomposed
            assertEquals(AuthState.SignedIn, model.authState.value)
            assertNull("no sign-out reason is pending for a signed-in device", model.signedOutReason.value)
            assertEquals("session-2", vault.readToken())
        }
    }

    /** #177: under host load the fixture's answer can come later than a lost-response test's short
     * read timeout; a sign-in that is answered, however late, must still sign in. */
    @Test
    fun aSignInAnsweredLateByALoadedHostStillSignsIn() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"sessionToken":"session-2","sessionId":"s2","deviceId":"d2","universeId":"u1",
                    "privacyEpoch":0,"expiresAt":"2026-10-01T00:00:00Z","accountId":"a1","origin":"magic_link"}""",
            )
            val vault = FakeSessionVault()
            val model = viewModel(server, vault)
            server.holdAnswers()
            val lateAnswer = kotlin.concurrent.thread { Thread.sleep(LOST_RESPONSE_READ_TIMEOUT_MS + 300L); server.releaseAnswers() }
            model.submitPastedLink("https://knowscroll.test/sign-in#token=raw-token")
            awaitUntil { model.authState.value is AuthState.SignedIn }
            lateAnswer.join()
            server.join()
            assertEquals("session-2", vault.readToken())
        }
    }

    /** The app obtains this view model through the standard factory (`viewModel()` in
     * KnowScrollApp), which needs an `(Application)` constructor; the device journey found that
     * missing (the app crashed at launch). */
    @Test
    fun theStandardViewModelFactoryCanCreateIt() {
        val application = ApplicationProvider.getApplicationContext<Application>()
        val created = androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.getInstance(application).create(AccountViewModel::class.java)
        assertNotNull(created)
    }

    // ---- Verification review N1: a refused Delete/Reset never leaves a stuck, stale request ----

    private val universeAt6 = 200 to """{"universeId":"u1","revision":2,"privacyEpoch":6,"traces":[],"capabilities":{},"recordingPausedAt":null}"""
    private val epochChanged = 409 to """{"error":"Privacy epoch changed"}"""

    @Test
    fun aRefusedDeletionIsNotRetriedWithItsStaleEpochAndCanBeConfirmedAgainAtTheCurrentOne() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, epochChanged, universeAt6,
                200 to """{"receiptId":"r1","epochBefore":6,"epochAfter":7,"sessionsDeleted":1,"deletedAt":"2026-09-24T00:00:00Z"}""")
            val store = StateStore(freshContext())
            val model = viewModel(server, FakeSessionVault("session-1"), store)
            openLoadedPrivacy(model)

            model.requestDeleteConfirmation()
            model.confirmDelete()
            awaitUntil { model.delete.value is PrivacyOperationState.Failed }
            assertNull("a definitive refusal applied nothing: no request is kept to retry", store.readPendingPrivacyRequest("delete"))
            awaitUntil { (model.privacy.value as? PrivacyState.Loaded)?.privacyEpoch == 6L }

            model.requestDeleteConfirmation()
            assertEquals(PrivacyOperationState.Confirming, model.delete.value)
            model.confirmDelete()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()
            assertEquals(6L, JSONObject(server.requests[3].body).getLong("expectedPrivacyEpoch"))
            assertEquals(SignedOutReason.ACCOUNT_DELETED, model.signedOutReason.value)
        }
    }

    @Test
    fun aRefusedResetIsNotRetriedWithItsStaleEpoch() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, epochChanged, universeAt6)
            val store = StateStore(freshContext())
            val model = viewModel(server, FakeSessionVault("session-1"), store)
            openLoadedPrivacy(model)
            model.requestResetConfirmation()
            model.confirmReset()
            awaitUntil { model.reset.value is PrivacyOperationState.Failed }
            assertNull(store.readPendingPrivacyRequest("reset"))
            model.requestResetConfirmation()
            assertEquals(PrivacyOperationState.Confirming, model.reset.value)
        }
    }

    @Test
    fun aDeletionStillInFlightWhenTheProcessDiedThenAnEndedSessionIsReportedAsDeleted() {
        TestHttpServer.open().use { server ->
            val store = StateStore(freshContext())
            store.writePendingPrivacyRequest("delete", "req-1", 5, mayHaveLanded = false, inFlight = true)
            val vault = FakeSessionVault("session-1")
            val model = viewModel(server, vault, store)
            // The reader's first request after the restart meets a 401 (the deletion landed).
            SessionInvalidation.reportUnauthorized()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            assertEquals(SignedOutReason.ACCOUNT_DELETED, model.signedOutReason.value)
            assertNull(store.readPendingPrivacyRequest("delete"))
        }
    }

    @Test
    fun aNewSignInClearsAnEarlierSessionsPendingResetAndDelete() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"sessionToken":"session-2","sessionId":"s2","deviceId":"d2","universeId":"u1",
                    "privacyEpoch":0,"expiresAt":"2026-10-01T00:00:00Z","accountId":"a1","origin":"magic_link"}""",
            )
            val store = StateStore(freshContext())
            store.writePendingPrivacyRequest("delete", "req-1", 5, mayHaveLanded = true, inFlight = false)
            store.writePendingPrivacyRequest("reset", "req-2", 5, mayHaveLanded = false, inFlight = false)
            store.writeSignedOut()
            val model = viewModel(server, FakeSessionVault(), store)
            model.submitPastedLink("https://knowscroll.test/sign-in#token=raw-token")
            awaitUntil { model.authState.value is AuthState.SignedIn }
            server.join()
            assertNull(store.readPendingPrivacyRequest("delete"))
            assertNull(store.readPendingPrivacyRequest("reset"))
            assertEquals(PrivacyOperationState.Idle, model.delete.value)
            assertEquals(PrivacyOperationState.Idle, model.reset.value)
        }
    }

    // ---- #168 (ADR-0047): an opened App Link ----

    private val openedLink = "https://links.knowscroll.example/sign-in#token=raw-token"

    /** The link opens the confirmation, never the consumption (ADR-0026 section 3): it waits in the
     * sign-in field for the reader's tap, and nothing is sent. */
    @Test
    fun anOpenedLinkWaitsForTheReaderAndSendsNothing() {
        TestHttpServer.open().use { server ->
            val model = viewModel(server, FakeSessionVault())
            model.receiveSignInLink(openedLink)
            assertEquals(openedLink, model.receivedLink.value)
            assertEquals(AuthState.SignedOut, model.authState.value)
            assertEquals(0, server.requests.size)
        }
    }

    @Test
    fun aSignedInDeviceIgnoresAnOpenedLink() {
        TestHttpServer.open().use { server ->
            val model = viewModel(server, FakeSessionVault("session-1"))
            model.receiveSignInLink(openedLink)
            assertNull(model.receivedLink.value)
        }
    }

    /** Once used, the link is spent: a later sign-out must not offer it again. */
    @Test
    fun signingInWithTheOpenedLinkForgetsIt() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"sessionToken":"session-2","sessionId":"s2","deviceId":"d2","universeId":"u1",
                    "privacyEpoch":0,"expiresAt":"2026-10-01T00:00:00Z","accountId":"a1","origin":"magic_link"}""",
            )
            val model = viewModel(server, FakeSessionVault())
            model.receiveSignInLink(openedLink)
            model.submitPastedLink(openedLink)
            awaitUntil { model.authState.value is AuthState.SignedIn }
            server.join()
            assertNull(model.receivedLink.value)
            assertEquals("raw-token", JSONObject(server.requests[0].body).getString("token"))
        }
    }

    /** An expired, used or unknown token is one indistinguishable 401 (ADR-0026 section 3). */
    @Test
    fun anExpiredOrUsedLinkSaysSoAndLeavesTheDeviceSignedOut() {
        TestHttpServer.open().use { server ->
            server.serve(unauthorized)
            val vault = FakeSessionVault()
            val model = viewModel(server, vault)
            model.submitPastedLink(openedLink)
            awaitUntil { model.tokenSubmit.value is TokenSubmitState.Failed }
            assertEquals(TokenSubmitState.Failed("This link is no longer valid. Request a new one."), model.tokenSubmit.value)
            assertEquals(AuthState.SignedOut, model.authState.value)
            assertNull(vault.readToken())
        }
    }

    // ---- #168: a pause, resume or export belongs to the session that sent it ----

    private val lifecycleIntents = listOf("pause", "resume", "export")

    /** The session ended with a pause, resume and export unconfirmed. None of them is the next
     * session's to retry -- that may be another account's universe -- and Privacy reads the real
     * recording state again anyway. */
    @Test
    fun aSessionThatEndsTakesItsUnconfirmedPauseResumeAndExportWithIt() {
        TestHttpServer.open().use { server ->
            server.serve(unauthorized)
            val store = StateStore(freshContext())
            lifecycleIntents.forEach { store.writePendingPrivacyRequest(it, "earlier-$it", 5, mayHaveLanded = true) }
            val model = viewModel(server, FakeSessionVault("session-1"), store)
            model.openPrivacy()
            awaitUntil { model.authState.value is AuthState.SignedOut }
            server.join()

            lifecycleIntents.forEach { assertNull("the ended session's $it", store.readPendingPrivacyRequest(it)) }
            val nextProcess = viewModel(server, FakeSessionVault(), store)
            assertEquals(PrivacyOperationState.Idle, nextProcess.pause.value)
            assertEquals(PrivacyOperationState.Idle, nextProcess.resume.value)
        }
    }

    /** The reader's own sign-out (#91) ends a session without passing through this view model; the
     * new sign-in still leaves nothing of the earlier one to retry. */
    @Test
    fun aNewSignInClearsAnEarlierSessionsPendingPauseResumeAndExport() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"sessionToken":"session-2","sessionId":"s2","deviceId":"d2","universeId":"u2",
                    "privacyEpoch":0,"expiresAt":"2026-10-01T00:00:00Z","accountId":"a2","origin":"magic_link"}""",
            )
            val store = StateStore(freshContext())
            lifecycleIntents.forEach { store.writePendingPrivacyRequest(it, "earlier-$it", 5) }
            store.writeSignedOut()
            val model = viewModel(server, FakeSessionVault(), store)
            assertTrue("offered as an earlier process left it", model.pause.value is PrivacyOperationState.Failed)

            model.submitPastedLink("https://knowscroll.test/sign-in#token=raw-token")
            awaitUntil { model.authState.value is AuthState.SignedIn }
            server.join()

            lifecycleIntents.forEach { assertNull("the earlier session's $it", store.readPendingPrivacyRequest(it)) }
            assertEquals(PrivacyOperationState.Idle, model.pause.value)
            assertEquals(PrivacyOperationState.Idle, model.resume.value)
            model.retryPause() // nothing kept, and Privacy not loaded: nothing is sent
            assertEquals(1, server.snapshot().size)
        }
    }

    // ---- #168: an export is done only when its file holds it ----

    @Test
    fun anExportThatNeverReachedItsFileIsReportedAndRetryExportsAgain() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, 200 to """{"receiptId":"e1","privacyEpoch":5}""", 200 to """{"receiptId":"e2","privacyEpoch":5}""")
            val model = viewModel(server, FakeSessionVault("session-1"))
            openLoadedPrivacy(model)
            model.requestExport()
            awaitUntil { model.export.value is ExportState.Ready }

            model.exportNotSaved()
            assertTrue("never shown as done", model.export.value is ExportState.Failed)
            model.retryExport()
            awaitUntil { model.export.value is ExportState.Ready }
            server.join()
            assertEquals(3, server.requests.size)
        }
    }

    /** The process died while the picker was open; its answer reaches a new view model, which never
     * held the export. */
    @Test
    fun anExportLostWithTheProcessIsReportedToTheNextOne() {
        TestHttpServer.open().use { server ->
            val model = viewModel(server, FakeSessionVault("session-1"))
            model.exportNotSaved()
            assertTrue(model.export.value is ExportState.Failed)
            assertEquals(0, server.requests.size)
        }
    }

    // ---- #168: a refused pause, resume or export is never re-sent with its stale epoch ----

    private val pausedAt5 = 200 to """{"universeId":"u1","revision":1,"privacyEpoch":5,"traces":[],"capabilities":{},"recordingPausedAt":"2026-09-24T00:00:00Z"}"""
    private val pausedAt6 = 200 to """{"universeId":"u1","revision":2,"privacyEpoch":6,"traces":[],"capabilities":{},"recordingPausedAt":"2026-09-24T00:00:00Z"}"""

    /** A 409 (the epoch moved on, e.g. Clear on another device) applied nothing, and the same request
     * could only be refused again: nothing is kept, Privacy reloads, and Retry asks afresh at the
     * epoch the screen now shows. */
    @Test
    fun aRefusedPauseKeepsNothingAndRetryAsksAgainAtTheCurrentEpoch() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, epochChanged, universeAt6,
                200 to """{"receiptId":"r1","action":"pause","privacyEpoch":6,"recordingPausedAt":"2026-09-25T00:00:00Z","appliedAt":"2026-09-25T00:00:00Z"}""")
            val store = StateStore(freshContext())
            val model = viewModel(server, FakeSessionVault("session-1"), store)
            openLoadedPrivacy(model)

            model.requestPause()
            awaitUntil { model.pause.value is PrivacyOperationState.Failed }
            assertNull("a refusal applied nothing: no request is kept to retry", store.readPendingPrivacyRequest("pause"))
            awaitUntil { (model.privacy.value as? PrivacyState.Loaded)?.privacyEpoch == 6L }

            model.retryPause()
            awaitUntil { model.pause.value is PrivacyOperationState.Idle }
            server.join()
            assertEquals(6L, JSONObject(server.requests[3].body).getLong("expectedPrivacyEpoch"))
            assertTrue("a fresh request, never the refused one", requestIdOf(server, 3) != requestIdOf(server, 1))
        }
    }

    @Test
    fun aRefusedResumeKeepsNothingAndRetryAsksAgainAtTheCurrentEpoch() {
        TestHttpServer.open().use { server ->
            server.serve(pausedAt5, epochChanged, pausedAt6,
                200 to """{"receiptId":"r1","action":"resume","privacyEpoch":6,"recordingPausedAt":null,"appliedAt":"2026-09-25T00:00:00Z"}""")
            val store = StateStore(freshContext())
            val model = viewModel(server, FakeSessionVault("session-1"), store)
            openLoadedPrivacy(model)

            model.requestResume()
            awaitUntil { model.resume.value is PrivacyOperationState.Failed }
            assertNull(store.readPendingPrivacyRequest("resume"))
            awaitUntil { (model.privacy.value as? PrivacyState.Loaded)?.privacyEpoch == 6L }

            model.retryResume()
            awaitUntil { model.resume.value is PrivacyOperationState.Idle && (model.privacy.value as PrivacyState.Loaded).recordingPausedAt == null }
            server.join()
            assertEquals(6L, JSONObject(server.requests[3].body).getLong("expectedPrivacyEpoch"))
            assertTrue(requestIdOf(server, 3) != requestIdOf(server, 1))
        }
    }

    @Test
    fun aRefusedExportKeepsNothingAndRetryExportsAtTheCurrentEpoch() {
        TestHttpServer.open().use { server ->
            server.serve(universeAt5, epochChanged, universeAt6, 200 to """{"receiptId":"e1","privacyEpoch":6}""")
            val store = StateStore(freshContext())
            val model = viewModel(server, FakeSessionVault("session-1"), store)
            openLoadedPrivacy(model)

            model.requestExport()
            awaitUntil { model.export.value is ExportState.Failed }
            assertNull(store.readPendingPrivacyRequest("export"))
            awaitUntil { (model.privacy.value as? PrivacyState.Loaded)?.privacyEpoch == 6L }

            model.retryExport()
            awaitUntil { model.export.value is ExportState.Ready }
            server.join()
            assertEquals(6L, JSONObject(server.requests[3].body).getLong("expectedPrivacyEpoch"))
            assertTrue(requestIdOf(server, 3) != requestIdOf(server, 1))
        }
    }

}
