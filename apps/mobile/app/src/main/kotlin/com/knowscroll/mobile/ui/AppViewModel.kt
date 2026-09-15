package com.knowscroll.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.knowscroll.mobile.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface Screen { data object Universe: Screen; data class Scroll(val assetId:String):Screen }
sealed interface UniverseState { data object Loading:UniverseState; data class Loaded(val universe:Universe):UniverseState; data class Unavailable(val message:String):UniverseState }
sealed interface ScrollState {
    data object Idle:ScrollState; data object Loading:ScrollState
    data class Reading(val item:ScrollItem,val exposureId:String,val eventId:String,val keep:KeepState,val readingPosition:Int):ScrollState
    data class Unavailable(val message:String):ScrollState
}
sealed interface KeepState {
    data object Idle:KeepState; data object Saving:KeepState
    data class Kept(val jobId:String):KeepState; data class Failed(val message:String):KeepState
    data class Conflict(val message:String):KeepState
}
class AppViewModel(application:Application,private val savedState:SavedStateHandle):AndroidViewModel(application) {
    private val api=ApiClient(); private val store=StateStore(application)
    private var session:ScrollSession?=runCatching { store.read() }.getOrNull()
    private var busy=false
    private var navigationVersion=0L
    private val visited=store.readVisited().toMutableSet()
    private val _screen=MutableStateFlow<Screen>(Screen.Universe); val screen=_screen.asStateFlow()
    private val _universe=MutableStateFlow<UniverseState>(UniverseState.Loading); val universe=_universe.asStateFlow()
    private val _scroll=MutableStateFlow<ScrollState>(ScrollState.Idle); val scroll=_scroll.asStateFlow()
    private val _toast=MutableStateFlow<String?>(null); val toast=_toast.asStateFlow()
    init {
        if(store.readScreen()=="scroll") session?.let { show(it) }
        loadUniverse()
    }
    fun consumeToast(){_toast.value=null}
    fun retryUniverse()=loadUniverse()
    fun retryScrollLoad()=enterScroll()
    fun enterScroll(){
        if(busy)return
        val s=session
        if(s!=null && s.keepJobId.isEmpty()){show(s);return}
        loadNext()
    }
    fun nextScroll(){if(!busy)loadNext()}
    private fun loadNext(){
        busy=true;val version=++navigationVersion;_screen.value=Screen.Scroll("");savedState["screen"]="scroll";store.writeScreen("scroll");_scroll.value=ScrollState.Loading
        session?.let{visited.add(it.item.assetId);store.writeVisited(visited)}
        viewModelScope.launch {
            try {
                val feed=api.getFeed();val item=feed.items.firstOrNull{it.assetId !in visited}
                if(version!=navigationVersion || _screen.value !is Screen.Scroll)return@launch
                if(item==null){_scroll.value=ScrollState.Unavailable("You have reached the end of this starting library.");return@launch}
                val s=ScrollSession(feed.decisionId,item);store.write(s);session=s;show(s)
            } catch(e:Exception){if(version==navigationVersion && _screen.value is Screen.Scroll)_scroll.value=ScrollState.Unavailable(message(e))} finally{busy=false}
        }
    }
    private fun show(s:ScrollSession){
        _screen.value=Screen.Scroll(s.item.assetId);savedState["screen"]="scroll";store.writeScreen("scroll")
        _scroll.value=ScrollState.Reading(s.item,s.exposureId,s.exposureEventId,if(s.keepJobId.isEmpty())KeepState.Idle else KeepState.Kept(s.keepJobId),s.readingPosition)
    }
    /** Called by the resumed Compose screen after display frames, never by candidate retrieval. */
    fun onVisible(assetId:String){
        val s=session ?: return
        if(s.item.assetId!=assetId || s.exposureId.isNotEmpty() || busy)return
        viewModelScope.launch {
            busy=true
            try { val next=recordExposure(s);session=next;if((_screen.value as? Screen.Scroll)?.assetId==assetId)show(next) }
            catch(e:Exception){_toast.value=message(e)} finally{busy=false}
        }
    }
    private suspend fun recordExposure(s:ScrollSession):ScrollSession {
        if(s.exposureId.isNotEmpty())return s
        val r=api.postExposure(ExposureRequest(s.decisionId,s.item.assetId,s.clientExposureId))
        val latest=session?.takeIf{it.clientExposureId==s.clientExposureId && it.item.assetId==s.item.assetId} ?: s
        return latest.copy(exposureId=r.exposureId,exposureEventId=r.eventId).also{store.write(it)}
    }
    fun keep(){
        if(busy)return
        val s=session ?: return
        if(s.keepJobId.isNotEmpty())return
        busy=true
        val current=_scroll.value as? ScrollState.Reading ?: run{busy=false;return}
        val version=navigationVersion
        _scroll.value=current.copy(keep=KeepState.Saving)
        viewModelScope.launch {
            try {
                val exposed=recordExposure(s);session=exposed
                val receipt=api.postInteraction(InteractionRequest(exposed.clientEventId,exposed.exposureId,exposed.item.assetId,"keep"))
                check(receipt.status=="accepted") { "Keep was not accepted" }
                val latest=session?.takeIf{it.clientEventId==exposed.clientEventId && it.item.assetId==exposed.item.assetId} ?: exposed
                val kept=latest.copy(keepJobId=receipt.jobId,keepEventId=receipt.eventId)
                store.write(kept);session=kept
                if(version==navigationVersion && (_screen.value as? Screen.Scroll)?.assetId==kept.item.assetId)show(kept)
                viewModelScope.launch {
                    repeat(20){
                        delay(250)
                        val projected=runCatching{api.getEvent(receipt.eventId).projected}.getOrDefault(false)
                        if(projected){if(_screen.value is Screen.Universe)loadUniverse();return@launch}
                    }
                }
            } catch(e:Exception){if(version==navigationVersion && (_screen.value as? Screen.Scroll)?.assetId==s.item.assetId)(_scroll.value as? ScrollState.Reading)?.let{_scroll.value=it.copy(keep=KeepState.Failed(message(e)))}} finally{busy=false}
        }
    }
    fun updateReadingPosition(assetId:String,position:Int){
        val s=session ?: return
        if(s.item.assetId!=assetId || s.readingPosition==position)return
        val updated=s.copy(readingPosition=position);store.writeReadingPosition(assetId,position);session=updated
    }
    fun returnToUniverse(){
        navigationVersion++;visited.clear();store.writeVisited(visited)
        _screen.value=Screen.Universe;savedState["screen"]="universe";store.writeScreen("universe");loadUniverse()
    }
    private fun loadUniverse(){viewModelScope.launch{
        _universe.value=UniverseState.Loading
        try{_universe.value=UniverseState.Loaded(api.getUniverse())}catch(e:Exception){_universe.value=UniverseState.Unavailable(message(e))}
    }}
    private fun message(e:Exception):String {
        if(e is CancellationException)throw e
        return when(e){
            is ApiException.MissingToken -> "This development build is not connected yet."
            is ApiException.InteractionConflict -> "This action could not be matched. Your existing keep has not been changed."
            else -> "Connection interrupted. Please retry; your action keeps the same identity."
        }
    }
}
