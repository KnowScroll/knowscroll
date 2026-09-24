package com.knowscroll.mobile.ui.account

/** #135 (ADR-0026): whether this device currently holds a usable credential -- the signed-in
 * session, or (only in a debug build) the development token. Gates the whole app: [SignedOut]
 * shows the sign-in screen instead of the reader. */
sealed interface AuthState {
    data object SignedOut : AuthState
    data object SignedIn : AuthState
}

/** Why the device is signed out, for the one honest message the sign-in screen shows -- distinct
 * from "you have never signed in here". `null` means no reason is known (the ordinary case).
 * `SESSION_ENDED_BEFORE_DELETE`/`_RESET`: that request met a 401 with no earlier attempt of it that
 * could have been applied -- the session had already ended, and nothing was deleted or reset. */
enum class SignedOutReason {
    SESSION_EXPIRED, ACCOUNT_DELETED, RESET, SIGNED_OUT, SESSION_ENDED_BEFORE_DELETE, SESSION_ENDED_BEFORE_RESET,
}

sealed interface LinkRequestState {
    data object Idle : LinkRequestState
    data object Sending : LinkRequestState
    /** The one fixed "check your email" message (ADR-0026 section 2): shown for every syntactically
     * valid address alike, never distinguishing the owner's from an unknown one. */
    data object Sent : LinkRequestState
    data class Failed(val message: String) : LinkRequestState
}

sealed interface TokenSubmitState {
    data object Idle : TokenSubmitState
    /** A pasted value [parseSignInToken] rejected outright -- never sent to the server. */
    data class InvalidLink(val message: String) : TokenSubmitState
    data object Submitting : TokenSubmitState
    data class Failed(val message: String) : TokenSubmitState
}

sealed interface PrivacyState {
    data object Loading : PrivacyState
    data class Loaded(val universeId: String, val recordingPausedAt: String?, val privacyEpoch: Long) : PrivacyState
    data class Unavailable(val message: String) : PrivacyState
}

/** Shared shape for pause/resume/reset/delete/sign-out. Pause and resume never reach
 * [Confirming] (ADR-0028: no destructive confirmation literal for either). */
sealed interface PrivacyOperationState {
    data object Idle : PrivacyOperationState
    data object Confirming : PrivacyOperationState
    data object Working : PrivacyOperationState
    data class Failed(val message: String) : PrivacyOperationState
}

sealed interface ExportState {
    data object Idle : ExportState
    data object Working : ExportState
    /** [json] is held only in memory for the save/share the reader just chose; never logged. */
    data class Ready(val json: String) : ExportState
    data class Failed(val message: String) : ExportState
}
