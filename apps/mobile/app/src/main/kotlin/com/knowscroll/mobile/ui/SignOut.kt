package com.knowscroll.mobile.ui

import com.knowscroll.mobile.data.ApiException

/** Sign out this device (#91, Journey I partial). Local-only state machine around the
 * existing `POST /v1/session/revoke` contract. No new auth flow, no token entry UI. */
sealed interface SignOutState {
    data object Idle : SignOutState
    data object Confirming : SignOutState
    data object Revoking : SignOutState
    /** Transport was uncertain (timeout/network loss/5xx/protocol). Local state is kept
     * and an explicit retry resends the identical revoke request. */
    data class Retryable(val message: String) : SignOutState
    /** Terminal for this process: the token is known-dead. No control here would ever
     * retry with it again. */
    data object SignedOut : SignOutState
}

internal const val SIGN_OUT_AMBIGUOUS_MESSAGE =
    "The last sign-out attempt is unconfirmed. Retry checks the same request; your local state is unchanged."

/** Only an actual 401 proves the session was already invalid; every other transport
 * outcome (timeout, dropped socket, 5xx, malformed response, missing token) is
 * ambiguous and must keep local state for an explicit retry of the identical request. */
internal fun isSignOutAmbiguous(error: Exception): Boolean =
    !(error is ApiException.Server && error.statusCode == 401)

/** Pure restoration decision for process start/cold restore: a durable terminal
 * sign-out always wins; an unresolved pending request offers retry; otherwise
 * sign-out has not begun. */
internal fun signOutRestoreState(pendingSignOut: Boolean, signedOut: Boolean): SignOutState = when {
    signedOut -> SignOutState.SignedOut
    pendingSignOut -> SignOutState.Retryable(SIGN_OUT_AMBIGUOUS_MESSAGE)
    else -> SignOutState.Idle
}
