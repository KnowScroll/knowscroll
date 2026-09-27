package com.knowscroll.mobile.ui.account

import com.knowscroll.mobile.data.InquiriesResponse

/** #132 (ADR-0038): the reader's standing consent and what KnowScroll looked for, as last read
 * from the server. Nothing is cached across an epoch change or a sign-out. */
sealed interface InquiriesState {
    data object Loading : InquiriesState
    /** [refreshing]: a reload is in flight while this is still shown; [refreshFailed]: the last
     * reload failed, so what is shown may be out of date. */
    data class Loaded(val response: InquiriesResponse, val refreshing: Boolean = false, val refreshFailed: String? = null) : InquiriesState
    data class Unavailable(val message: String) : InquiriesState
}

/** One consent change (the switch or the daily limit). [Failed.canRetry]: the change may have
 * landed without its answer, so the same request is kept for an explicit retry; otherwise it was
 * definitively refused (a stale epoch, a reused key, invalid input) and nothing is kept. */
sealed interface ConsentChangeState {
    data object Idle : ConsentChangeState
    data class Working(val enabled: Boolean, val dailyLimit: Int) : ConsentChangeState
    data class Failed(val message: String, val canRetry: Boolean) : ConsentChangeState
}
