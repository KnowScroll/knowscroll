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
import com.knowscroll.mobile.data.AwayItem
import com.knowscroll.mobile.data.AwayResponse
import com.knowscroll.mobile.data.ConnectionFeedbackRequest
import com.knowscroll.mobile.data.DoubtTarget
import com.knowscroll.mobile.data.ObjectionRequest
import com.knowscroll.mobile.data.ObjectionTarget
import com.knowscroll.mobile.data.PassagesResponse
import com.knowscroll.mobile.data.RelicKeepRequest
import com.knowscroll.mobile.data.RelicReleaseRequest
import com.knowscroll.mobile.data.RelicTarget
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
 * #134/#165 (ADR-0039, ADR-0044): the return and Relics -- "While you were away" on the Atlas, the
 * Relics above Keep's Traces, and Keep and "Seems wrong" wherever the reader meets something they
 * may keep: a found connection, a place, a passage of the Scroll they read, an answer to their own
 * Ask. One small view model shared by all of them, created once in `KnowScrollApp` like
 * [com.knowscroll.mobile.ui.account.InquiriesViewModel], which it mirrors: the credential is read
 * fresh per request, and a 401 reaches the app's one sign-out path through the process-wide
 * [com.knowscroll.mobile.data.SessionInvalidation] signal this [ApiClient] reports to.
 *
 * Each action ("Mark as seen", "Keep", "Seems wrong", "Let go") is one explicit request with a
 * client request id generated once per intent. A failure that may have landed keeps that same
 * request, in memory, for an explicit retry the server replays; a definitive refusal is surfaced,
 * nothing is kept, and what is current is read again. In memory is enough: acknowledging only moves
 * a marker forward, and keeping or objecting are replay-safe server-side, so a request lost with the
 * process is simply offered again -- and what the reader already kept or objected to is said by the
 * lists themselves (ADR-0044 M5), never remembered only here. Anything kept from another epoch
 * (Clear, Reset) could only be refused, so it is dropped when a list shows the epoch moved.
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
    private val _passages = MutableStateFlow<PassagesState>(PassagesState.Loading)
    val passages = _passages.asStateFlow()
    private val _acknowledge = MutableStateFlow<ReturnActionState>(ReturnActionState.Idle)
    val acknowledge = _acknowledge.asStateFlow()
    /** Reading an earlier page of the return, and an older page of the Relics. */
    private val _earlierAway = MutableStateFlow<ReturnActionState>(ReturnActionState.Idle)
    val earlierAway = _earlierAway.asStateFlow()
    private val _olderRelics = MutableStateFlow<ReturnActionState>(ReturnActionState.Idle)
    val olderRelics = _olderRelics.asStateFlow()
    /** By the thing it keeps or doubts. */
    private val _keepables = MutableStateFlow<Map<RelicTarget, KeepableState>>(emptyMap())
    val keepables = _keepables.asStateFlow()
    /** Whether recording is paused, as the newest list read says: nothing new is kept then. */
    private val _paused = MutableStateFlow(false)
    val paused = _paused.asStateFlow()
    /** "Let go", by Relic id. */
    private val _releases = MutableStateFlow<Map<String, ReturnActionState>>(emptyMap())
    val releases = _releases.asStateFlow()

    private var pendingAcknowledge: AwayAcknowledgeRequest? = null
    private val pendingKeeps = mutableMapOf<RelicTarget, RelicKeepRequest>()
    private val pendingFeedback = mutableMapOf<RelicTarget.Connection, ConnectionFeedbackRequest>()
    private val pendingObjections = mutableMapOf<ObjectionTarget, ObjectionRequest>()
    private val pendingReleases = mutableMapOf<String, RelicReleaseRequest>()
    /** The privacy epoch the lists were last read at. */
    private var epoch: Long? = null
    private var awayJob: Job? = null
    private var relicsJob: Job? = null
    private var passagesJob: Job? = null

    /** Opening the Atlas: what changed while away, and the Relics (so a found connection or a place
     * already kept says so). What is shown stays until the new answer arrives. */
    fun openAtlas() {
        loadAway()
        loadRelics()
    }

    /** Opening Keep, or a surface that offers Keep (the Ask sheet): the Relics, and with them what is
     * kept and whether recording is paused. */
    fun readRelics() = loadRelics()

    fun retryRelics() {
        _relics.value = RelicsState.Loading
        loadRelics()
    }

    /** The passages of the Scroll on screen, each with the reader's own state of it. */
    fun openPassages(assetId: String) {
        val shown = (_passages.value as? PassagesState.Loaded)?.response
        if (shown?.assetId != assetId || _passages.value is PassagesState.Unavailable) _passages.value = PassagesState.Loading
        passagesJob?.cancel()
        passagesJob = viewModelScope.launch {
            try {
                val response = api.getPassages(assetId)
                observeEpoch(response.privacyEpoch)
                _paused.value = response.recordingPaused
                _passages.value = PassagesState.Loaded(response)
                applyPassages(response)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (returnFailure(e) == ReturnFailure.SessionEnded) sessionEnded()
                else _passages.value = PassagesState.Unavailable(text(if (e is ApiException.Protocol) R.string.return_unreadable else R.string.return_load_failed))
            }
        }
    }

    private fun loadAway() {
        if (_away.value is AwayState.Unavailable) _away.value = AwayState.Loading
        awayJob?.cancel()
        _earlierAway.value = ReturnActionState.Idle
        awayJob = viewModelScope.launch {
            try {
                val response = api.getAway()
                observeEpoch(response.privacyEpoch, readingAway = true)
                _paused.value = response.recordingPaused
                _away.value = AwayState.Loaded(response)
                applyAway(response)
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
        _olderRelics.value = ReturnActionState.Idle
        relicsJob = viewModelScope.launch {
            try {
                val response = api.getRelics()
                observeEpoch(response.privacyEpoch, readingRelics = true)
                _paused.value = response.recordingPaused
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

    // ---- Paging (ADR-0044 M7, M8) ---------------------------------------------------------------

    /** The next earlier page of the return, added below what is shown. A failed read may be tried again. */
    fun showEarlierAway() {
        val shown = (_away.value as? AwayState.Loaded)?.response ?: return
        val page = shown.nextPage ?: return
        if (_earlierAway.value is ReturnActionState.Working || awayJob?.isActive == true) return
        _earlierAway.value = ReturnActionState.Working
        awayJob = viewModelScope.launch {
            try {
                val next = api.getAway(page)
                if (next.privacyEpoch != shown.privacyEpoch) {
                    // Cleared or reset meanwhile: what is shown belongs to another epoch.
                    observeEpoch(next.privacyEpoch, readingAway = true)
                    _earlierAway.value = ReturnActionState.Idle
                    loadAway()
                    return@launch
                }
                _earlierAway.value = ReturnActionState.Idle
                _away.value = AwayState.Loaded(shown.copy(items = shown.items + next.items, more = next.more, nextPage = next.nextPage))
                applyAway(next)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (returnFailure(e) == ReturnFailure.SessionEnded) sessionEnded()
                else _earlierAway.value = ReturnActionState.Failed(text(R.string.return_load_failed), canRetry = true)
            }
        }
    }

    /** The next older page of the Relics, added below what is shown, so the oldest can be let go. */
    fun showOlderRelics() {
        val shown = (_relics.value as? RelicsState.Loaded)?.response ?: return
        val page = shown.nextPage ?: return
        if (_olderRelics.value is ReturnActionState.Working || relicsJob?.isActive == true) return
        _olderRelics.value = ReturnActionState.Working
        relicsJob = viewModelScope.launch {
            try {
                val next = api.getRelics(page)
                if (next.privacyEpoch != shown.privacyEpoch) {
                    observeEpoch(next.privacyEpoch, readingRelics = true)
                    _olderRelics.value = ReturnActionState.Idle
                    loadRelics()
                    return@launch
                }
                _olderRelics.value = ReturnActionState.Idle
                val all = shown.copy(relics = shown.relics + next.relics, nextPage = next.nextPage, recordingPaused = next.recordingPaused)
                _relics.value = RelicsState.Loaded(all)
                applyRelics(all)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (returnFailure(e) == ReturnFailure.SessionEnded) sessionEnded()
                else _olderRelics.value = ReturnActionState.Failed(text(R.string.return_load_failed), canRetry = true)
            }
        }
    }

    // ---- What the lists say ---------------------------------------------------------------------

    /** A kept Relic says its thing is kept, and a doubted one that the reader objected to it. What the
     * list does not show is not kept only when the list is whole (no older page); a Relic the server
     * lists is confirmed kept, so an unconfirmed keep of it is settled and a later retry can never
     * bring back a Relic the reader has since let go (review M1). One still in flight settles itself. */
    private fun applyRelics(response: RelicsResponse) {
        val kept = response.relics.associateBy { it.target }
        val whole = response.nextPage == null
        for (target in kept.keys) if (_keepables.value[target]?.keep !is ReturnActionState.Working) pendingKeeps.remove(target)
        _keepables.update { current ->
            (current.keys + kept.keys).associateWith { target ->
                val known = current[target] ?: KeepableState()
                val relic = kept[target]
                val settled = relic != null && known.keep !is ReturnActionState.Working
                known.copy(
                    kept = relic != null || (known.kept && !whole),
                    markedWrong = known.markedWrong || (relic?.state == "doubted" && target is DoubtTarget),
                    keep = if (settled) ReturnActionState.Idle else known.keep,
                )
            }
        }
    }

    /** A found or corrected connection says whether this reader objected to it (ADR-0044 M5). */
    private fun applyAway(response: AwayResponse) {
        for (item in response.items) {
            val (bridgeId, wrong) = when (item) {
                is AwayItem.ConnectionFound -> item.found.bridgeId to item.seemsWrong
                is AwayItem.ConnectionCorrected -> item.bridgeId to item.seemsWrong
                else -> continue
            }
            if (wrong) keepable(RelicTarget.Connection(bridgeId)) { it.copy(markedWrong = true) }
        }
    }

    /** Each passage says whether it is kept at this revision and whether the reader objected to it. */
    private fun applyPassages(response: PassagesResponse) {
        for (passage in response.passages) {
            val target = RelicTarget.Passage(response.assetId, response.revision, passage.claimKey)
            if (passage.kept && _keepables.value[target]?.keep !is ReturnActionState.Working) pendingKeeps.remove(target)
            keepable(target) { known ->
                val settled = passage.kept && known.keep !is ReturnActionState.Working
                known.copy(kept = passage.kept, markedWrong = known.markedWrong || passage.seemsWrong, keep = if (settled) ReturnActionState.Idle else known.keep)
            }
        }
    }

    /** Clear and Reset start a new epoch: whatever was known or kept for the old one is gone, and
     * the other list, if it still shows the old epoch, is read again (the one being read is about to
     * be replaced). A request still in flight settles itself. */
    private fun observeEpoch(next: Long, readingAway: Boolean = false, readingRelics: Boolean = false) {
        val previous = epoch
        epoch = next
        if (previous == null || previous == next) return
        if (_acknowledge.value !is ReturnActionState.Working) {
            pendingAcknowledge = null
            if ((_acknowledge.value as? ReturnActionState.Failed)?.canRetry == true) _acknowledge.value = ReturnActionState.Idle
        }
        pendingKeeps.values.removeAll { it.expectedPrivacyEpoch != next }
        pendingFeedback.values.removeAll { it.expectedPrivacyEpoch != next }
        pendingObjections.values.removeAll { it.expectedPrivacyEpoch != next }
        pendingReleases.values.removeAll { it.expectedPrivacyEpoch != next }
        _keepables.value = _keepables.value.filterValues { it.keep is ReturnActionState.Working || it.seemsWrong is ReturnActionState.Working }
            .mapValues { (_, c) -> KeepableState(keep = c.keep, seemsWrong = c.seemsWrong) }
        _releases.value = _releases.value.filterValues { it is ReturnActionState.Working }
        // Unless a read of it is already on its way.
        if (!readingAway && (_away.value as? AwayState.Loaded)?.response?.privacyEpoch.let { it != null && it != next }) {
            _away.value = AwayState.Loading
            if (awayJob?.isActive != true) loadAway()
        }
        if (!readingRelics && (_relics.value as? RelicsState.Loaded)?.response?.privacyEpoch.let { it != null && it != next }) {
            _relics.value = RelicsState.Loading
            if (relicsJob?.isActive != true) loadRelics()
        }
        (_passages.value as? PassagesState.Loaded)?.response?.takeIf { it.privacyEpoch != next }?.let { stale ->
            if (passagesJob?.isActive != true) openPassages(stale.assetId)
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

    // ---- "Keep" -------------------------------------------------------------------------------

    fun keep(target: RelicTarget) {
        val at = epoch ?: return
        val known = _keepables.value[target] ?: KeepableState()
        if (known.kept || known.markedWrong || known.keep is ReturnActionState.Working) return
        sendKeep(pendingKeeps[target] ?: RelicKeepRequest(UUID.randomUUID().toString(), at, target))
    }

    fun retryKeep(target: RelicTarget) {
        if (_keepables.value[target]?.keep is ReturnActionState.Working) return
        pendingKeeps[target]?.let(::sendKeep)
    }

    private fun sendKeep(req: RelicKeepRequest) {
        pendingKeeps[req.target] = req
        keepable(req.target) { it.copy(keep = ReturnActionState.Working) }
        viewModelScope.launch {
            try {
                val receipt = api.keepRelic(req)
                pendingKeeps.remove(req.target)
                keepable(req.target) {
                    it.copy(kept = true, markedWrong = it.markedWrong || (receipt.relic.state == "doubted" && req.target is DoubtTarget), keep = ReturnActionState.Idle)
                }
                loadRelics()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settle(e, req.expectedPrivacyEpoch, R.string.return_keep_refused,
                    drop = { if (pendingKeeps[req.target] == req) pendingKeeps.remove(req.target) },
                    show = { state -> keepable(req.target) { it.copy(keep = state) } })
            }
        }
    }

    // ---- "Seems wrong" ------------------------------------------------------------------------

    /** Personal only (ADR-0031, ADR-0044 §4): never a retraction of shared knowledge. A kept Relic
     * of it becomes `doubted`, so what shows it is read again. */
    fun seemsWrong(target: DoubtTarget) {
        val at = epoch ?: return
        val known = _keepables.value[target] ?: KeepableState()
        if (known.markedWrong || known.seemsWrong is ReturnActionState.Working) return
        when (target) {
            is RelicTarget.Connection -> sendFeedback(pendingFeedback[target] ?: ConnectionFeedbackRequest(UUID.randomUUID().toString(), target.bridgeId, at))
            is ObjectionTarget -> sendObjection(pendingObjections[target] ?: ObjectionRequest(UUID.randomUUID().toString(), at, target))
        }
    }

    fun retrySeemsWrong(target: DoubtTarget) {
        if (_keepables.value[target]?.seemsWrong is ReturnActionState.Working) return
        when (target) {
            is RelicTarget.Connection -> pendingFeedback[target]?.let(::sendFeedback)
            is ObjectionTarget -> pendingObjections[target]?.let(::sendObjection)
        }
    }

    private fun sendFeedback(req: ConnectionFeedbackRequest) {
        val target = RelicTarget.Connection(req.bridgeId)
        pendingFeedback[target] = req
        sendDoubt(target, req.expectedPrivacyEpoch, send = { api.postConnectionFeedback(req) },
            drop = { if (pendingFeedback[target] == req) pendingFeedback.remove(target) }, done = { pendingFeedback.remove(target) })
    }

    private fun sendObjection(req: ObjectionRequest) {
        pendingObjections[req.target] = req
        sendDoubt(req.target, req.expectedPrivacyEpoch, send = { api.postObjection(req) },
            drop = { if (pendingObjections[req.target] == req) pendingObjections.remove(req.target) }, done = { pendingObjections.remove(req.target) })
    }

    /** One "seems wrong", whichever route carries it; what shows it is read again. */
    private fun sendDoubt(target: DoubtTarget, sentAt: Long, send: suspend () -> Unit, drop: () -> Unit, done: () -> Unit) {
        keepable(target) { it.copy(seemsWrong = ReturnActionState.Working) }
        viewModelScope.launch {
            try {
                send()
                done()
                keepable(target) { it.copy(markedWrong = true, seemsWrong = ReturnActionState.Idle) }
                refreshAfterDoubt(target)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settle(e, sentAt, R.string.return_refused, drop = drop, show = { state -> keepable(target) { it.copy(seemsWrong = state) } })
            }
        }
    }

    private fun refreshAfterDoubt(target: DoubtTarget) {
        if (target is RelicTarget.Connection) loadAway()
        if (target is RelicTarget.Passage) openPassages(target.assetId)
        loadRelics()
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
                    val gone = loaded.response.relics.firstOrNull { it.relicId == req.relicId }
                    val remaining = loaded.response.copy(relics = loaded.response.relics.filterNot { it.relicId == req.relicId })
                    _relics.value = RelicsState.Loaded(remaining)
                    applyRelics(remaining)
                    gone?.let { relic -> keepable(relic.target) { it.copy(kept = false) } }
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

    private fun keepable(target: RelicTarget, change: (KeepableState) -> KeepableState) {
        _keepables.update { it + (target to change(it[target] ?: KeepableState())) }
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
                // What is current (a new epoch, paused recording, something withdrawn) is shown.
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
        passagesJob?.cancel()
        pendingAcknowledge = null
        pendingKeeps.clear()
        pendingFeedback.clear()
        pendingObjections.clear()
        pendingReleases.clear()
        epoch = null
        _acknowledge.value = ReturnActionState.Idle
        _earlierAway.value = ReturnActionState.Idle
        _olderRelics.value = ReturnActionState.Idle
        _keepables.value = emptyMap()
        _releases.value = emptyMap()
        _away.value = AwayState.Unavailable(text(R.string.return_session_ended))
        _relics.value = RelicsState.Unavailable(text(R.string.return_session_ended))
        _passages.value = PassagesState.Unavailable(text(R.string.return_session_ended))
    }

    private fun text(@StringRes id: Int): String = getApplication<Application>().getString(id)
}
