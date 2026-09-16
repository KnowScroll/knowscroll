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
import com.knowscroll.mobile.data.Universe
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface Screen { data object Universe: Screen; data class Scroll(val assetId:String):Screen }
sealed interface UniverseState {
    data object Loading:UniverseState
    data class Loaded(val universe:Universe):UniverseState
    data class Unavailable(val message:String):UniverseState
}
sealed interface ScrollState {
    data object Idle:ScrollState
    data object Loading:ScrollState
    data class Reading(val item:ScrollItem,val exposureId:String,val eventId:String,val keep:KeepState,val readingPosition:Int):ScrollState
    data class Unavailable(val message:String):ScrollState
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
    private var observedPrivacyEpoch=store.readObservedPrivacyEpoch()
    private var busy=false
    private var reconciling=false
    private var ready=false
    private var navigationVersion=0L
    private val visited=store.readVisited().toMutableSet()
    private val _screen=MutableStateFlow<Screen>(Screen.Universe); val screen=_screen.asStateFlow()
    private val _universe=MutableStateFlow<UniverseState>(UniverseState.Loading); val universe=_universe.asStateFlow()
    private val _scroll=MutableStateFlow<ScrollState>(ScrollState.Idle); val scroll=_scroll.asStateFlow()
    private val _historyClear=MutableStateFlow<HistoryClearState>(HistoryClearState.Idle); val historyClear=_historyClear.asStateFlow()
    private val _toast=MutableStateFlow<String?>(null); val toast=_toast.asStateFlow()

    init { reconcilePrivacy(restoreStoredScroll=true) }

    fun consumeToast(){_toast.value=null}
    fun onForeground(){reconcilePrivacy(restoreStoredScroll=true)}
    fun retryUniverse()=reconcilePrivacy(restoreStoredScroll=store.readScreen()=="scroll")
    fun retryScrollLoad()=enterScroll()

    fun enterScroll(){
        if(busy || reconciling || !ready || store.readPendingClear()!=null)return
        val current=session
        if(current!=null && current.keepJobId.isEmpty() && current.privacyEpoch==observedPrivacyEpoch){show(current);return}
        loadNext()
    }

    fun nextScroll(){if(!busy && ready)loadNext()}

    private fun loadNext(){
        busy=true
        val version=++navigationVersion
        val epoch=observedPrivacyEpoch
        _screen.value=Screen.Scroll("")
        savedState["screen"]="scroll"
        store.writeScreen("scroll")
        _scroll.value=ScrollState.Loading
        session?.let{visited.add(it.item.assetId);store.writeVisited(visited)}
        viewModelScope.launch {
            try {
                val feed=api.getFeed()
                if(!operationIsCurrent(version,epoch))return@launch
                if(feed.privacyEpoch!=epoch){
                    if(feed.privacyEpoch>epoch)purgeForEpoch(feed.privacyEpoch)
                    failClosed("Privacy state changed. Return to your universe and try again.")
                    return@launch
                }
                val item=feed.items.firstOrNull{it.assetId !in visited}
                if(item==null){_scroll.value=ScrollState.Unavailable("You have reached the end of this starting library.");return@launch}
                val next=ScrollSession(feed.decisionId,item,feed.privacyEpoch)
                if(!operationIsCurrent(version,epoch))return@launch
                store.write(next);session=next;show(next)
            } catch(e:Exception){
                if(version==navigationVersion && _screen.value is Screen.Scroll)_scroll.value=ScrollState.Unavailable(message(e))
            } finally{if(version==navigationVersion)busy=false}
        }
    }

    private fun show(value:ScrollSession){
        if(value.privacyEpoch!=observedPrivacyEpoch || store.readPendingClear()!=null)return
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
        val current=session ?: return
        if(current.item.assetId!=assetId || current.exposureId.isNotEmpty() || busy || !ready)return
        val version=navigationVersion
        val epoch=observedPrivacyEpoch
        busy=true
        viewModelScope.launch {
            try {
                val next=recordExposure(current,version,epoch)
                if(operationIsCurrent(version,epoch)){session=next;show(next)}
            } catch(e:Exception){if(e !is CancellationException)_toast.value=message(e)}
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
                    (_scroll.value as? ScrollState.Reading)?.let{_scroll.value=it.copy(keep=KeepState.Failed(message(e)))}
                }
            } finally{if(version==navigationVersion)busy=false}
        }
    }

    fun updateReadingPosition(assetId:String,position:Int){
        val current=session ?: return
        if(current.item.assetId!=assetId || current.readingPosition==position || current.privacyEpoch!=observedPrivacyEpoch || store.readPendingClear()!=null)return
        val updated=current.copy(readingPosition=position)
        store.writeReadingPosition(assetId,position)
        session=updated
    }

    fun returnToUniverse(){
        navigationVersion++
        visited.clear();store.writeVisited(visited)
        _screen.value=Screen.Universe
        savedState["screen"]="universe";store.writeScreen("universe")
        reconcilePrivacy(restoreStoredScroll=false)
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
        val request=HistoryClearRequest(UUID.randomUUID().toString(),current.privacyEpoch)
        store.writePendingClear(request)
        beginHistoryClear(request)
    }

    fun retryHistoryClear(){
        val pending=store.readPendingClear()
        if(pending!=null)beginHistoryClear(pending) else reconcilePrivacy(false)
    }

    private fun beginHistoryClear(request:HistoryClearRequest){
        if(reconciling)return
        reconciling=true;ready=false;busy=false
        val version=++navigationVersion
        _historyClear.value=HistoryClearState.Clearing
        _screen.value=Screen.Universe;_scroll.value=ScrollState.Idle;_universe.value=UniverseState.Loading
        savedState["screen"]="universe";store.writeScreen("universe")
        viewModelScope.launch {
            try{completeHistoryClear(api.clearScrollHistory(request),request,version)}
            catch(e:Exception){handleHistoryClearFailure(e,version)}
            finally{reconciling=false}
        }
    }

    private suspend fun completeHistoryClear(receipt:HistoryClearReceipt,request:HistoryClearRequest,version:Long){
        if(version!=navigationVersion)return
        check(receipt.privacyEpoch>request.expectedPrivacyEpoch){"Clear receipt did not advance privacy state"}
        purgeForEpoch(receipt.privacyEpoch)
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

    private fun reconcilePrivacy(restoreStoredScroll:Boolean){
        if(reconciling)return
        reconciling=true;ready=false
        val version=++navigationVersion
        val wantedScroll=restoreStoredScroll && store.readScreen()=="scroll"
        if(wantedScroll){_screen.value=Screen.Scroll("");_scroll.value=ScrollState.Loading}
        else{_screen.value=Screen.Universe;_universe.value=UniverseState.Loading}
        viewModelScope.launch {
            try {
                val pending=store.readPendingClear()
                if(pending!=null){
                    _historyClear.value=HistoryClearState.Clearing
                    completeHistoryClear(api.clearScrollHistory(pending),pending,version)
                } else {
                    applyUniverse(api.getUniverse(),wantedScroll,version)
                }
            } catch(e:Exception){
                if(store.readPendingClear()!=null)handleHistoryClearFailure(e,version)
                else failClosed(message(e))
            } finally{reconciling=false}
        }
    }

    private fun applyUniverse(actual:Universe,restoreStoredScroll:Boolean,version:Long){
        if(version!=navigationVersion)return
        if(actual.privacyEpoch<observedPrivacyEpoch){
            failClosed("The server returned an older privacy state. Reconnect before restoring Scroll history.")
            return
        }
        if(actual.privacyEpoch>observedPrivacyEpoch)purgeForEpoch(actual.privacyEpoch)
        observedPrivacyEpoch=store.observePrivacyEpoch(actual.privacyEpoch)
        _universe.value=UniverseState.Loaded(actual)
        _historyClear.value=HistoryClearState.Idle
        ready=true
        val cached=if(restoreStoredScroll)runCatching{store.read()}.getOrNull() else null
        if(cached!=null && cached.privacyEpoch==observedPrivacyEpoch && store.readPendingClear()==null){
            session=cached;show(cached)
        } else {
            if(cached!=null)purgeForEpoch(observedPrivacyEpoch)
            _screen.value=Screen.Universe;savedState["screen"]="universe";store.writeScreen("universe")
        }
    }

    private fun purgeForEpoch(epoch:Long){
        store.purgePrivateState(epoch)
        observedPrivacyEpoch=store.readObservedPrivacyEpoch()
        session=null;visited.clear()
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

    private fun operationIsCurrent(version:Long,epoch:Long,value:ScrollSession?=null):Boolean {
        if(version!=navigationVersion || epoch!=observedPrivacyEpoch || store.readPendingClear()!=null)return false
        if(value!=null){
            val current=session ?: return false
            if(current.clientEventId!=value.clientEventId || current.item.assetId!=value.item.assetId)return false
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
