package com.knowscroll.mobile.ui.keep

import com.knowscroll.mobile.data.AwayResponse
import com.knowscroll.mobile.data.PassagesResponse
import com.knowscroll.mobile.data.RelicsResponse

/** #134 (ADR-0039): what changed while the reader was away, as last read from the server (the pages
 * read so far, newest first). The Atlas shows it only when [Loaded] has items; loading or a failed
 * load shows nothing there. */
sealed interface AwayState {
    data object Loading : AwayState
    data class Loaded(val response: AwayResponse) : AwayState
    data class Unavailable(val message: String) : AwayState
}

/** #134 (ADR-0039): the reader's Relics, as last read from the server (the pages read so far). */
sealed interface RelicsState {
    data object Loading : RelicsState
    data class Loaded(val response: RelicsResponse) : RelicsState
    data class Unavailable(val message: String) : RelicsState
}

/** #165 (ADR-0044): the claims of the Scroll on screen that the reader may keep or doubt. */
sealed interface PassagesState {
    data object Loading : PassagesState
    data class Loaded(val response: PassagesResponse) : PassagesState
    data class Unavailable(val message: String) : PassagesState
}

/** One explicit request ("Mark as seen", "Keep", "Seems wrong", "Let go"). [Failed.canRetry]: it
 * may have landed without its answer, so the same request is kept for an explicit retry; otherwise
 * it was definitively refused and nothing is kept. */
sealed interface ReturnActionState {
    data object Idle : ReturnActionState
    data object Working : ReturnActionState
    data class Failed(val message: String, val canRetry: Boolean) : ReturnActionState
}

/** What this client knows about one thing the reader may keep (a connection, a place, a passage, an
 * answer) beyond the lists: [kept] once a keep receipt or a list says so; [markedWrong] once a "seems
 * wrong" receipt, or a list the server wrote (a `doubted` Relic, an item's own `seemsWrong`), says so.
 * Both reset when the epoch changes (Clear and Reset erase them). */
data class KeepableState(
    val kept: Boolean = false,
    val markedWrong: Boolean = false,
    val keep: ReturnActionState = ReturnActionState.Idle,
    val seemsWrong: ReturnActionState = ReturnActionState.Idle,
)
