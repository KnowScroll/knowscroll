package com.knowscroll.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.ExposureRequest
import com.knowscroll.mobile.data.HistoryClearRequest
import com.knowscroll.mobile.data.HistoryClearReceipt
import com.knowscroll.mobile.data.InteractionRequest
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.data.ScrollSession
import com.knowscroll.mobile.data.StateStore
import com.knowscroll.mobile.data.Trace
import com.knowscroll.mobile.data.TraceRevisit
import com.knowscroll.mobile.data.TraceRevisitSession
import com.knowscroll.mobile.data.Universe
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface Screen {
    data object Universe: Screen
    data class Scroll(val assetId:String):Screen
    data class TraceRevisit(val eventId:String):Screen
    /** docs/product/ui-system.md sec.5b's Keep destination: a read-only view over the already
     * loaded universe's real Traces. No network fetch of its own -- see `openKeep()`. */
    data object Keep: Screen
}
sealed interface UniverseState {
    data object Loading:UniverseState
    data class Loaded(val universe:Universe):UniverseState
    data class Unavailable(val message:String):UniverseState
}
sealed interface ScrollState {
    data object Idle:ScrollState
    data object Loading:ScrollState
    data class Reading(
        val item:ScrollItem,val exposureId:String,val eventId:String,val keep:KeepState,
        val readingPosition:Int,val discovery:DiscoveryState=DiscoveryState.Idle,
        val origin:ReaderOrigin=ReaderOrigin.Discovery
    ):ScrollState
    data class Unavailable(val message:String,val retryable:Boolean=true):ScrollState
    data object Exhausted:ScrollState
}
sealed interface ReaderOrigin {
    data object Discovery:ReaderOrigin
    /** keptAt is the original Keep Ledger's created_at, verbatim from the Trace revisit receipt. */
    data class SavedTrace(val eventId:String,val keptAt:String):ReaderOrigin
}
sealed interface KeepState {
    data object Idle:KeepState
    data object Saving:KeepState
    data class Kept(val jobId:String):KeepState
    data class Failed(val message:String):KeepState
    data class Conflict(val message:String):KeepState
}
sealed interface HistoryClearState {
    data object Idle:HistoryClearState
    data object Confirming:HistoryClearState
    data object Clearing:HistoryClearState
    data class Retryable(val message:String):HistoryClearState
    data class ReconcileUnavailable(val message:String):HistoryClearState
    data class NeedsConfirmation(val message:String):HistoryClearState
    data class SessionUnavailable(val message:String):HistoryClearState
}

class AppViewModel(application:Application,private val savedState:SavedStateHandle):AndroidViewModel(application) {
    private val api=ApiClient()
    private val store=StateStore(application)
    private var session:ScrollSession?=null
    private var revisit:TraceRevisitSession?=null
    private var observedPrivacyEpoch=store.readObservedPrivacyEpoch()
    private var observedUniverseId=store.readObservedUniverseId()
    private var busy=false
    private var signOutBusy=false
    private var reconciling=false
    private var reconcileAfterCurrent:Boolean?=null
    private var ready=false
    private var navigationVersion=0L
    private val visited=store.readVisited().toMutableSet()
    private val _screen=MutableStateFlow<Screen>(Screen.Universe); val screen=_screen.asStateFlow()
    private val _universe=MutableStateFlow<UniverseState>(UniverseState.Loading); val universe=_universe.asStateFlow()
    private val _scroll=MutableStateFlow<ScrollState>(ScrollState.Idle); val scroll=_scroll.asStateFlow()
    private val _historyClear=MutableStateFlow<HistoryClearState>(HistoryClearState.Idle); val historyClear=_historyClear.asStateFlow()
    private val _signOut=MutableStateFlow<SignOutState>(SignOutState.Idle); val signOut=_signOut.asStateFlow()
    private val _toast=MutableStateFlow<String?>(null); val toast=_toast.asStateFlow()

    init {
        val restored=signOutRestoreState(store.readPendingSignOut(),store.readSignedOut())
        _signOut.value=restored
        if(restored is SignOutState.SignedOut){
            ready=false
        } else {
            // #91 review fix: a restored ambiguous sign-out and privacy reconciliation must
            // never race against the same possibly-dead token as two independent coroutines.
            // Retrying it is dispatched from inside reconcilePrivacy, same as pending Clear
            // History, so cold start is one ordered path.
            reconcilePrivacy(restoreStoredScroll=true,retrySignOutFirst=restored is SignOutState.Retryable)
        }
    }

    fun consumeToast(){_toast.value=null}
    fun onForeground(){if(_signOut.value !is SignOutState.SignedOut)reconcilePrivacy(restoreStoredScroll=true)}
    fun retryUniverse()=reconcilePrivacy(restoreStoredScroll=store.readScreen() in setOf("scroll","revisit"),queueIfBusy=true)
    fun retryScrollLoad(){
        val pending=revisit
        if(_screen.value is Screen.TraceRevisit && pending!=null)loadTraceRevisit(pending)
        else if(_screen.value is Screen.TraceRevisit)return
        else enterScroll()
    }

    fun enterScroll(){
        if(busy || reconciling || !ready || store.readPendingClear()!=null)return
        val current=session
        if(current!=null && current.keepJobId.isEmpty() && current.privacyEpoch==observedPrivacyEpoch){show(current);return}
        loadNext()
    }

    /** A Trace has an explicit origin and never becomes a new discovery or exposure. */
    fun openTrace(trace:Trace){
        if(busy || reconciling || !ready || store.readPendingClear()!=null)return
        val requested=TraceRevisitSession(
            eventId=trace.eventId,assetId=trace.assetId,privacyEpoch=observedPrivacyEpoch,
            universeId=observedUniverseId
        )
        revisit=requested
        store.writeRevisit(requested)
        loadTraceRevisit(requested)
    }

    private fun loadTraceRevisit(requested:TraceRevisitSession,restoring:Boolean=false){
        if(busy || (!restoring && reconciling) || !ready || store.readPendingClear()!=null)return
        if(requested.privacyEpoch!=observedPrivacyEpoch || requested.universeId!=observedUniverseId){
            discardRevisit();return
        }
        busy=true
        val version=++navigationVersion
        val epoch=observedPrivacyEpoch
        _screen.value=Screen.TraceRevisit(requested.eventId)
        savedState["screen"]="revisit";store.writeScreen("revisit")
        _scroll.value=ScrollState.Loading
        viewModelScope.launch {
            try {
                val receipt=api.getTraceRevisit(requested.eventId)
                if(!operationIsCurrent(version,epoch))return@launch
                val accepted=acceptTraceRevisit(receipt,requested,observedUniverseId,observedPrivacyEpoch)
                if(accepted==null){
                    discardRevisit()
                    _scroll.value=ScrollState.Unavailable("This saved Scroll could not be verified.",retryable=false)
                    return@launch
                }
                revisit=accepted
                store.writeRevisit(accepted)
                _scroll.value=ScrollState.Reading(
                    receipt.scroll,receipt.exposureId,requested.eventId,KeepState.Kept(requested.eventId),
                    accepted.readingPosition,origin=ReaderOrigin.SavedTrace(requested.eventId,receipt.keptAt)
                )
            } catch(e:Exception){
                if(e is CancellationException)throw e
                if(version!=navigationVersion || _screen.value !is Screen.TraceRevisit)return@launch
                when {
                    e is ApiException.Server && e.statusCode==409 -> {
                        discardRevisit()
                        _scroll.value=ScrollState.Unavailable("This saved Scroll's source has changed and cannot be reopened.",retryable=false)
                    }
                    e is ApiException.Protocol || e is ApiException.Server && e.statusCode in setOf(400,404,422) -> {
                        discardRevisit()
                        _scroll.value=ScrollState.Unavailable("This saved Scroll is unavailable.",retryable=false)
                    }
                    invalidatesReader(e) || e is IllegalStateException -> {
                        purgeForScope(requested.universeId,epoch);failClosed(message(e))
                    }
                    else -> _scroll.value=ScrollState.Unavailable(message(e))
                }
            } finally { if(version==navigationVersion)busy=false }
        }
    }

    fun nextScroll(){
        val reading=_scroll.value as? ScrollState.Reading ?: return
        if(!busy && !reconciling && ready && store.readPendingClear()==null && canRequestDiscovery(reading.keep,reading.discovery))loadNext(preserveReading=true)
    }

    private fun loadNext(preserveReading:Boolean=false){
        if(busy || reconciling || !ready || store.readPendingClear()!=null)return
        val reading=if(preserveReading)_scroll.value as? ScrollState.Reading else null
        busy=true
        val version=++navigationVersion
        val epoch=observedPrivacyEpoch
        val universeId=observedUniverseId
        if(reading!=null){
            _scroll.value=reading.copy(discovery=DiscoveryState.Loading)
        } else {
            _screen.value=Screen.Scroll("")
            savedState["screen"]="scroll"
            store.writeScreen("scroll")
            _scroll.value=ScrollState.Loading
        }
        viewModelScope.launch {
            try {
                val feed=api.getFeed()
                if(!operationIsCurrent(version,epoch))return@launch
                when(val selected=selectDiscovery(feed,universeId,epoch,visited,reading?.item?.assetId ?: session?.item?.assetId)){
                    DiscoverySelection.InvalidScope -> {
                        purgeForScope(feed.universeId,feed.privacyEpoch)
                        failClosed(getApplication<Application>().getString(com.knowscroll.mobile.R.string.reader_scope_changed))
                    }
                    DiscoverySelection.Exhausted -> {
                        if(reading!=null){
                            (_scroll.value as? ScrollState.Reading)?.let{_scroll.value=it.copy(discovery=DiscoveryState.Exhausted)}
                        } else _scroll.value=ScrollState.Exhausted
                    }
                    is DiscoverySelection.Item -> {
                        val next=ScrollSession(feed.decisionId,selected.item,feed.privacyEpoch,feed.universeId)
                        if(!operationIsCurrent(version,epoch))return@launch
                        session?.let{visited.add(it.item.assetId);store.writeVisited(visited)}
                        discardRevisit()
                        store.write(next);session=next;show(next)
                    }
                }
            } catch(e:Exception){
                if(e is CancellationException)throw e
                if(version!=navigationVersion || (_screen.value !is Screen.Scroll && _screen.value !is Screen.TraceRevisit))return@launch
                if(invalidatesReader(e)){
                    purgeForScope(universeId,epoch)
                    failClosed(message(e))
                } else if(reading!=null){
                    (_scroll.value as? ScrollState.Reading)?.let{_scroll.value=it.copy(discovery=DiscoveryState.Failed)}
                } else _scroll.value=ScrollState.Unavailable(message(e))
            } finally{if(version==navigationVersion)busy=false}
        }
    }

    private fun show(value:ScrollSession){
        if(value.privacyEpoch!=observedPrivacyEpoch || value.universeId!=observedUniverseId || store.readPendingClear()!=null)return
        _screen.value=Screen.Scroll(value.item.assetId)
        savedState["screen"]="scroll"
        store.writeScreen("scroll")
        _scroll.value=ScrollState.Reading(
            value.item,value.exposureId,value.exposureEventId,
            if(value.keepJobId.isEmpty())KeepState.Idle else KeepState.Kept(value.keepJobId),
            value.readingPosition
        )
    }

    /** Called by the resumed Compose screen after display frames, never by candidate retrieval. */
    fun onVisible(assetId:String){
        if(_screen.value is Screen.TraceRevisit)return
        val current=session ?: return
        if(current.item.assetId!=assetId || current.exposureId.isNotEmpty() || busy || !ready)return
        val version=navigationVersion
        val epoch=observedPrivacyEpoch
        busy=true
        viewModelScope.launch {
            try {
                val next=recordExposure(current,version,epoch)
                if(operationIsCurrent(version,epoch)){session=next;show(next)}
            } catch(e:Exception){
                if(e is CancellationException)throw e
                if(version==navigationVersion){
                    if(invalidatesReader(e)){purgeForScope(current.universeId,epoch);failClosed(message(e))}
                    else _toast.value=message(e)
                }
            }
            finally{if(version==navigationVersion)busy=false}
        }
    }

    private suspend fun recordExposure(value:ScrollSession,version:Long,epoch:Long):ScrollSession {
        if(value.exposureId.isNotEmpty())return value
        val receipt=api.postExposure(ExposureRequest(value.decisionId,value.item.assetId,value.clientExposureId))
        if(!operationIsCurrent(version,epoch,value))throw CancellationException("Stale exposure response")
        val latest=session?.takeIf{it.clientExposureId==value.clientExposureId && it.item.assetId==value.item.assetId} ?: value
        val updated=latest.copy(exposureId=receipt.exposureId,exposureEventId=receipt.eventId)
        if(!operationIsCurrent(version,epoch,value))throw CancellationException("Stale exposure response")
        store.write(updated)
        return updated
    }

    fun keep(){
        if(busy || !ready)return
        if((_scroll.value as? ScrollState.Reading)?.origin is ReaderOrigin.SavedTrace)return
        val currentSession=session ?: return
        if(currentSession.keepJobId.isNotEmpty())return
        val currentState=_scroll.value as? ScrollState.Reading ?: return
        busy=true
        val version=navigationVersion
        val epoch=observedPrivacyEpoch
        _scroll.value=currentState.copy(keep=KeepState.Saving)
        viewModelScope.launch {
            try {
                val exposed=recordExposure(currentSession,version,epoch)
                if(!operationIsCurrent(version,epoch,currentSession))return@launch
                session=exposed
                val receipt=api.postInteraction(InteractionRequest(exposed.clientEventId,exposed.exposureId,exposed.item.assetId,"keep"))
                if(!operationIsCurrent(version,epoch,exposed))return@launch
                check(receipt.status=="accepted") { "Keep was not accepted" }
                val latest=session?.takeIf{it.clientEventId==exposed.clientEventId && it.item.assetId==exposed.item.assetId} ?: exposed
                val kept=latest.copy(keepJobId=receipt.jobId,keepEventId=receipt.eventId)
                if(!operationIsCurrent(version,epoch,exposed))return@launch
                store.write(kept);session=kept;show(kept)
                viewModelScope.launch {
                    repeat(20){
                        delay(250)
                        if(!operationIsCurrent(version,epoch,kept))return@launch
                        val projected=runCatching{api.getEvent(receipt.eventId).projected}.getOrDefault(false)
                        if(projected){if(_screen.value is Screen.Universe)reconcilePrivacy(false);return@launch}
                    }
                }
            } catch(e:Exception){
                if(e !is CancellationException && operationIsCurrent(version,epoch,currentSession)){
                    if(invalidatesReader(e)){purgeForScope(currentSession.universeId,epoch);failClosed(message(e))}
                    else (_scroll.value as? ScrollState.Reading)?.let{_scroll.value=it.copy(keep=KeepState.Failed(message(e)))}
                }
            } finally{if(version==navigationVersion)busy=false}
        }
    }

    fun updateReadingPosition(assetId:String,position:Int){
        val reading=_scroll.value as? ScrollState.Reading
        if(reading?.origin is ReaderOrigin.SavedTrace){
            val current=revisit ?: return
            if(reading.item.assetId!=assetId || current.assetId!=assetId || current.readingPosition==position || position<0)return
            val updated=current.copy(readingPosition=position)
            revisit=updated;store.writeRevisit(updated)
            _scroll.value=reading.copy(readingPosition=position)
            return
        }
        val current=session ?: return
        if(current.item.assetId!=assetId || current.readingPosition==position || current.privacyEpoch!=observedPrivacyEpoch || store.readPendingClear()!=null)return
        val updated=current.copy(readingPosition=position)
        store.writeReadingPosition(assetId,position)
        session=updated
        if(reading?.item?.assetId==assetId){
            _scroll.value=reading.copy(readingPosition=position)
        }
    }

    fun returnToUniverse(){
        navigationVersion++
        if(_screen.value is Screen.TraceRevisit)discardRevisit()
        visited.clear();store.writeVisited(visited)
        _screen.value=Screen.Universe
        savedState["screen"]="universe";store.writeScreen("universe")
        reconcilePrivacy(restoreStoredScroll=false,queueIfBusy=true)
    }

    /** Opens the Keep destination (docs/product/ui-system.md sec.5b): a read-only list of real
     * Traces. Deliberately does not call `reconcilePrivacy` -- that launches an async refetch
     * which unconditionally resets `_screen` back to `Universe` once it completes (see
     * `applyUniverse`'s final branch), which would race this navigation and silently bounce the
     * reader back out of Keep. Instead it shows whatever `universe.traces` is already held
     * immediately, then quietly refreshes it in place with `refreshUniverseInPlace` -- discovered
     * necessary by actually running this: without it, keeping a Scroll from Cable and going
     * straight to Keep (never passing back through Atlas) showed "nothing kept yet" for a Trace
     * the server had already recorded. */
    fun openKeep(){
        navigationVersion++
        if(_screen.value is Screen.TraceRevisit)discardRevisit()
        _screen.value=Screen.Keep
        refreshUniverseInPlace()
    }

    /** Refetches `GET /v1/universe` and updates only `_universe` -- never `_screen` -- so callers
     * outside the Scroll/TraceRevisit navigation machinery (currently just `openKeep`) can pick up
     * a Trace projected after their last load without inheriting `reconcilePrivacy`'s screen
     * resets. Still honours the same privacy invariants as `applyUniverse`: a stale/superseded
     * response is dropped, and an increased epoch still purges through the normal `purgeForScope`
     * path (which does reset `_screen` -- an epoch bump is exactly the case where leaving Keep
     * showing possibly-cleared Traces would be wrong). */
    private fun refreshUniverseInPlace(){
        val version=navigationVersion
        viewModelScope.launch {
            val actual=try{api.getUniverse()}catch(e:Exception){return@launch}
            if(version!=navigationVersion)return@launch
            if(observedUniverseId.isNotBlank() && actual.universeId!=observedUniverseId){
                purgeForScope(actual.universeId,actual.privacyEpoch);return@launch
            }
            if(actual.privacyEpoch<observedPrivacyEpoch)return@launch
            if(actual.privacyEpoch>observedPrivacyEpoch)purgeForScope(actual.universeId,actual.privacyEpoch)
            observedUniverseId=actual.universeId
            observedPrivacyEpoch=store.observePrivacyState(actual.universeId,actual.privacyEpoch)
            _universe.value=UniverseState.Loaded(actual)
        }
    }

    fun requestHistoryClearConfirmation(){
        if(_universe.value is UniverseState.Loaded && !reconciling && store.readPendingClear()==null){
            _historyClear.value=HistoryClearState.Confirming
        }
    }

    fun cancelHistoryClear(){
        if(_historyClear.value is HistoryClearState.Confirming)_historyClear.value=HistoryClearState.Idle
    }

    fun confirmHistoryClear(){
        if(_historyClear.value !is HistoryClearState.Confirming)return
        val current=(_universe.value as? UniverseState.Loaded)?.universe ?: return
        val request=HistoryClearRequest(UUID.randomUUID().toString(),current.privacyEpoch,universeId=current.universeId)
        store.writePendingClear(request)
        beginHistoryClear(request)
    }

    fun retryHistoryClear(){
        val pending=store.readPendingClear()
        if(pending!=null)beginHistoryClear(pending) else reconcilePrivacy(false)
    }

    fun requestSignOutConfirmation(){
        if(_universe.value is UniverseState.Loaded && !reconciling && _signOut.value is SignOutState.Idle){
            _signOut.value=SignOutState.Confirming
        }
    }

    fun cancelSignOutConfirmation(){
        if(_signOut.value is SignOutState.Confirming)_signOut.value=SignOutState.Idle
    }

    fun confirmSignOut(){
        if(_signOut.value !is SignOutState.Confirming)return
        store.writePendingSignOut()
        beginSignOut()
    }

    fun retrySignOut(){
        if(_signOut.value is SignOutState.Retryable && store.readPendingSignOut() && !signOutBusy)beginSignOut()
    }

    /** Idempotent on the server: a retried revoke of an already-revoked session simply
     * returns 401, which resolves here to the same terminal signed-out state. */
    private fun beginSignOut(){
        if(signOutBusy)return
        signOutBusy=true
        _signOut.value=SignOutState.Revoking
        viewModelScope.launch {
            try { attemptSignOutRevoke() }
            finally { signOutBusy=false }
        }
    }

    /** The actual revoke attempt, factored out so a cold-start retry can run it to
     * completion sequentially inside reconcilePrivacy's own coroutine (#91 review fix)
     * instead of as a second, independently launched coroutine racing the same token. */
    private suspend fun attemptSignOutRevoke(){
        try {
            api.revokeSession()
            completeSignOut()
        } catch(e:Exception){
            if(e is CancellationException)throw e
            if(isSignOutAmbiguous(e))_signOut.value=SignOutState.Retryable(message(e))
            else completeSignOut()
        }
    }

    /** Reuses the existing purge/fail-closed machinery: this device's private reading,
     * navigation and pending-clear state is removed, and no control here will ever
     * reuse the now-dead token. */
    private fun completeSignOut(){
        store.clearPendingSignOut()
        store.writeSignedOut()
        purgeForScope(observedUniverseId,observedPrivacyEpoch)
        ready=false
        _signOut.value=SignOutState.SignedOut
    }

    private fun beginHistoryClear(request:HistoryClearRequest){
        if(reconciling)return
        reconciling=true;ready=false;busy=false
        val version=++navigationVersion
        _historyClear.value=HistoryClearState.Clearing
        _screen.value=Screen.Universe;_scroll.value=ScrollState.Idle;_universe.value=UniverseState.Loading
        savedState["screen"]="universe";store.writeScreen("universe")
        viewModelScope.launch {
            try{
                val actual=api.getUniverse()
                if(request.universeId.isBlank() || request.universeId!=actual.universeId){
                    purgeForScope(actual.universeId,actual.privacyEpoch)
                    applyUniverse(actual,false,version)
                    _historyClear.value=HistoryClearState.NeedsConfirmation(
                        "This device is connected to a different universe. Review and confirm again."
                    )
                } else completeHistoryClear(api.clearScrollHistory(request),request,version)
            }
            catch(e:Exception){handleHistoryClearFailure(e,version)}
            finally{reconciling=false}
        }
    }

    private suspend fun completeHistoryClear(receipt:HistoryClearReceipt,request:HistoryClearRequest,version:Long){
        if(version!=navigationVersion)return
        check(receipt.privacyEpoch>request.expectedPrivacyEpoch){"Clear receipt did not advance privacy state"}
        purgeForScope(request.universeId,receipt.privacyEpoch)
        _historyClear.value=HistoryClearState.Idle
        try{applyUniverse(api.getUniverse(),restoreStoredScroll=false,version=version)}
        catch(error:Exception){
            failClosed("History was cleared, but the current universe could not be refreshed.")
            _historyClear.value=HistoryClearState.ReconcileUnavailable(
                "History was cleared. Reconnect to load the current universe."
            )
        }
    }

    private suspend fun handleHistoryClearFailure(error:Exception,version:Long){
        if(version!=navigationVersion)return
        when {
            error is ApiException.Server && error.statusCode==409 -> {
                store.clearPendingClear()
                val actual=runCatching{api.getUniverse()}.getOrNull()
                if(actual!=null)applyUniverse(actual,false,version)
                else failClosed("History changed, but the current privacy state is unavailable.")
                _historyClear.value=HistoryClearState.NeedsConfirmation(
                    "Your history changed before clearing. Review the effects and confirm again."
                )
            }
            error is ApiException.Server && error.statusCode==401 -> {
                failClosed("This device session is no longer available.")
                _historyClear.value=HistoryClearState.SessionUnavailable(
                    "This device was signed out. Reconnect this development session before clearing history."
                )
            }
            else -> {
                failClosed("The clear result is uncertain. Retry to safely check the same request.")
                _historyClear.value=HistoryClearState.Retryable(
                    "The clear result is uncertain. Retry uses the same saved request."
                )
            }
        }
    }

    private fun reconcilePrivacy(restoreStoredScroll:Boolean,queueIfBusy:Boolean=false,retrySignOutFirst:Boolean=false){
        if(reconciling){if(queueIfBusy)reconcileAfterCurrent=restoreStoredScroll;return}
        reconciling=true;ready=false;busy=false
        if(retrySignOutFirst){signOutBusy=true;_signOut.value=SignOutState.Revoking}
        val version=++navigationVersion
        val storedScreen=store.readScreen()
        val wantedScroll=restoreStoredScroll && storedScreen=="scroll"
        val wantedRevisit=restoreStoredScroll && storedScreen=="revisit"
        if(wantedScroll){_screen.value=Screen.Scroll("");_scroll.value=ScrollState.Loading}
        else if(wantedRevisit){_screen.value=Screen.TraceRevisit("");_scroll.value=ScrollState.Loading}
        else{_screen.value=Screen.Universe;_universe.value=UniverseState.Loading}
        viewModelScope.launch {
            try {
                // #91 review fix: resolve a restored ambiguous sign-out fully, in this same
                // coroutine, before this (possibly now-dead) token is reused for anything
                // else. A resolved sign-out stops here; it never also fetches the universe.
                if(!continueReconcilingAfterSignOutRetry(retrySignOutFirst,::attemptSignOutRevoke){_signOut.value is SignOutState.SignedOut})return@launch
                val actual=api.getUniverse()
                val pending=store.readPendingClear()
                val localUniverse=store.readObservedUniverseId()
                val bindingUnknown=localUniverse.isBlank()
                val bindingChanged=localUniverse.isNotBlank() && localUniverse!=actual.universeId
                val pendingMismatch=pending!=null && (pending.universeId.isBlank() || pending.universeId!=actual.universeId)
                if(bindingUnknown || bindingChanged || pendingMismatch){
                    purgeForScope(actual.universeId,actual.privacyEpoch)
                    applyUniverse(actual,false,version)
                    if(pending!=null)_historyClear.value=HistoryClearState.NeedsConfirmation(
                        "This device is connected to a different universe. Review and confirm again."
                    )
                } else if(pending!=null){
                    _historyClear.value=HistoryClearState.Clearing
                    completeHistoryClear(api.clearScrollHistory(pending),pending,version)
                } else {
                    applyUniverse(actual,wantedScroll || wantedRevisit,version)
                }
            } catch(e:Exception){
                if(store.readPendingClear()!=null)handleHistoryClearFailure(e,version)
                else {
                    if(reconciliationFailurePurgesPrivateState(e)){
                        val scope=revisit
                        purgeForScope(
                            scope?.universeId?.takeIf { it.isNotBlank() } ?: observedUniverseId,
                            maxOf(observedPrivacyEpoch,scope?.privacyEpoch ?: 0L)
                        )
                    }
                    failClosed(message(e))
                }
            } finally{
                if(retrySignOutFirst)signOutBusy=false
                reconciling=false
                val next=reconcileAfterCurrent
                reconcileAfterCurrent=null
                if(next!=null)reconcilePrivacy(next)
            }
        }
    }

    private fun applyUniverse(actual:Universe,restoreStoredScroll:Boolean,version:Long){
        if(version!=navigationVersion)return
        if(observedUniverseId.isNotBlank() && actual.universeId!=observedUniverseId){
            purgeForScope(actual.universeId,actual.privacyEpoch)
        } else if(actual.privacyEpoch<observedPrivacyEpoch){
            failClosed("The server returned an older privacy state. Reconnect before restoring Scroll history.")
            return
        }
        if(actual.privacyEpoch>observedPrivacyEpoch)purgeForScope(actual.universeId,actual.privacyEpoch)
        observedUniverseId=actual.universeId
        observedPrivacyEpoch=store.observePrivacyState(actual.universeId,actual.privacyEpoch)
        _universe.value=UniverseState.Loaded(actual)
        _historyClear.value=HistoryClearState.Idle
        ready=true
        val cached=if(restoreStoredScroll && store.readScreen()=="scroll")runCatching{store.read()}.getOrNull() else null
        val cachedRevisit=if(restoreStoredScroll && store.readScreen()=="revisit")store.readRevisit() else null
        if(cached!=null && cached.privacyEpoch==observedPrivacyEpoch && cached.universeId==observedUniverseId && store.readPendingClear()==null){
            session=cached;show(cached)
        } else if(cachedRevisit!=null && cachedRevisit.privacyEpoch==observedPrivacyEpoch && cachedRevisit.universeId==observedUniverseId && store.readPendingClear()==null){
            revisit=cachedRevisit
            loadTraceRevisit(cachedRevisit,restoring=true)
        } else {
            if(cached!=null || cachedRevisit!=null || (restoreStoredScroll && store.readScreen()=="revisit"))purgeForScope(observedUniverseId,observedPrivacyEpoch)
            _screen.value=Screen.Universe;savedState["screen"]="universe";store.writeScreen("universe")
        }
    }

    private fun purgeForScope(universeId:String,epoch:Long){
        store.purgePrivateState(universeId,epoch)
        observedUniverseId=store.readObservedUniverseId()
        observedPrivacyEpoch=store.readObservedPrivacyEpoch()
        session=null;visited.clear()
        revisit=null
        _scroll.value=ScrollState.Idle
        _screen.value=Screen.Universe
        savedState["screen"]="universe"
    }

    private fun failClosed(reason:String){
        ready=false;session=null
        _screen.value=Screen.Universe
        _scroll.value=ScrollState.Idle
        _universe.value=UniverseState.Unavailable(reason)
    }

    private fun discardRevisit(){
        revisit=null
        store.clearRevisit()
    }

    private fun operationIsCurrent(version:Long,epoch:Long,value:ScrollSession?=null):Boolean {
        if(version!=navigationVersion || epoch!=observedPrivacyEpoch || store.readPendingClear()!=null)return false
        if(value!=null){
            val current=session ?: return false
            if(current.clientEventId!=value.clientEventId || current.item.assetId!=value.item.assetId || current.universeId!=observedUniverseId)return false
        }
        return true
    }

    private fun message(e:Exception):String {
        if(e is CancellationException)throw e
        return when(e){
            is ApiException.MissingToken -> "This development build is not connected yet."
            is ApiException.InteractionConflict -> "This action could not be matched. Your existing keep has not been changed."
            is ApiException.Server -> if(e.statusCode==401) "This device session is no longer available."
                else "Connection interrupted. Please retry; your action keeps the same identity."
            else -> "Connection interrupted. Please retry; your action keeps the same identity."
        }
    }
}

/** Refuse a response that cannot be tied back to the Trace card and reconciled scope. */
internal fun acceptTraceRevisit(
    receipt:TraceRevisit,
    requested:TraceRevisitSession,
    universeId:String,
    privacyEpoch:Long
):TraceRevisitSession? {
    if(receipt.traceEventId!=requested.eventId || receipt.universeId!=universeId ||
        receipt.privacyEpoch!=privacyEpoch || receipt.scroll.assetId!=requested.assetId ||
        receipt.exposureId.isBlank() || receipt.scroll.kind!="Scroll" || receipt.scroll.truthState!="documented" || receipt.scroll.revision<=0 ||
        requested.revision?.let { it!=receipt.scroll.revision }==true
    ) return null
    return requested.copy(revision=receipt.scroll.revision)
}

/** Only an unavailable transport/service leaves a private revisit identity for explicit retry. */
internal fun reconciliationFailurePurgesPrivateState(error:Exception):Boolean = when(error) {
    is ApiException.Network -> false
    is ApiException.Server -> error.statusCode !in 500..599 && error.statusCode!=429
    else -> true
}

/** Cold-start ordering gate (#91 review fix). A restored ambiguous sign-out must fully
 * resolve -- successfully or not -- before anything else reuses the same possibly-dead
 * session token, in one sequential path, never as a second concurrently launched
 * request. [retrySignOut] is only invoked (and only awaited to completion) when
 * [retrySignOutFirst] is set; the caller must not proceed to reuse the token (e.g. fetch
 * the universe) when this returns false, because the retry itself already reached a
 * durable signed-out outcome. */
internal suspend fun continueReconcilingAfterSignOutRetry(
    retrySignOutFirst:Boolean,
    retrySignOut:suspend ()->Unit,
    isSignedOutNow:()->Boolean
):Boolean {
    if(!retrySignOutFirst)return true
    retrySignOut()
    return !isSignedOutNow()
}
