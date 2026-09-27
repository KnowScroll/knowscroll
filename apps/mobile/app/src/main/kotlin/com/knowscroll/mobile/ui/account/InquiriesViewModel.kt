package com.knowscroll.mobile.ui.account

import android.app.Application
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.knowscroll.mobile.BuildConfig
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.AndroidKeyStoreSessionVault
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.INQUIRY_DAILY_LIMIT_MAX
import com.knowscroll.mobile.data.InquiriesResponse
import com.knowscroll.mobile.data.InquiryConsentRequest
import com.knowscroll.mobile.data.StateStore
import com.knowscroll.mobile.data.VaultCredentialProvider
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * #132 (ADR-0038): the Privacy & account screen's "Look for connections between my places" --
 * the reader's standing consent, its daily limit and what KnowScroll looked for. Its own small view
 * model beside [AccountViewModel], which it needs nothing from: the credential is read fresh per
 * request, and a 401 reaches the app's one sign-out path through the process-wide
 * [com.knowscroll.mobile.data.SessionInvalidation] signal this screen's [ApiClient] reports to, as
 * every reader client does ([AccountViewModel] ends the session and returns to sign-in).
 *
 * A consent change is one explicit request whose whole envelope (client request id, content, the
 * epoch it was sent with) is persisted before dispatch. Only an ambiguous failure keeps it, for an
 * explicit retry of that same request, which the server replays. A definitive refusal -- a stale
 * epoch or a reused key (409), invalid input (400) -- applied nothing and never will: nothing is
 * kept, the list reloads, and the change is offered again at the current epoch (the model #135's
 * review fixed for Delete/Reset in [AccountViewModel]'s `runSelfEndingRequest`). Clear and Reset
 * start a new epoch with consent off: an envelope or consent from another epoch is purged.
 */
class InquiriesViewModel @JvmOverloads constructor(
    application: Application,
    /** Test seam: a JVM test passes an `ApiClient` pointed at a fixture server. */
    private val api: ApiClient = ApiClient(
        credential = VaultCredentialProvider(AndroidKeyStoreSessionVault(application), BuildConfig.KS_DEV_TOKEN, BuildConfig.DEBUG),
    ),
    /** Test seam: a JVM test passes its own [StateStore] over a disposable context. */
    private val store: StateStore = StateStore(application),
) : AndroidViewModel(application) {

    private val _state = MutableStateFlow<InquiriesState>(InquiriesState.Loading)
    val state = _state.asStateFlow()
    // A change left pending by an earlier process is offered for retry without touching the network.
    private val _change = MutableStateFlow<ConsentChangeState>(
        if (store.readPendingInquiryConsent() != null) ConsentChangeState.Failed(text(R.string.inquiry_change_unconfirmed), canRetry = true)
        else ConsentChangeState.Idle,
    )
    val change = _change.asStateFlow()
    private var loadJob: Job? = null

    /** Opening the screen: always reads the server afresh. */
    fun open() {
        _state.value = InquiriesState.Loading
        load()
    }

    /** The reader's explicit refresh; what is shown stays until the new list arrives. */
    fun refresh() {
        val loaded = _state.value as? InquiriesState.Loaded ?: return open()
        if (loaded.refreshing) return
        _state.value = loaded.copy(refreshing = true, refreshFailed = null)
        load()
    }

    private fun load() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            try {
                show(api.getInquiries())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                when {
                    e is ApiException.MissingToken || (e is ApiException.Server && e.statusCode == 401) -> sessionEnded()
                    else -> loadFailed(if (e is ApiException.Protocol) R.string.inquiry_unreadable else R.string.inquiry_load_failed)
                }
            }
        }
    }

    private fun show(response: InquiriesResponse) {
        // A change kept from another epoch could only be refused: dropped, never replayed. (One
        // still in flight settles itself -- see [changeFailed].)
        val pending = store.readPendingInquiryConsent()
        if (pending != null && pending.expectedPrivacyEpoch != response.privacyEpoch && _change.value !is ConsentChangeState.Working) {
            store.clearPendingInquiryConsent()
            _change.value = ConsentChangeState.Idle
        }
        _state.value = InquiriesState.Loaded(response)
    }

    private fun loadFailed(@StringRes message: Int) {
        val loaded = _state.value as? InquiriesState.Loaded
        _state.value = loaded?.copy(refreshing = false, refreshFailed = text(R.string.inquiry_refresh_failed))
            ?: InquiriesState.Unavailable(text(message))
    }

    fun retryLoad() = open()

    // ---- Consent changes ----------------------------------------------------------------------

    fun setEnabled(enabled: Boolean) {
        val loaded = _state.value as? InquiriesState.Loaded ?: return
        requestChange(loaded, enabled, loaded.response.consent.dailyLimit)
    }

    /** Only while looking is on (the limit applies to it), and only within 1..10. */
    fun setDailyLimit(limit: Int) {
        val loaded = _state.value as? InquiriesState.Loaded ?: return
        val consent = loaded.response.consent
        if (!consent.enabled || limit !in 1..INQUIRY_DAILY_LIMIT_MAX || limit == consent.dailyLimit) return
        requestChange(loaded, enabled = true, limit)
    }

    /** The same request again -- never a new one, and nothing when nothing is kept. */
    fun retryChange() {
        if (_change.value is ConsentChangeState.Working) return
        val pending = store.readPendingInquiryConsent() ?: return
        send(pending)
    }

    private fun requestChange(loaded: InquiriesState.Loaded, enabled: Boolean, dailyLimit: Int) {
        if (_change.value is ConsentChangeState.Working) return
        // The limit the reader sees is sent explicitly, at the epoch the screen shows.
        send(InquiryConsentRequest(UUID.randomUUID().toString(), enabled, dailyLimit, loaded.response.privacyEpoch))
    }

    private fun send(req: InquiryConsentRequest) {
        store.writePendingInquiryConsent(req)
        _change.value = ConsentChangeState.Working(req.enabled, req.dailyLimit)
        viewModelScope.launch {
            try {
                val receipt = api.putInquiryConsent(req)
                store.clearPendingInquiryConsent()
                _change.value = ConsentChangeState.Idle
                val loaded = _state.value as? InquiriesState.Loaded
                if (loaded != null && loaded.response.privacyEpoch == receipt.privacyEpoch) {
                    _state.value = loaded.copy(response = loaded.response.copy(consent = receipt.consent))
                    // Turning it off withdrew whatever was not yet sent: show that.
                    if (!receipt.consent.enabled) refresh()
                } else {
                    // The screen moved to another epoch meanwhile: its consent is not this receipt's.
                    refresh()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                changeFailed(req, e)
            }
        }
    }

    private fun changeFailed(req: InquiryConsentRequest, e: Exception) {
        when {
            e is ApiException.MissingToken || (e is ApiException.Server && e.statusCode == 401) -> sessionEnded()
            e is ApiException.Server && e.statusCode in 400..499 && e.statusCode != 408 && e.statusCode != 429 -> {
                // Definitive: nothing was applied and a re-send could only be refused again.
                store.clearPendingInquiryConsent()
                val conflict = e.statusCode == 409
                _change.value = ConsentChangeState.Failed(text(if (conflict) R.string.inquiry_change_conflict else R.string.inquiry_change_refused), canRetry = false)
                if (conflict) refresh()
            }
            else -> {
                val shownEpoch = (_state.value as? InquiriesState.Loaded)?.response?.privacyEpoch
                if (shownEpoch != null && shownEpoch != req.expectedPrivacyEpoch) {
                    // The epoch moved on while it was in flight: whatever happened, there is nothing to retry.
                    store.clearPendingInquiryConsent()
                    _change.value = ConsentChangeState.Idle
                } else {
                    _change.value = ConsentChangeState.Failed(text(R.string.inquiry_change_unconfirmed), canRetry = true)
                }
            }
        }
    }

    /** The session is gone. The 401 was already reported through [ApiClient]'s `onUnauthorized` (the
     * app-wide signal [AccountViewModel] signs out on); nothing of the dead session is kept here. */
    private fun sessionEnded() {
        store.clearPendingInquiryConsent()
        _change.value = ConsentChangeState.Idle
        _state.value = InquiriesState.Unavailable(text(R.string.inquiry_session_ended))
    }

    private fun text(@StringRes id: Int): String = getApplication<Application>().getString(id)
}
