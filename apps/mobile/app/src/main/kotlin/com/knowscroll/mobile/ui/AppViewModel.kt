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
import com.knowscroll.mobile.data.WorldSystemResponse
import com.knowscroll.mobile.data.BranchFrom
import com.knowscroll.mobile.data.BranchOpenRequest
import com.knowscroll.mobile.ui.branch.BranchOpenConflict
import com.knowscroll.mobile.ui.branch.BranchPanel
import com.knowscroll.mobile.ui.branch.branchAvailabilityOf
import com.knowscroll.mobile.ui.branch.branchOpenConflict
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
    /** docs/product/ui-system.md sec.5b/5c's system level (#116, ADR-0028/#113): a read-only view
     * of the real, derived worlds/system geography. No network fetch of its own on entry into
     * this sealed value -- see `enterSystem()`. */
    data object System: Screen
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
    /** #131: opened by taking a sourced connection from [fromTitle]; Back returns there exactly. */
    data class Branch(val fromTitle:String,val relationSentence:String,val recorded:Boolean):ReaderOrigin
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

/** ADR-0028/#113: a read-only view of the real, derived worlds/system geography (docs/product/
 * ui-system.md sec.5b/5c, #116). Mirrors the web lane's `SystemView` (`claude/116-system-view`'s
 * `apps/web/src/state/readerStore.ts`): never persisted across process death, unlike `ScrollState`
 * -- a fresh entry always re-reads `GET /v1/worlds` rather than risking a stale count. */
sealed interface SystemState {
    data object Idle:SystemState
    data object Loading:SystemState
    data class Loaded(val response:WorldSystemResponse):SystemState
    data class Unavailable(val message:String):SystemState
}

class AppViewModel(application:Application,private val savedState:SavedStateHandle):AndroidViewModel(application) {
    private val api=ApiClient()
    private val store=StateStore(application)
    private var feedJob: kotlinx.coroutines.Job? = null
    private var pendingCableMode: String? = null
    private val _cableMode = MutableStateFlow(store.readCableMode()); val cableMode = _cableMode.asStateFlow()
    private var session:ScrollSession?=null
    private var revisit:TraceRevisitSession?=null
    private var observedPrivacyEpoch=store.readObservedPrivacyEpoch()
    private var observedUniverseId=store.readObservedUniverseId()
    private var busy=false
    private var signOutBusy=false
    private var reconciling=false
    private var reconcileAfterCurrent:Boolean?=null
    private val _authorityReady=MutableStateFlow(false); val authorityReady=_authorityReady.asStateFlow()
    private var ready=false
        set(value) { field=value; _authorityReady.value=value }
    private var navigationVersion=0L
    private val visited=store.readVisited().toMutableSet()
    private val _screen=MutableStateFlow<Screen>(Screen.Universe); val screen=_screen.asStateFlow()
    private val _universe=MutableStateFlow<UniverseState>(UniverseState.Loading); val universe=_universe.asStateFlow()
    private val _scroll=MutableStateFlow<ScrollState>(ScrollState.Idle); val scroll=_scroll.asStateFlow()
    private val _historyClear=MutableStateFlow<HistoryClearState>(HistoryClearState.Idle); val historyClear=_historyClear.asStateFlow()
    private val _signOut=MutableStateFlow<SignOutState>(SignOutState.Idle); val signOut=_signOut.asStateFlow()
    private val _system=MutableStateFlow<SystemState>(SystemState.Idle); val system=_system.asStateFlow()
    private val _toast=MutableStateFlow<String?>(null); val toast=_toast.asStateFlow()
    /** #131: live continuations for the Scroll being read (null when none apply). */
    private val _branches=MutableStateFlow<BranchPanel?>(null); val branches=_branches.asStateFlow()
    private var branchJob:kotlinx.coroutines.Job?=null
    /** Origins a reader branched away from, newest last; validated against scope before use. */
    private val branchTrail=store.readBranchTrail().toMutableList()
    /** Same key and payload after an ambiguous objection (in-memory; objections are idempotent). */
    private val pendingFeedback=mutableMapOf<String,String>()

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

    fun enterScrollFromSystem() {
        if(busy || reconciling || !ready)return
        savedState["readerFromSystem"] = true
        enterScroll()
    }

    fun returnFromReader() {
        pendingCableMode=null
        if(returnAlongBranch())return
        branchTrail.clear();store.writeBranchTrail(branchTrail)
        _branches.value=null
        if(savedState.get<Boolean>("readerFromSystem") == true) {
            savedState["readerFromSystem"] = false
            // Returning must work while an exposure is in flight. Invalidate only its UI
            // callback; its persisted retry identity remains available for reconciliation.
            navigationVersion++
            _screen.value = Screen.System
            _system.value = SystemState.Loading
            savedState["screen"] = "universe"
            store.writeScreen("universe")
            reconcilePrivacy(restoreStoredScroll=true,queueIfBusy=true)
        } else returnToUniverse()
    }

    fun onMediaAuthorityFailure() {
        purgeForScope(observedUniverseId, observedPrivacyEpoch)
        failClosed("This video is no longer available. Reconnect to check your session.")
    }

    /** GET cancellation invalidates UI delivery. In-flight writes finish with their original envelope. */
    fun selectCableMode(kind: String) {
        require(kind in setOf("Scroll", "Reel"))
        if (kind == _cableMode.value) { pendingCableMode = null; return }
        if (!ready || reconciling || (busy && feedJob?.isActive != true)) { pendingCableMode = kind; return }
        navigationVersion++
        feedJob?.cancel(); feedJob = null
        busy = false
        session?.let(store::write)
        discardRevisit()
        _cableMode.value = kind; store.writeCableMode(kind)
        session = runCatching { store.readCableSession(kind) }.getOrNull()?.takeIf {
            it.universeId == observedUniverseId && it.privacyEpoch == observedPrivacyEpoch
        }
        val retained = session
        if (retained != null) { store.write(retained); show(retained) } else loadNext()
    }

    private fun drainCableMode() {
        val next = pendingCableMode ?: return
        if (busy || reconciling || !ready) return
        pendingCableMode = null
        if (_screen.value is Screen.Scroll) selectCableMode(next)
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
        feedJob = viewModelScope.launch {
            try {
                val feed=api.getFeed(_cableMode.value)
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
                        // A newly discovered encounter starts a fresh line of travel.
                        branchTrail.clear();store.writeBranchTrail(branchTrail)
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
            } finally{if(version==navigationVersion){busy=false;feedJob=null;drainCableMode()}}
        }
    }

    private fun show(value:ScrollSession){
        if(value.privacyEpoch!=observedPrivacyEpoch || value.universeId!=observedUniverseId || store.readPendingClear()!=null)return
        _cableMode.value=value.item.kind;store.writeCableMode(value.item.kind)
        _screen.value=Screen.Scroll(value.item.assetId)
        savedState["screen"]="scroll"
        store.writeScreen("scroll")
        _scroll.value=ScrollState.Reading(
            value.item,value.exposureId,value.exposureEventId,
            if(value.keepJobId.isEmpty())KeepState.Idle else KeepState.Kept(value.keepJobId),
            value.readingPosition,
            origin=value.branchFrom?.let{ReaderOrigin.Branch(it.fromTitle,it.relationSentence,it.recorded)} ?: ReaderOrigin.Discovery
        )
        val panel=_branches.value
        if(panel==null || panel.assetId!=value.item.assetId || panel.availability is BranchAvailability.Failed)refreshBranches(value.item)
    }

    /** #131: a read of the live continuations; never blocks reading, never retried blindly. */
    private fun refreshBranches(item:ScrollItem){
        branchJob?.cancel()
        if(item.kind!="Scroll"){_branches.value=null;return}
        val epoch=observedPrivacyEpoch
        val universeId=observedUniverseId
        // A refresh of the same encounter keeps the current list until the answer arrives: flashing
        // the shorter Loading rail under a reader moves the document they are reading.
        if(_branches.value?.assetId!=item.assetId || _branches.value?.availability is BranchAvailability.Failed)
            _branches.value=BranchPanel(item.assetId,BranchAvailability.Loading)
        branchJob=viewModelScope.launch {
            try {
                val result=api.getBranches(item.assetId)
                if(epoch!=observedPrivacyEpoch || universeId!=observedUniverseId || (_scroll.value as? ScrollState.Reading)?.item?.assetId!=item.assetId)return@launch
                if(result.privacyEpoch!=epoch){reconcilePrivacy(restoreStoredScroll=true,queueIfBusy=true);return@launch}
                _branches.value=BranchPanel(item.assetId,branchAvailabilityOf(result,item),result.branches)
            } catch(e:Exception){
                if(e is CancellationException)throw e
                if((_scroll.value as? ScrollState.Reading)?.item?.assetId!=item.assetId)return@launch
                if(e is ApiException.MissingToken || e is ApiException.Server && e.statusCode==401){purgeForScope(universeId,epoch);failClosed(message(e))}
                else _branches.value=BranchPanel(item.assetId,BranchAvailability.Failed)
            }
        }
    }

    fun retryBranches(){(_scroll.value as? ScrollState.Reading)?.item?.let(::refreshBranches)}

    /** #131: take a live continuation. The origin is exposed first (a branch starts from a real
     * encounter), the request envelope is persisted before dispatch, and the origin — with its
     * exact reading position — is pushed onto the return trail only once the target is served. */
    fun openBranch(branchId:String){
        if(busy || reconciling || !ready || store.readPendingClear()!=null)return
        val panel=_branches.value ?: return
        val branch=panel.branches.firstOrNull{it.branchId==branchId} ?: return
        val current=session ?: return
        if(current.item.assetId!=panel.assetId || panel.opening!=null)return
        busy=true
        val version=++navigationVersion
        val epoch=observedPrivacyEpoch
        _branches.value=panel.copy(opening=branchId,message=null)
        viewModelScope.launch {
            try {
                val exposed=recordExposure(current,version,epoch)
                if(!operationIsCurrent(version,epoch,current))return@launch
                session=exposed
                val request=store.readPendingBranch()?.takeIf{
                    it.fromExposureId==exposed.exposureId && it.bridgeId==branch.bridgeId && it.targetAssetId==branch.targetAssetId &&
                        it.expectedPrivacyEpoch==epoch && it.universeId==observedUniverseId
                } ?: BranchOpenRequest(UUID.randomUUID().toString(),exposed.exposureId,branch.bridgeId,branch.targetAssetId,epoch,observedUniverseId)
                    .also(store::writePendingBranch)
                val receipt=api.openBranch(request)
                if(!operationIsCurrent(version,epoch,exposed))return@launch
                if(receipt.feed.universeId!=observedUniverseId || receipt.feed.privacyEpoch!=epoch){
                    purgeForScope(receipt.feed.universeId,receipt.feed.privacyEpoch)
                    failClosed(getApplication<Application>().getString(com.knowscroll.mobile.R.string.reader_scope_changed))
                    return@launch
                }
                val next=ScrollSession(
                    receipt.feed.decisionId,receipt.feed.items.single(),receipt.feed.privacyEpoch,receipt.feed.universeId,
                    branchFrom=BranchFrom(exposed.item.assetId,exposed.item.title,branch.relationSentence,branch.bridgeId,receipt.recorded)
                )
                branchTrail.add(session ?: exposed);store.writeBranchTrail(branchTrail)
                store.clearPendingBranch()
                store.write(next);session=next;show(next)
            } catch(e:Exception){
                if(e is CancellationException)throw e
                if(version!=navigationVersion)return@launch
                val conflict=(e as? ApiException.Server)?.let(::branchOpenConflict)
                when {
                    conflict==BranchOpenConflict.StaleEpoch -> {store.clearPendingBranch();reconcilePrivacy(restoreStoredScroll=true,queueIfBusy=true)}
                    conflict==BranchOpenConflict.Unavailable -> {
                        store.clearPendingBranch()
                        refreshBranches(current.item)
                        _branches.value=_branches.value?.copy(message="That connection is no longer available.")
                    }
                    invalidatesReader(e) -> {purgeForScope(current.universeId,epoch);failClosed(message(e))}
                    else -> _branches.value=panel.copy(opening=null,message=message(e))
                }
            } finally{if(version==navigationVersion){busy=false;drainCableMode()}}
        }
    }

    /** #131: "not useful" / "seems wrong" hides a connection for this reader only. */
    fun objectToConnection(bridgeId:String,objection:String){
        if(!ready || reconciling)return
        val item=(_scroll.value as? ScrollState.Reading)?.item ?: return
        val epoch=observedPrivacyEpoch
        val key=pendingFeedback.getOrPut("$bridgeId:$objection"){UUID.randomUUID().toString()}
        viewModelScope.launch {
            try {
                api.postConnectionFeedback(key,bridgeId,epoch,objection)
                pendingFeedback.remove("$bridgeId:$objection")
                if(epoch!=observedPrivacyEpoch)return@launch
                _toast.value=getApplication<Application>().getString(com.knowscroll.mobile.R.string.connection_hidden)
                if((_scroll.value as? ScrollState.Reading)?.item?.assetId==item.assetId)refreshBranches(item)
            } catch(e:Exception){
                if(e is CancellationException)throw e
                if(e is ApiException.Server && e.statusCode==409){pendingFeedback.remove("$bridgeId:$objection");reconcilePrivacy(restoreStoredScroll=true,queueIfBusy=true)}
                else _toast.value=message(e)
            }
        }
    }

    /** System Back from a Scroll opened by a connection returns to where the reader branched from,
     * at their exact reading position. A trail from another scope is discarded, never shown. */
    private fun returnAlongBranch():Boolean{
        if(_screen.value !is Screen.Scroll || session?.branchFrom==null || branchTrail.isEmpty())return false
        val origin=branchTrail.removeAt(branchTrail.lastIndex)
        store.writeBranchTrail(branchTrail)
        if(origin.universeId!=observedUniverseId || origin.privacyEpoch!=observedPrivacyEpoch || store.readPendingClear()!=null){
            branchTrail.clear();store.writeBranchTrail(branchTrail);return false
        }
        // An exposure for the branch target may still be in flight: invalidate only its UI
        // callback. Its persisted retry identity remains on the stored session.
        navigationVersion++
        busy=false
        store.write(origin);session=origin;show(origin)
        return true
    }

    /** Home and the Atlas compass leave the reader entirely; the branch trail ends with it. */
    fun leaveReader(){
        branchTrail.clear();store.writeBranchTrail(branchTrail)
        returnFromReader()
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
            finally{if(version==navigationVersion){busy=false;drainCableMode()}}
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
            } finally{if(version==navigationVersion){busy=false;drainCableMode()}}
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
        if (current.item.assetId != assetId && position >= 0 && ready && store.readPendingClear() == null) {
            val parked = listOf("Scroll", "Reel").mapNotNull { store.readCableSession(it) }.firstOrNull {
                it.item.assetId == assetId && it.universeId == observedUniverseId && it.privacyEpoch == observedPrivacyEpoch
            }
            if (parked != null) store.writeReadingPosition(assetId, position)
            return
        }
        if(current.item.assetId!=assetId || current.readingPosition==position || current.privacyEpoch!=observedPrivacyEpoch || store.readPendingClear()!=null)return
        val updated=current.copy(readingPosition=position)
        store.writeReadingPosition(assetId,position)
        session=updated
        if(reading?.item?.assetId==assetId){
            _scroll.value=reading.copy(readingPosition=position)
        }
    }

    fun returnToUniverse(){
        pendingCableMode=null
        savedState["readerFromSystem"] = false
        navigationVersion++
        if(_screen.value is Screen.TraceRevisit)discardRevisit()
        visited.clear();store.writeVisited(visited)
        branchTrail.clear();store.writeBranchTrail(branchTrail)
        _branches.value=null
        _screen.value=Screen.Universe
        savedState["screen"]="universe";store.writeScreen("universe")
        reconcilePrivacy(restoreStoredScroll=false,queueIfBusy=true)
    }

    /** Reconcile authority before showing a fresh collection, retaining its destination only
     * when the server confirms the same universe and privacy epoch. */
    fun openKeep(){
        if(reconciling || !ready)return
        pendingCableMode=null
        navigationVersion++
        if(_screen.value is Screen.TraceRevisit)discardRevisit()
        store.writeScreen("universe")
        _screen.value=Screen.Keep
        reconcilePrivacy(restoreStoredScroll=true)
    }

    /** The system level (#116, ADR-0028/#113): reads the real, derived worlds/system geography.
     * Read-only -- it creates no event, holds no private per-Scroll session, and (mirroring the
     * web lane's `enterSystem()`) is never restored from storage on process death: a fresh entry
     * always re-reads `GET /v1/worlds` rather than risking a stale count. */
    fun enterSystem(){
        if(busy || reconciling || !ready)return
        busy=true
        val version=++navigationVersion
        val epoch=observedPrivacyEpoch
        val universeId=observedUniverseId
        _screen.value=Screen.System
        _system.value=SystemState.Loading
        viewModelScope.launch {
            try {
                val response=api.getWorldSystem()
                if(version!=navigationVersion || epoch!=observedPrivacyEpoch || universeId!=observedUniverseId)return@launch
                _system.value=SystemState.Loaded(response)
            } catch(e:Exception){
                if(e is CancellationException)throw e
                if(version!=navigationVersion)return@launch
                if(invalidatesReader(e)){
                    purgeForScope(universeId,epoch)
                    failClosed(message(e))
                } else {
                    _system.value=SystemState.Unavailable(message(e))
                }
            } finally{ if(version==navigationVersion)busy=false }
        }
    }

    fun retrySystem(){
        if(_screen.value is Screen.System)enterSystem()
    }

    /** Leaves the system view without touching any scroll/revisit session or re-fetching the
     * universe -- unlike `returnToUniverse()`, nothing private was ever held here to purge. */
    fun returnFromSystem(){
        if(_screen.value !is Screen.System)return
        navigationVersion++ // invalidates any in-flight getWorldSystem() so a stale response cannot land
        busy=false
        _screen.value=Screen.Universe
        savedState["screen"]="universe";store.writeScreen("universe")
        _system.value=SystemState.Idle
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
        val retainedDestination = if(restoreStoredScroll && (_screen.value is Screen.System || _screen.value is Screen.Keep)) _screen.value else null
        val retainedUniverse=observedUniverseId
        val retainedEpoch=observedPrivacyEpoch
        val storedScreen=store.readScreen()
        val wantedScroll=retainedDestination==null && restoreStoredScroll && storedScreen=="scroll"
        val wantedRevisit=retainedDestination==null && restoreStoredScroll && storedScreen=="revisit"
        if(wantedScroll){_screen.value=Screen.Scroll("");_scroll.value=ScrollState.Loading}
        else if(wantedRevisit){_screen.value=Screen.TraceRevisit("");_scroll.value=ScrollState.Loading}
        else if(retainedDestination is Screen.System){_system.value=SystemState.Loading;_universe.value=UniverseState.Loading}
        else if(retainedDestination is Screen.Keep){_universe.value=UniverseState.Loading}
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
                    val sameScope=actual.universeId==retainedUniverse && actual.privacyEpoch==retainedEpoch
                    val destination=if(sameScope)retainedDestination ?: Screen.Universe else Screen.Universe
                    applyUniverse(actual,wantedScroll || wantedRevisit,version,destination)
                    if(destination is Screen.System && version==navigationVersion && ready){
                        val response=api.getWorldSystem()
                        if(version==navigationVersion && observedUniverseId==retainedUniverse && observedPrivacyEpoch==retainedEpoch){
                            _system.value=SystemState.Loaded(response)
                        }
                    }
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
                if(next!=null)reconcilePrivacy(next) else drainCableMode()
            }
        }
    }

    private fun applyUniverse(actual:Universe,restoreStoredScroll:Boolean,version:Long,destination:Screen=Screen.Universe){
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
        val restoringCable=restoreStoredScroll && store.readScreen()=="scroll"
        val cached=if(restoringCable)runCatching{store.readSelectedCableSession()}.getOrNull() else null
        val cachedRevisit=if(restoreStoredScroll && store.readScreen()=="revisit")store.readRevisit() else null
        if(cached!=null && cached.privacyEpoch==observedPrivacyEpoch && cached.universeId==observedUniverseId && store.readPendingClear()==null){
            session=cached;show(cached)
        } else if(cachedRevisit!=null && cachedRevisit.privacyEpoch==observedPrivacyEpoch && cachedRevisit.universeId==observedUniverseId && store.readPendingClear()==null){
            revisit=cachedRevisit
            loadTraceRevisit(cachedRevisit,restoring=true)
        } else if(restoringCable && cached==null && store.readPendingClear()==null){
            session=null
            _cableMode.value=store.readCableMode()
            _screen.value=Screen.Scroll("")
            _scroll.value=ScrollState.Unavailable("Opening ${_cableMode.value} was interrupted. Try again.")
        } else {
            if(cached!=null || cachedRevisit!=null || (restoreStoredScroll && store.readScreen()=="revisit"))purgeForScope(observedUniverseId,observedPrivacyEpoch)
            _screen.value=destination;savedState["screen"]="universe";store.writeScreen("universe")
        }
    }

    private fun purgeForScope(universeId:String,epoch:Long){
        pendingCableMode=null;feedJob?.cancel();feedJob=null
        savedState["readerFromSystem"] = false
        store.purgePrivateState(universeId,epoch)
        observedUniverseId=store.readObservedUniverseId()
        observedPrivacyEpoch=store.readObservedPrivacyEpoch()
        session=null;visited.clear()
        revisit=null
        branchJob?.cancel();branchTrail.clear();_branches.value=null;pendingFeedback.clear()
        _scroll.value=ScrollState.Idle
        _system.value=SystemState.Idle
        _screen.value=Screen.Universe
        savedState["screen"]="universe"
    }

    private fun failClosed(reason:String){
        ready=false;session=null
        _system.value=SystemState.Idle
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
