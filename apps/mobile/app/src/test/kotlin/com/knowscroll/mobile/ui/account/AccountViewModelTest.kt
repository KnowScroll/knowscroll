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
    private fun freshContext(): android.content.Context {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        return context
    }

    /** [developmentToken] defaults to none -- the owner build's shape -- so no test here depends on
     * whatever development token the local Gradle build happened to bake into BuildConfig. */
    private fun viewModel(
        server: TestHttpServer,
        vault: FakeSessionVault = FakeSessionVault("session-1"),
        store: StateStore = StateStore(freshContext()),
        developmentToken: String = "",
        isDebugBuild: Boolean = true,
        maxAttempts: Int = 1,
    ): AccountViewModel {
        val application = ApplicationProvider.getApplicationContext<Application>()
        val credential = CredentialProvider { selectCredential(vault.readToken(), developmentToken, isDebugBuild) }
        // A short read timeout: `TestHttpServer.HANG` stands for a response that never arrives.
        val api = ApiClient(server.baseUrl, "", readTimeoutMs = 700, maxAttempts = maxAttempts, credential = credential, onUnauthorized = {})
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

    @Test
    fun aFailedPausePersistsItsRequestAndAnExplicitRetryReusesTheSameOne() {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"universeId":"u1","revision":1,"privacyEpoch":5,"traces":[],"capabilities":{},"recordingPausedAt":null}""",
                409 to """{"error":"stale epoch"}""",
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
            val model = viewModel(server, vault, store)
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
            val model = viewModel(server, FakeSessionVault("session-1"), maxAttempts = 2)
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
            val model = viewModel(server, FakeSessionVault("session-1"))
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

}
