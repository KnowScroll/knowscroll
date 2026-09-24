package com.knowscroll.mobile.ui.account

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.knowscroll.mobile.BuildConfig
import com.knowscroll.mobile.data.AccountDeletionRequest
import com.knowscroll.mobile.data.AndroidKeyStoreSessionVault
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.PrivacyLifecycleRequest
import com.knowscroll.mobile.data.PrivacyRecordingReceipt
import com.knowscroll.mobile.data.PrivacyResetRequest
import com.knowscroll.mobile.data.SessionInvalidation
import com.knowscroll.mobile.data.SessionVault
import com.knowscroll.mobile.data.StateStore
import com.knowscroll.mobile.data.VaultCredentialProvider
import com.knowscroll.mobile.data.parseSignInToken
import com.knowscroll.mobile.data.selectCredential
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

private const val INTENT_PAUSE = "pause"
private const val INTENT_RESUME = "resume"
private const val INTENT_EXPORT = "export"
private const val INTENT_RESET = "reset"
private const val INTENT_DELETE = "delete"
private val PRIVACY_INTENTS = listOf(INTENT_PAUSE, INTENT_RESUME, INTENT_EXPORT, INTENT_RESET, INTENT_DELETE)
internal const val PRIVACY_RETRY_MESSAGE =
    "The last attempt is unconfirmed. Retry checks the same request; nothing is repeated."

/**
 * #135: owns the device's real identity (sign-in) and the privacy-lifecycle parity screen. Kept
 * deliberately separate from [com.knowscroll.mobile.ui.AppViewModel] -- the reader's own giant
 * state machine -- since the two need no shared in-memory state: both read the same
 * [SessionVault]-backed credential fresh on every request, so a sign-in here is visible to the
 * reader's very next call with no extra wiring, and [SessionInvalidation] carries the one signal
 * that must cross between them (the reader's session died).
 */
class AccountViewModel @JvmOverloads constructor(
    application: Application,
    /** Test seam: a JVM test passes a [com.knowscroll.mobile.data.FakeSessionVault]. */
    private val vault: SessionVault = AndroidKeyStoreSessionVault(application),
    /** Test seam: a JVM test passes an `ApiClient` pointed at a fixture server. This screen's own
     * 401s are handled explicitly and completely below (each one decides its own
     * [SignedOutReason]), so the process-wide [SessionInvalidation] signal is disabled by default
     * here -- it would otherwise race this view model's own handling of the exact same event. */
    private val api: ApiClient = ApiClient(
        credential = VaultCredentialProvider(vault, BuildConfig.KS_DEV_TOKEN, BuildConfig.DEBUG),
        onUnauthorized = {},
    ),
    /** Test seam: a JVM test passes its own [StateStore] over a disposable context. */
    private val store: StateStore = StateStore(application),
    /** Test seams for the build's development-token fallback ([selectCredential]): the same two
     * values the reader's own [VaultCredentialProvider] is built from. */
    private val developmentToken: String = BuildConfig.KS_DEV_TOKEN,
    private val isDebugBuild: Boolean = BuildConfig.DEBUG,
) : AndroidViewModel(application) {

    private val _authState = MutableStateFlow(deriveAuthState())
    val authState = _authState.asStateFlow()
    private val _signedOutReason = MutableStateFlow<SignedOutReason?>(null)
    val signedOutReason = _signedOutReason.asStateFlow()

    private val _linkRequest = MutableStateFlow<LinkRequestState>(LinkRequestState.Idle)
    val linkRequest = _linkRequest.asStateFlow()
    private val _tokenSubmit = MutableStateFlow<TokenSubmitState>(TokenSubmitState.Idle)
    val tokenSubmit = _tokenSubmit.asStateFlow()

    private val _privacy = MutableStateFlow<PrivacyState>(PrivacyState.Loading)
    val privacy = _privacy.asStateFlow()
    private val _pause = MutableStateFlow(restoredOperationState(INTENT_PAUSE))
    val pause = _pause.asStateFlow()
    private val _resume = MutableStateFlow(restoredOperationState(INTENT_RESUME))
    val resume = _resume.asStateFlow()
    private val _export = MutableStateFlow<ExportState>(ExportState.Idle)
    val export = _export.asStateFlow()
    private val _reset = MutableStateFlow(restoredOperationState(INTENT_RESET))
    val reset = _reset.asStateFlow()
    private val _delete = MutableStateFlow(restoredOperationState(INTENT_DELETE))
    val delete = _delete.asStateFlow()
    private val _accountSignOut = MutableStateFlow<PrivacyOperationState>(PrivacyOperationState.Idle)
    val accountSignOut = _accountSignOut.asStateFlow()

    init {
        // The reader's own session (AppViewModel's ApiClient, the default onUnauthorized) just
        // died. A dev-token 401 never reaches here: the vault holds nothing for it.
        viewModelScope.launch {
            SessionInvalidation.events.collect {
                if (vault.readToken() != null) signOutLocally(SignedOutReason.SESSION_EXPIRED)
            }
        }
    }

    /** Exactly the credential the reader's own requests will use ([selectCredential]): the signed-in
     * session, or -- only in a debug build -- a non-blank development token. A debug build with a
     * development token (every journey except the owner one, whose build deliberately has none)
     * opens on the reader, as it did before sign-in existed. Once this device has been signed out
     * (either sign-out, Reset, deletion or an ended session -- [StateStore.readSignedOut]), the
     * development token is no way back in: that ended its session too, or it would reopen the
     * reader onto a session the owner just left. Only a new sign-in clears that. */
    private fun deriveAuthState(): AuthState {
        val developmentFallback = if (store.readSignedOut()) "" else developmentToken
        return if (selectCredential(vault.readToken(), developmentFallback, isDebugBuild) != null) AuthState.SignedIn
        else AuthState.SignedOut
    }

    private fun restoredOperationState(intent: String): PrivacyOperationState =
        if (store.readPendingPrivacyRequest(intent) != null) PrivacyOperationState.Failed(PRIVACY_RETRY_MESSAGE)
        else PrivacyOperationState.Idle

    /** Call on foreground/resume: a vault write from elsewhere in this process (a fresh sign-in
     * completing, or the reader's 401 handler clearing it) becomes visible here. */
    fun refresh() {
        _authState.value = deriveAuthState()
    }

    /** The reader's own "Sign out this device" (#91: its confirmation, persisted retry and all) has
     * ended the session and recorded it ([com.knowscroll.mobile.ui.recordDeviceSignedOut]: vault
     * cleared, device marked signed out). The app goes to the sign-in screen with the same reason
     * the Privacy screen's sign-out gives -- never the reader's old dead-end screen. */
    fun onReaderSignedOut() {
        // A reader instance that outlived its sign-out re-enters composition after a newer sign-in
        // still reporting it (until its own foreground revives it): the mark that sign-in cleared
        // says this report is stale.
        if (!store.readSignedOut()) return
        clearPrivacyViews()
        _signedOutReason.value = SignedOutReason.SIGNED_OUT
        _authState.value = deriveAuthState()
    }

    // ---- Sign-in (ADR-0026) -----------------------------------------------------------------

    fun requestLink(email: String) {
        if (_linkRequest.value is LinkRequestState.Sending) return
        _linkRequest.value = LinkRequestState.Sending
        viewModelScope.launch {
            try {
                api.requestMagicLink(email)
                _linkRequest.value = LinkRequestState.Sent
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _linkRequest.value = LinkRequestState.Failed(transportMessage(e))
            }
        }
    }

    fun resetLinkRequest() {
        if (_linkRequest.value !is LinkRequestState.Sending) _linkRequest.value = LinkRequestState.Idle
    }

    fun resetTokenSubmit() {
        if (_tokenSubmit.value !is TokenSubmitState.Submitting) _tokenSubmit.value = TokenSubmitState.Idle
    }

    /** [raw] is whatever the reader pasted -- the whole emailed link, ideally. [parseSignInToken]
     * rejects anything that is not a recognisable KnowScroll sign-in link before this ever
     * touches the network. */
    fun submitPastedLink(raw: String) {
        if (_tokenSubmit.value is TokenSubmitState.Submitting) return
        val token = parseSignInToken(raw)
        if (token == null) {
            _tokenSubmit.value = TokenSubmitState.InvalidLink(
                "That doesn't look like a KnowScroll sign-in link. Paste the whole link from the email."
            )
            return
        }
        _tokenSubmit.value = TokenSubmitState.Submitting
        viewModelScope.launch {
            try {
                val receipt = api.consumeSignInToken(token)
                // A new session is not the signed-out device any more: clear the mark (so a fresh
                // reader never opens on #91's dead end), any pending revoke and every earlier
                // privacy request (which would otherwise be retried against this new session) --
                // before the vault write, so a crash in between can never leave a live session
                // behind a stale mark.
                store.clearSignedOut()
                store.clearPendingSignOut()
                forgetPrivacyRequests()
                vault.writeToken(receipt.sessionToken)
                _tokenSubmit.value = TokenSubmitState.Idle
                _linkRequest.value = LinkRequestState.Idle
                _signedOutReason.value = null
                _authState.value = AuthState.SignedIn
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Server) {
                _tokenSubmit.value = TokenSubmitState.Failed(
                    if (e.statusCode == 401) "This link is no longer valid. Request a new one."
                    else transportMessage(e)
                )
            } catch (e: Exception) {
                _tokenSubmit.value = TokenSubmitState.Failed(transportMessage(e))
            }
        }
    }

    // ---- Privacy screen (ADR-0028/0030/0034/0035) --------------------------------------------

    /** Opens the Privacy screen: (re)loads the current recording/epoch state. Any operation left
     * pending from a previous process was already surfaced as [PrivacyOperationState.Failed] at
     * construction time (see [restoredOperationState]); this only refreshes what Pause/Resume and
     * the confirmations need to act on. */
    fun openPrivacy() {
        _privacy.value = PrivacyState.Loading
        viewModelScope.launch { refreshPrivacyState() }
    }

    private suspend fun refreshPrivacyState() {
        try {
            val universe = api.getUniverse()
            _privacy.value = PrivacyState.Loaded(universe.universeId, universe.recordingPausedAt, universe.privacyEpoch)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException.Server) {
            if (e.statusCode == 401) signOutLocally(SignedOutReason.SESSION_EXPIRED)
            else _privacy.value = PrivacyState.Unavailable(transportMessage(e))
        } catch (e: Exception) {
            _privacy.value = PrivacyState.Unavailable(transportMessage(e))
        }
    }

    fun retryPrivacyLoad() = openPrivacy()

    // ---- Pause / resume (no destructive confirmation -- ADR-0028) ----------------------------

    fun requestPause() {
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        if (_pause.value is PrivacyOperationState.Working) return
        beginPause(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    /** The same request again -- or, when nothing is kept (it was refused), a fresh one. */
    fun retryPause() {
        val pending = store.readPendingPrivacyRequest(INTENT_PAUSE) ?: return requestPause()
        beginPause(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginPause(requestId: String, epoch: Long) =
        beginRecordingChange(INTENT_PAUSE, requestId, epoch, _pause, api::pauseRecording)

    fun requestResume() {
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        if (_resume.value is PrivacyOperationState.Working) return
        beginResume(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    /** The same request again -- or, when nothing is kept (it was refused), a fresh one. */
    fun retryResume() {
        val pending = store.readPendingPrivacyRequest(INTENT_RESUME) ?: return requestResume()
        beginResume(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginResume(requestId: String, epoch: Long) =
        beginRecordingChange(INTENT_RESUME, requestId, epoch, _resume, api::resumeRecording)

    /** Pause and resume differ only in their route: each answers with the recording state it left. */
    private fun beginRecordingChange(
        intent: String, requestId: String, epoch: Long, state: MutableStateFlow<PrivacyOperationState>,
        send: suspend (PrivacyLifecycleRequest) -> PrivacyRecordingReceipt,
    ) {
        state.value = PrivacyOperationState.Working
        runLifecycleRequest(
            intent, requestId, epoch, send,
            succeeded = { receipt ->
                state.value = PrivacyOperationState.Idle
                (_privacy.value as? PrivacyState.Loaded)?.let {
                    _privacy.value = it.copy(recordingPausedAt = receipt.recordingPausedAt, privacyEpoch = receipt.privacyEpoch)
                }
            },
            failed = { state.value = PrivacyOperationState.Failed(it) },
        )
    }

    // ---- Export --------------------------------------------------------------------------

    fun requestExport() {
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        if (_export.value is ExportState.Working) return
        beginExport(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    /** The same request again -- or, when nothing is kept (it was refused), a fresh one. */
    fun retryExport() {
        val pending = store.readPendingPrivacyRequest(INTENT_EXPORT) ?: return requestExport()
        beginExport(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginExport(requestId: String, epoch: Long) {
        _export.value = ExportState.Working
        runLifecycleRequest(
            INTENT_EXPORT, requestId, epoch, api::exportUniverse,
            succeeded = { _export.value = ExportState.Ready(it) },
            failed = { _export.value = ExportState.Failed(it) },
        )
    }

    /**
     * Pause, resume and export: one request each, its envelope persisted before dispatch, which the
     * server replays when re-sent unchanged (ADR-0030). Only an ambiguous failure keeps it, for an
     * explicit retry of that same request. A definitive refusal -- a stale epoch (409), invalid
     * input -- applied nothing and never will: nothing is kept, a 409 reloads the screen, and the
     * next attempt is a fresh request at the epoch it shows (the rule Reset and Delete follow below,
     * and [InquiriesViewModel] for consent). A 401 ends the session.
     */
    private fun <T> runLifecycleRequest(
        intent: String, requestId: String, epoch: Long,
        send: suspend (PrivacyLifecycleRequest) -> T, succeeded: (T) -> Unit, failed: (String) -> Unit,
    ) {
        store.writePendingPrivacyRequest(intent, requestId, epoch)
        viewModelScope.launch {
            try {
                val result = send(PrivacyLifecycleRequest(requestId, epoch))
                store.clearPendingPrivacyRequest(intent)
                succeeded(result)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val refused = definitiveRefusal(e)
                if (e is ApiException.Server && e.statusCode == 401) {
                    signOutLocally(SignedOutReason.SESSION_EXPIRED)
                } else if (refused != null) {
                    store.clearPendingPrivacyRequest(intent)
                    failed(transportMessage(e))
                    if (refused == 409) openPrivacy()
                } else {
                    failed(transportMessage(e))
                }
            }
        }
    }

    /** Called once the export JSON has been handed off (saved via SAF, or its failure shown). */
    fun consumeExport() {
        if (_export.value is ExportState.Ready) _export.value = ExportState.Idle
    }

    // ---- Reset (ADR-0028/0030): deliberate confirmation, ends every session including this one --

    /** From Idle, or after a failure: a fresh confirmation at the current epoch (verification N1). */
    fun requestResetConfirmation() {
        if (_reset.value is PrivacyOperationState.Idle || _reset.value is PrivacyOperationState.Failed) _reset.value = PrivacyOperationState.Confirming
    }

    fun cancelReset() {
        if (_reset.value is PrivacyOperationState.Confirming) _reset.value = PrivacyOperationState.Idle
    }

    fun confirmReset() {
        if (_reset.value !is PrivacyOperationState.Confirming) return
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        beginReset(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    /** The same request again -- or, when nothing is kept (it was refused), a fresh confirmation. */
    fun retryReset() {
        val pending = store.readPendingPrivacyRequest(INTENT_RESET) ?: return requestResetConfirmation()
        beginReset(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginReset(requestId: String, epoch: Long) {
        _reset.value = PrivacyOperationState.Working
        // Reset revokes the caller's own session too (ADR-0030): a retry after a lost response
        // authenticates with an already-dead token and 401s before the server even re-reads the
        // requestId. Read exactly as account deletion's 401 is -- see [runSelfEndingRequest].
        runSelfEndingRequest(
            INTENT_RESET, requestId, epoch, _reset,
            send = { api.resetPersonalUniverse(PrivacyResetRequest(requestId, epoch)).epochAfter },
            done = SignedOutReason.RESET, endedBeforeSent = SignedOutReason.SESSION_ENDED_BEFORE_RESET,
        )
    }

    // ---- Delete account (ADR-0035): its own literal, removes more than Reset -------------------

    /** From Idle, or after a failure: a fresh confirmation at the current epoch (verification N1). */
    fun requestDeleteConfirmation() {
        if (_delete.value is PrivacyOperationState.Idle || _delete.value is PrivacyOperationState.Failed) _delete.value = PrivacyOperationState.Confirming
    }

    fun cancelDelete() {
        if (_delete.value is PrivacyOperationState.Confirming) _delete.value = PrivacyOperationState.Idle
    }

    fun confirmDelete() {
        if (_delete.value !is PrivacyOperationState.Confirming) return
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        beginDelete(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    /** The same request again -- or, when nothing is kept (it was refused), a fresh confirmation. */
    fun retryDelete() {
        val pending = store.readPendingPrivacyRequest(INTENT_DELETE) ?: return requestDeleteConfirmation()
        beginDelete(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginDelete(requestId: String, epoch: Long) {
        _delete.value = PrivacyOperationState.Working
        runSelfEndingRequest(
            INTENT_DELETE, requestId, epoch, _delete,
            send = { api.deleteAccount(AccountDeletionRequest(requestId, epoch)).epochAfter },
            done = SignedOutReason.ACCOUNT_DELETED, endedBeforeSent = SignedOutReason.SESSION_ENDED_BEFORE_DELETE,
        )
    }

    /**
     * Reset and account deletion both end the calling session, so there is no replay: a retry
     * after a lost response meets a 401, and so does a request sent by a session that had already
     * ended (expired, signed out or reset elsewhere) -- when nothing was applied at all. ADR-0035
     * section 5: the 401 is read as [done] only when an earlier attempt of this same [requestId]
     * may have been applied without its answer -- recorded in the persisted envelope
     * ([com.knowscroll.mobile.data.PendingPrivacyRequest]: a lost response or 5xx, or an attempt
     * still marked in flight, i.e. the process died with it), or reported by [ApiClient]'s own
     * in-call retry ([ApiException.mayHaveLanded]). Otherwise the session simply ended first:
     * [endedBeforeSent], and the account/history are untouched. Either way the dead session is
     * cleared and the app returns to sign-in.
     */
    private fun runSelfEndingRequest(
        intent: String, requestId: String, epoch: Long, state: MutableStateFlow<PrivacyOperationState>,
        send: suspend () -> Long, done: SignedOutReason, endedBeforeSent: SignedOutReason,
    ) {
        // Any earlier attempt of this intent that may have landed counts, whatever its request id: a
        // fresh confirmation after a lost response must not read a 401 as "never sent".
        val earlier = store.readPendingPrivacyRequest(intent)
        val earlierMayHaveLanded = earlier != null && (earlier.mayHaveLanded || earlier.inFlight)
        store.writePendingPrivacyRequest(intent, requestId, epoch, mayHaveLanded = earlierMayHaveLanded, inFlight = true)
        viewModelScope.launch {
            try {
                val epochAfter = send()
                store.clearPendingPrivacyRequest(intent)
                signOutLocally(done, epochAfter)
                state.value = PrivacyOperationState.Idle
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val refused = definitiveRefusal(e)
                if (e is ApiException.Server && e.statusCode == 401) {
                    store.clearPendingPrivacyRequest(intent)
                    signOutLocally(if (earlierMayHaveLanded || e.mayHaveLanded) done else endedBeforeSent)
                    state.value = PrivacyOperationState.Idle
                } else if (refused != null) {
                    // A definitive refusal (e.g. the epoch changed on another device) applied nothing,
                    // and this live session proves no earlier attempt did either: nothing is kept to
                    // retry with its stale epoch. The screen reloads and offers a fresh confirmation.
                    store.clearPendingPrivacyRequest(intent)
                    state.value = PrivacyOperationState.Failed(transportMessage(e))
                    if (refused == 409) openPrivacy()
                } else {
                    // Anything but a definitive refusal may have been applied: a later 401 for this
                    // same request then means it was.
                    val landed = earlierMayHaveLanded || (e !is ApiException) || e.mayHaveLanded
                    store.writePendingPrivacyRequest(intent, requestId, epoch, mayHaveLanded = landed, inFlight = false)
                    state.value = PrivacyOperationState.Failed(transportMessage(e))
                }
            }
        }
    }

    // ---- Sign out this device, from the Privacy screen -----------------------------------------

    fun requestSignOutConfirmation() {
        if (_accountSignOut.value is PrivacyOperationState.Idle) _accountSignOut.value = PrivacyOperationState.Confirming
    }

    fun cancelAccountSignOut() {
        if (_accountSignOut.value is PrivacyOperationState.Confirming) _accountSignOut.value = PrivacyOperationState.Idle
    }

    fun confirmAccountSignOut() {
        if (_accountSignOut.value is PrivacyOperationState.Confirming) performAccountSignOut()
    }

    fun retryAccountSignOut() {
        if (_accountSignOut.value is PrivacyOperationState.Failed) performAccountSignOut()
    }

    private fun performAccountSignOut() {
        _accountSignOut.value = PrivacyOperationState.Working
        viewModelScope.launch {
            try {
                api.revokeSession()
                signOutLocally(SignedOutReason.SIGNED_OUT)
                _accountSignOut.value = PrivacyOperationState.Idle
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Server) {
                if (e.statusCode == 401) { signOutLocally(SignedOutReason.SIGNED_OUT); _accountSignOut.value = PrivacyOperationState.Idle }
                else _accountSignOut.value = PrivacyOperationState.Failed(transportMessage(e))
            } catch (e: Exception) {
                _accountSignOut.value = PrivacyOperationState.Failed(transportMessage(e))
            }
        }
    }

    // ---- shared -----------------------------------------------------------------------------

    /** Clears the stored session and every local reader/navigation trace of it (reusing
     * [StateStore.purgePrivateState], the exact purge Clear History and the existing #91 sign-out
     * already rely on), then gates the app back to the sign-in screen with one honest reason.
     * [epoch], when known (Reset/Delete both return a fresh one), keeps the local watermark
     * correctly advanced; otherwise the last locally observed epoch is kept as-is. */
    private fun signOutLocally(reason: SignedOutReason, epoch: Long? = null) {
        // A session found ended while a Delete or Reset may have landed (a lost response, or the
        // process died with it in flight) ended because of it: ADR-0035 section 5, as in
        // [runSelfEndingRequest]. Either record belongs to the session now gone.
        val mayHaveLanded = { intent: String -> store.readPendingPrivacyRequest(intent)?.let { it.mayHaveLanded || it.inFlight } == true }
        val honest = when {
            reason != SignedOutReason.SESSION_EXPIRED -> reason
            mayHaveLanded(INTENT_DELETE) -> SignedOutReason.ACCOUNT_DELETED
            mayHaveLanded(INTENT_RESET) -> SignedOutReason.RESET
            else -> reason
        }
        forgetPrivacyRequests()
        vault.clear()
        val universeId = store.readObservedUniverseId()
        store.purgePrivateState(universeId, epoch ?: store.readObservedPrivacyEpoch())
        // Every path here ended (or found ended) the session a debug build's development token
        // would fall back to as well; see [deriveAuthState].
        store.writeSignedOut()
        clearPrivacyViews()
        _signedOutReason.value = honest
        _authState.value = AuthState.SignedOut
    }

    /** Every privacy request belongs to the session that sent it. An earlier session's is never this
     * one's to retry (verification N1) -- by then it may be another account's universe -- and the
     * Privacy screen reads what the server holds instead (#168). */
    private fun forgetPrivacyRequests() {
        PRIVACY_INTENTS.forEach(store::clearPendingPrivacyRequest)
        listOf(_pause, _resume, _reset, _delete).forEach { it.value = PrivacyOperationState.Idle }
        _export.value = ExportState.Idle
    }

    private fun clearPrivacyViews() {
        _privacy.value = PrivacyState.Loading
        _pause.value = PrivacyOperationState.Idle
        _resume.value = PrivacyOperationState.Idle
        _export.value = ExportState.Idle
    }

    private fun transportMessage(e: Exception): String = when {
        e is ApiException.Server && e.statusCode == 409 ->
            "This changed just before it was applied. Reopen Privacy to review the current state and try again."
        e is ApiException.MissingToken -> "You're not signed in."
        else -> "Connection interrupted. Please retry; your request is not repeated."
    }
}

/** The status of a refusal the server made outright -- any 4xx but an ended session (401), a timeout
 * (408) or a rate limit (429) -- or `null`. Nothing was applied, and the same request could only be
 * refused again. */
private fun definitiveRefusal(e: Exception): Int? =
    (e as? ApiException.Server)?.statusCode?.takeIf { it in 400..499 && it !in setOf(401, 408, 429) }
