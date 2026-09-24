package com.knowscroll.mobile.ui.keep

import android.app.Application
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.knowscroll.mobile.BuildConfig
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.AndroidKeyStoreSessionVault
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.AwayAcknowledgeRequest
import com.knowscroll.mobile.data.ConnectionFeedbackRequest
import com.knowscroll.mobile.data.RelicKeepRequest
import com.knowscroll.mobile.data.RelicReleaseRequest
import com.knowscroll.mobile.data.RelicsResponse
import com.knowscroll.mobile.data.VaultCredentialProvider
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** How a failed request ends (#134): the session is gone; a definitive refusal (a 409 conflict --
 * stale epoch, reused key, recording paused -- or another 4xx) that applied nothing and never
 * will; or an outcome this client cannot know (a lost response, a 5xx, a 408/429, an unreadable
 * answer), which keeps the same request for an explicit retry. */
internal enum class ReturnFailure { SessionEnded, Conflict, Refused, Unconfirmed }

internal fun returnFailure(e: Exception): ReturnFailure = when {
    e is ApiException.MissingToken || (e is ApiException.Server && e.statusCode == 401) -> ReturnFailure.SessionEnded
    e is ApiException.Server && e.statusCode == 409 -> ReturnFailure.Conflict
    e is ApiException.Server && e.statusCode in 400..499 && e.statusCode != 408 && e.statusCode != 429 -> ReturnFailure.Refused
    else -> ReturnFailure.Unconfirmed
}

/**
 * #134 (ADR-0039): the return and Relics -- "While you were away" on the Atlas and the Relics
 * above Keep's Traces. One small view model shared by both, created once in `KnowScrollApp` like
 * [com.knowscroll.mobile.ui.account.InquiriesViewModel], which it mirrors: the credential is read
 * fresh per request, and a 401 reaches the app's one sign-out path through the process-wide
 * [com.knowscroll.mobile.data.SessionInvalidation] signal this [ApiClient] reports to.
 *
 * Each action ("Mark as seen", "Keep", "Seems wrong", "Let go") is one explicit request with a
 * client request id generated once per intent. A failure that may have landed keeps that same
 * request, in memory, for an explicit retry the server replays; a definitive refusal is surfaced,
 * nothing is kept, and what is current is read again. In memory is enough: acknowledging only moves
 * a marker forward, and keeping or objecting are replay-safe server-side, so a request lost with the
 * process is simply offered again from the lists. Anything kept from another epoch (Clear, Reset)
 * could only be refused, so it is dropped when a list shows the epoch moved.
 */
class ReturnViewModel @JvmOverloads constructor(
    application: Application,
    /** Test seam: a JVM test passes an `ApiClient` pointed at a fixture server. */
    private val api: ApiClient = ApiClient(
        credential = VaultCredentialProvider(AndroidKeyStoreSessionVault(application), BuildConfig.KS_DEV_TOKEN, BuildConfig.DEBUG),
    ),
) : AndroidViewModel(application) {

    private val _away = MutableStateFlow<AwayState>(AwayState.Loading)
    val away = _away.asStateFlow()
    private val _relics = MutableStateFlow<RelicsState>(RelicsState.Loading)
    val relics = _relics.asStateFlow()
    private val _acknowledge = MutableStateFlow<ReturnActionState>(ReturnActionState.Idle)
    val acknowledge = _acknowledge.asStateFlow()
    /** By bridge id. */
    private val _connections = MutableStateFlow<Map<String, ConnectionState>>(emptyMap())
    val connections = _connections.asStateFlow()
    /** "Let go", by Relic id. */
    private val _releases = MutableStateFlow<Map<String, ReturnActionState>>(emptyMap())
    val releases = _releases.asStateFlow()

    private var pendingAcknowledge: AwayAcknowledgeRequest? = null
    private val pendingKeeps = mutableMapOf<String, RelicKeepRequest>()
    private val pendingFeedback = mutableMapOf<String, ConnectionFeedbackRequest>()
    private val pendingReleases = mutableMapOf<String, RelicReleaseRequest>()
    /** The privacy epoch the lists were last read at. */
    private var epoch: Long? = null
    private var awayJob: Job? = null
    private var relicsJob: Job? = null

    /** Opening the Atlas: what changed while away, and the Relics (so a found connection already
     * kept says so). What is shown stays until the new answer arrives. */
    fun openAtlas() {
        loadAway()
        loadRelics()
    }

    /** Opening Keep. */
    fun openKeep() = loadRelics()

    fun retryRelics() {
        _relics.value = RelicsState.Loading
        loadRelics()
    }

    private fun loadAway() {
        if (_away.value is AwayState.Unavailable) _away.value = AwayState.Loading
        awayJob?.cancel()
        awayJob = viewModelScope.launch {
            try {
                val response = api.getAway()
                observeEpoch(response.privacyEpoch, readingAway = true)
                _away.value = AwayState.Loaded(response)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The Atlas shows nothing for this; the message is for the record, not the map.
                if (returnFailure(e) == ReturnFailure.SessionEnded) sessionEnded()
                else _away.value = AwayState.Unavailable(text(if (e is ApiException.Protocol) R.string.return_unreadable else R.string.return_load_failed))
            }
        }
    }

    private fun loadRelics() {
        if (_relics.value is RelicsState.Unavailable) _relics.value = RelicsState.Loading
        relicsJob?.cancel()
        relicsJob = viewModelScope.launch {
            try {
                val response = api.getRelics()
                observeEpoch(response.privacyEpoch, readingAway = false)
                _relics.value = RelicsState.Loaded(response)
                applyRelics(response)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (returnFailure(e) == ReturnFailure.SessionEnded) sessionEnded()
                else _relics.value = RelicsState.Unavailable(text(if (e is ApiException.Protocol) R.string.return_unreadable else R.string.return_load_failed))
            }
        }
    }

    /** A kept Relic says its connection is kept, and a doubted one that the reader marked it wrong. */
    private fun applyRelics(response: RelicsResponse) {
        val kept = response.relics.associateBy { it.connection.bridgeId }
        // A Relic the server lists is confirmed kept: an unconfirmed keep of it is settled, so a later
        // retry can never bring back a Relic the reader has since let go (review M1). One still in
        // flight settles itself.
        for (id in kept.keys) if (_connections.value[id]?.keep !is ReturnActionState.Working) pendingKeeps.remove(id)
        _connections.update { current ->
            (current.keys + kept.keys).associateWith { id ->
                val known = current[id] ?: ConnectionState()
                val relic = kept[id]
                val settled = relic != null && known.keep !is ReturnActionState.Working
                known.copy(
                    kept = relic != null, markedWrong = known.markedWrong || relic?.state == "doubted",
                    keep = if (settled) ReturnActionState.Idle else known.keep,
                )
            }
        }
    }

    /** Clear and Reset start a new epoch: whatever was known or kept for the old one is gone, and
     * the other list, if it still shows the old epoch, is read again (the one being read is about to
     * be replaced). A request still in flight settles itself. */
    private fun observeEpoch(next: Long, readingAway: Boolean) {
        val previous = epoch
        epoch = next
        if (previous == null || previous == next) return
        if (_acknowledge.value !is ReturnActionState.Working) {
            pendingAcknowledge = null
            if ((_acknowledge.value as? ReturnActionState.Failed)?.canRetry == true) _acknowledge.value = ReturnActionState.Idle
        }
        pendingKeeps.values.removeAll { it.expectedPrivacyEpoch != next }
        pendingFeedback.values.removeAll { it.expectedPrivacyEpoch != next }
        pendingReleases.values.removeAll { it.expectedPrivacyEpoch != next }
        _connections.value = _connections.value.filterValues { it.keep is ReturnActionState.Working || it.seemsWrong is ReturnActionState.Working }
            .mapValues { (_, c) -> ConnectionState(keep = c.keep, seemsWrong = c.seemsWrong) }
        _releases.value = _releases.value.filterValues { it is ReturnActionState.Working }
        // Unless a read of it is already on its way.
        if (!readingAway && (_away.value as? AwayState.Loaded)?.response?.privacyEpoch.let { it != null && it != next }) {
            _away.value = AwayState.Loading
            if (awayJob?.isActive != true) loadAway()
        }
        if (readingAway && (_relics.value as? RelicsState.Loaded)?.response?.privacyEpoch.let { it != null && it != next }) {
            _relics.value = RelicsState.Loading
            if (relicsJob?.isActive != true) loadRelics()
        }
    }

    // ---- "Mark as seen" -----------------------------------------------------------------------

    /** Acknowledges through the newest item shown. Nothing while recording is paused: the marker
     * records when the reader looked, so it stays until they resume (ADR-0039 §2). */
    fun markSeen() {
        val response = (_away.value as? AwayState.Loaded)?.response ?: return
        val newest = response.items.firstOrNull() ?: return
        if (response.recordingPaused || _acknowledge.value is ReturnActionState.Working) return
        // One that may have landed is sent again as it was, never as a second request.
        sendAcknowledge(pendingAcknowledge ?: AwayAcknowledgeRequest(UUID.randomUUID().toString(), response.privacyEpoch, newest.at))
    }

    /** The same request again -- never a new one, and nothing when nothing is kept. */
    fun retryMarkSeen() {
        if (_acknowledge.value is ReturnActionState.Working) return
        pendingAcknowledge?.let(::sendAcknowledge)
    }

    private fun sendAcknowledge(req: AwayAcknowledgeRequest) {
        pendingAcknowledge = req
        _acknowledge.value = ReturnActionState.Working
        viewModelScope.launch {
            try {
                api.acknowledgeAway(req)
                pendingAcknowledge = null
                _acknowledge.value = ReturnActionState.Idle
                loadAway()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settle(e, req.expectedPrivacyEpoch, R.string.return_refused,
                    drop = { if (pendingAcknowledge == req) pendingAcknowledge = null },
                    show = { _acknowledge.value = it })
            }
        }
    }

    // ---- "Keep" and "Seems wrong" on a found connection ---------------------------------------

    fun keep(bridgeId: String) {
        val at = epoch ?: return
        val known = _connections.value[bridgeId] ?: ConnectionState()
        if (known.kept || known.markedWrong || known.keep is ReturnActionState.Working) return
        sendKeep(pendingKeeps[bridgeId] ?: RelicKeepRequest(UUID.randomUUID().toString(), at, bridgeId))
    }

    fun retryKeep(bridgeId: String) {
        if (_connections.value[bridgeId]?.keep is ReturnActionState.Working) return
        pendingKeeps[bridgeId]?.let(::sendKeep)
    }

    private fun sendKeep(req: RelicKeepRequest) {
        pendingKeeps[req.bridgeId] = req
        connection(req.bridgeId) { it.copy(keep = ReturnActionState.Working) }
        viewModelScope.launch {
            try {
                val receipt = api.keepRelic(req)
                pendingKeeps.remove(req.bridgeId)
                connection(req.bridgeId) {
                    it.copy(kept = true, markedWrong = it.markedWrong || receipt.relic.state == "doubted", keep = ReturnActionState.Idle)
                }
                loadRelics()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settle(e, req.expectedPrivacyEpoch, R.string.return_keep_refused,
                    drop = { if (pendingKeeps[req.bridgeId] == req) pendingKeeps.remove(req.bridgeId) },
                    show = { state -> connection(req.bridgeId) { it.copy(keep = state) } })
            }
        }
    }

    /** Personal suppression only (ADR-0031): never a retraction of shared knowledge. A kept Relic
     * of it becomes `doubted`, so both lists are read again. */
    fun seemsWrong(bridgeId: String) {
        val at = epoch ?: return
        val known = _connections.value[bridgeId] ?: ConnectionState()
        if (known.markedWrong || known.seemsWrong is ReturnActionState.Working) return
        sendFeedback(pendingFeedback[bridgeId] ?: ConnectionFeedbackRequest(UUID.randomUUID().toString(), bridgeId, at))
    }

    fun retrySeemsWrong(bridgeId: String) {
        if (_connections.value[bridgeId]?.seemsWrong is ReturnActionState.Working) return
        pendingFeedback[bridgeId]?.let(::sendFeedback)
    }

    private fun sendFeedback(req: ConnectionFeedbackRequest) {
        pendingFeedback[req.bridgeId] = req
        connection(req.bridgeId) { it.copy(seemsWrong = ReturnActionState.Working) }
        viewModelScope.launch {
            try {
                api.postConnectionFeedback(req)
                pendingFeedback.remove(req.bridgeId)
                connection(req.bridgeId) { it.copy(markedWrong = true, seemsWrong = ReturnActionState.Idle) }
                loadAway()
                loadRelics()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settle(e, req.expectedPrivacyEpoch, R.string.return_refused,
                    drop = { if (pendingFeedback[req.bridgeId] == req) pendingFeedback.remove(req.bridgeId) },
                    show = { state -> connection(req.bridgeId) { it.copy(seemsWrong = state) } })
            }
        }
    }

    // ---- "Let go" -----------------------------------------------------------------------------

    fun letGo(relicId: String) {
        val response = (_relics.value as? RelicsState.Loaded)?.response ?: return
        if (response.relics.none { it.relicId == relicId } || _releases.value[relicId] is ReturnActionState.Working) return
        sendRelease(pendingReleases[relicId] ?: RelicReleaseRequest(relicId, response.privacyEpoch))
    }

    fun retryLetGo(relicId: String) {
        if (_releases.value[relicId] is ReturnActionState.Working) return
        pendingReleases[relicId]?.let(::sendRelease)
    }

    private fun sendRelease(req: RelicReleaseRequest) {
        pendingReleases[req.relicId] = req
        _releases.update { it + (req.relicId to ReturnActionState.Working) }
        viewModelScope.launch {
            try {
                api.releaseRelic(req.relicId, req.expectedPrivacyEpoch)
                pendingReleases.remove(req.relicId)
                _releases.update { it - req.relicId }
                // The receipt says the row is gone: it leaves the list now, not after the reload.
                val loaded = _relics.value as? RelicsState.Loaded
                if (loaded != null && loaded.response.privacyEpoch == req.expectedPrivacyEpoch) {
                    val remaining = loaded.response.copy(relics = loaded.response.relics.filterNot { it.relicId == req.relicId })
                    _relics.value = RelicsState.Loaded(remaining)
                    applyRelics(remaining)
                }
                loadRelics()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settle(e, req.expectedPrivacyEpoch, R.string.return_refused,
                    drop = { if (pendingReleases[req.relicId] == req) pendingReleases.remove(req.relicId) },
                    show = { state -> _releases.update { it + (req.relicId to state) } })
            }
        }
    }

    // ---- Shared -------------------------------------------------------------------------------

    private fun connection(bridgeId: String, change: (ConnectionState) -> ConnectionState) {
        _connections.update { it + (bridgeId to change(it[bridgeId] ?: ConnectionState())) }
    }

    /** One failed request, settled: see [ReturnFailure]. */
    private fun settle(e: Exception, sentAt: Long, @StringRes refused: Int, drop: () -> Unit, show: (ReturnActionState) -> Unit) {
        when (val failure = returnFailure(e)) {
            ReturnFailure.SessionEnded -> sessionEnded()
            ReturnFailure.Conflict, ReturnFailure.Refused -> {
                // Definitive: nothing was applied and a re-send could only be refused again.
                drop()
                val message = if (failure == ReturnFailure.Conflict) R.string.return_conflict else refused
                show(ReturnActionState.Failed(text(message), canRetry = false))
                // What is current (a new epoch, paused recording, a withdrawn connection) is shown.
                loadAway()
                loadRelics()
            }
            ReturnFailure.Unconfirmed ->
                if (epoch != null && epoch != sentAt) {
                    // The epoch moved on while it was in flight: whatever happened, nothing to retry.
                    drop()
                    show(ReturnActionState.Idle)
                } else {
                    show(ReturnActionState.Failed(text(R.string.return_unconfirmed), canRetry = true))
                }
        }
    }

    /** The session is gone. The 401 was already reported through [ApiClient]'s `onUnauthorized`
     * (the app-wide signal the account view model signs out on); nothing of it is kept here. */
    private fun sessionEnded() {
        awayJob?.cancel()
        relicsJob?.cancel()
        pendingAcknowledge = null
        pendingKeeps.clear()
        pendingFeedback.clear()
        pendingReleases.clear()
        epoch = null
        _acknowledge.value = ReturnActionState.Idle
        _connections.value = emptyMap()
        _releases.value = emptyMap()
        _away.value = AwayState.Unavailable(text(R.string.return_session_ended))
        _relics.value = RelicsState.Unavailable(text(R.string.return_session_ended))
    }

    private fun text(@StringRes id: Int): String = getApplication<Application>().getString(id)
}
