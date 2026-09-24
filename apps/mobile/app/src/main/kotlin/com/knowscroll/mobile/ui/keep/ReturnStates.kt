package com.knowscroll.mobile.ui.keep

import com.knowscroll.mobile.data.AwayResponse
import com.knowscroll.mobile.data.RelicsResponse

/** #134 (ADR-0039): what changed while the reader was away, as last read from the server. The
 * Atlas shows it only when [Loaded] has items; loading or a failed load shows nothing there. */
sealed interface AwayState {
    data object Loading : AwayState
    data class Loaded(val response: AwayResponse) : AwayState
    data class Unavailable(val message: String) : AwayState
}

/** #134 (ADR-0039): the reader's Relics, as last read from the server. */
sealed interface RelicsState {
    data object Loading : RelicsState
    data class Loaded(val response: RelicsResponse) : RelicsState
    data class Unavailable(val message: String) : RelicsState
}

/** One explicit request ("Mark as seen", "Keep", "Seems wrong", "Let go"). [Failed.canRetry]: it
 * may have landed without its answer, so the same request is kept for an explicit retry; otherwise
 * it was definitively refused and nothing is kept. */
sealed interface ReturnActionState {
    data object Idle : ReturnActionState
    data object Working : ReturnActionState
    data class Failed(val message: String, val canRetry: Boolean) : ReturnActionState
}

/** What this client knows about one connection (by bridge id) beyond the lists: [kept] is true once
 * a keep receipt or the Relic list says so; [markedWrong] once a "seems wrong" receipt, or a
 * `doubted` Relic, says so. Both reset when the epoch changes (Clear and Reset erase them). */
data class ConnectionState(
    val kept: Boolean = false,
    val markedWrong: Boolean = false,
    val keep: ReturnActionState = ReturnActionState.Idle,
    val seemsWrong: ReturnActionState = ReturnActionState.Idle,
)
