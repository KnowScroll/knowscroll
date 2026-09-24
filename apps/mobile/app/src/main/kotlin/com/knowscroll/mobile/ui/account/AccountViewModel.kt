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
import com.knowscroll.mobile.data.PrivacyResetRequest
import com.knowscroll.mobile.data.SessionInvalidation
import com.knowscroll.mobile.data.SessionVault
import com.knowscroll.mobile.data.StateStore
import com.knowscroll.mobile.data.VaultCredentialProvider
import com.knowscroll.mobile.data.parseSignInToken
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
class AccountViewModel(
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

    private fun deriveAuthState(): AuthState =
        if (vault.readToken() != null) AuthState.SignedIn else AuthState.SignedOut

    private fun restoredOperationState(intent: String): PrivacyOperationState =
        if (store.readPendingPrivacyRequest(intent) != null) PrivacyOperationState.Failed(PRIVACY_RETRY_MESSAGE)
        else PrivacyOperationState.Idle

    /** Call on foreground/resume: a vault write from elsewhere in this process (a fresh sign-in
     * completing, or the reader's 401 handler clearing it) becomes visible here. */
    fun refresh() {
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

    fun retryPause() {
        val pending = store.readPendingPrivacyRequest(INTENT_PAUSE) ?: return
        beginPause(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginPause(requestId: String, epoch: Long) {
        store.writePendingPrivacyRequest(INTENT_PAUSE, requestId, epoch)
        _pause.value = PrivacyOperationState.Working
        viewModelScope.launch {
            try {
                val receipt = api.pauseRecording(PrivacyLifecycleRequest(requestId, epoch))
                store.clearPendingPrivacyRequest(INTENT_PAUSE)
                _pause.value = PrivacyOperationState.Idle
                (_privacy.value as? PrivacyState.Loaded)?.let {
                    _privacy.value = it.copy(recordingPausedAt = receipt.recordingPausedAt, privacyEpoch = receipt.privacyEpoch)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Server) {
                if (e.statusCode == 401) { signOutLocally(SignedOutReason.SESSION_EXPIRED); _pause.value = PrivacyOperationState.Idle }
                else _pause.value = PrivacyOperationState.Failed(transportMessage(e))
            } catch (e: Exception) {
                _pause.value = PrivacyOperationState.Failed(transportMessage(e))
            }
        }
    }

    fun requestResume() {
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        if (_resume.value is PrivacyOperationState.Working) return
        beginResume(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    fun retryResume() {
        val pending = store.readPendingPrivacyRequest(INTENT_RESUME) ?: return
        beginResume(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginResume(requestId: String, epoch: Long) {
        store.writePendingPrivacyRequest(INTENT_RESUME, requestId, epoch)
        _resume.value = PrivacyOperationState.Working
        viewModelScope.launch {
            try {
                val receipt = api.resumeRecording(PrivacyLifecycleRequest(requestId, epoch))
                store.clearPendingPrivacyRequest(INTENT_RESUME)
                _resume.value = PrivacyOperationState.Idle
                (_privacy.value as? PrivacyState.Loaded)?.let {
                    _privacy.value = it.copy(recordingPausedAt = receipt.recordingPausedAt, privacyEpoch = receipt.privacyEpoch)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Server) {
                if (e.statusCode == 401) { signOutLocally(SignedOutReason.SESSION_EXPIRED); _resume.value = PrivacyOperationState.Idle }
                else _resume.value = PrivacyOperationState.Failed(transportMessage(e))
            } catch (e: Exception) {
                _resume.value = PrivacyOperationState.Failed(transportMessage(e))
            }
        }
    }

    // ---- Export --------------------------------------------------------------------------

    fun requestExport() {
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        if (_export.value is ExportState.Working) return
        beginExport(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    fun retryExport() {
        val pending = store.readPendingPrivacyRequest(INTENT_EXPORT) ?: return
        beginExport(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginExport(requestId: String, epoch: Long) {
        store.writePendingPrivacyRequest(INTENT_EXPORT, requestId, epoch)
        _export.value = ExportState.Working
        viewModelScope.launch {
            try {
                val json = api.exportUniverse(PrivacyLifecycleRequest(requestId, epoch))
                store.clearPendingPrivacyRequest(INTENT_EXPORT)
                _export.value = ExportState.Ready(json)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Server) {
                if (e.statusCode == 401) { signOutLocally(SignedOutReason.SESSION_EXPIRED); _export.value = ExportState.Idle }
                else _export.value = ExportState.Failed(transportMessage(e))
            } catch (e: Exception) {
                _export.value = ExportState.Failed(transportMessage(e))
            }
        }
    }

    /** Called once the export JSON has been handed off (saved via SAF, or its failure shown). */
    fun consumeExport() {
        if (_export.value is ExportState.Ready) _export.value = ExportState.Idle
    }

    // ---- Reset (ADR-0028/0030): deliberate confirmation, ends every session including this one --

    fun requestResetConfirmation() {
        if (_reset.value is PrivacyOperationState.Idle) _reset.value = PrivacyOperationState.Confirming
    }

    fun cancelReset() {
        if (_reset.value is PrivacyOperationState.Confirming) _reset.value = PrivacyOperationState.Idle
    }

    fun confirmReset() {
        if (_reset.value !is PrivacyOperationState.Confirming) return
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        beginReset(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    fun retryReset() {
        val pending = store.readPendingPrivacyRequest(INTENT_RESET) ?: return
        beginReset(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginReset(requestId: String, epoch: Long) {
        store.writePendingPrivacyRequest(INTENT_RESET, requestId, epoch)
        _reset.value = PrivacyOperationState.Working
        viewModelScope.launch {
            try {
                val receipt = api.resetPersonalUniverse(PrivacyResetRequest(requestId, epoch))
                store.clearPendingPrivacyRequest(INTENT_RESET)
                signOutLocally(SignedOutReason.RESET, receipt.epochAfter)
                _reset.value = PrivacyOperationState.Idle
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Server) {
                // Reset revokes the caller's own session too (ADR-0030): a retry after a lost
                // response authenticates with an already-dead token and 401s before the server
                // even re-reads the requestId. Treated the same honest way as account deletion.
                if (e.statusCode == 401) { store.clearPendingPrivacyRequest(INTENT_RESET); signOutLocally(SignedOutReason.RESET); _reset.value = PrivacyOperationState.Idle }
                else _reset.value = PrivacyOperationState.Failed(transportMessage(e))
            } catch (e: Exception) {
                _reset.value = PrivacyOperationState.Failed(transportMessage(e))
            }
        }
    }

    // ---- Delete account (ADR-0035): its own literal, removes more than Reset -------------------

    fun requestDeleteConfirmation() {
        if (_delete.value is PrivacyOperationState.Idle) _delete.value = PrivacyOperationState.Confirming
    }

    fun cancelDelete() {
        if (_delete.value is PrivacyOperationState.Confirming) _delete.value = PrivacyOperationState.Idle
    }

    fun confirmDelete() {
        if (_delete.value !is PrivacyOperationState.Confirming) return
        val loaded = _privacy.value as? PrivacyState.Loaded ?: return
        beginDelete(UUID.randomUUID().toString(), loaded.privacyEpoch)
    }

    fun retryDelete() {
        val pending = store.readPendingPrivacyRequest(INTENT_DELETE) ?: return
        beginDelete(pending.requestId, pending.expectedPrivacyEpoch)
    }

    private fun beginDelete(requestId: String, epoch: Long) {
        store.writePendingPrivacyRequest(INTENT_DELETE, requestId, epoch)
        _delete.value = PrivacyOperationState.Working
        viewModelScope.launch {
            try {
                val receipt = api.deleteAccount(AccountDeletionRequest(requestId, epoch))
                store.clearPendingPrivacyRequest(INTENT_DELETE)
                signOutLocally(SignedOutReason.ACCOUNT_DELETED, receipt.epochAfter)
                _delete.value = PrivacyOperationState.Idle
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Server) {
                // ADR-0035 section 5: a client that sent a deletion and receives 401 treats
                // itself as signed out either way -- a lost response is not a failed deletion.
                if (e.statusCode == 401) { store.clearPendingPrivacyRequest(INTENT_DELETE); signOutLocally(SignedOutReason.ACCOUNT_DELETED); _delete.value = PrivacyOperationState.Idle }
                else _delete.value = PrivacyOperationState.Failed(transportMessage(e))
            } catch (e: Exception) {
                _delete.value = PrivacyOperationState.Failed(transportMessage(e))
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
        vault.clear()
        val universeId = store.readObservedUniverseId()
        store.purgePrivateState(universeId, epoch ?: store.readObservedPrivacyEpoch())
        _privacy.value = PrivacyState.Loading
        _pause.value = PrivacyOperationState.Idle
        _resume.value = PrivacyOperationState.Idle
        _export.value = ExportState.Idle
        _signedOutReason.value = reason
        _authState.value = AuthState.SignedOut
    }

    private fun transportMessage(e: Exception): String = when {
        e is ApiException.Server && e.statusCode == 409 ->
            "This changed just before it was applied. Reopen Privacy to review the current state and try again."
        e is ApiException.MissingToken -> "You're not signed in."
        else -> "Connection interrupted. Please retry; your request is not repeated."
    }
}
