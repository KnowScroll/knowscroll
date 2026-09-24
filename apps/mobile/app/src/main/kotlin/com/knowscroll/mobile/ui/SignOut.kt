package com.knowscroll.mobile.ui

import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.SessionVault
import com.knowscroll.mobile.data.StateStore

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

/**
 * #135: what the reader's confirmed sign-out records on this device. The revoked token leaves the
 * vault -- otherwise the account gate still counts it as signed in and the reader shows #91's
 * dead-end [SignedOutScreen] for good -- and the device is marked signed out, which also keeps a
 * debug build's development token (which this revoke may just have ended) from reopening the
 * reader; only a new sign-in clears the mark (`AccountViewModel.submitPastedLink`).
 *
 * The vault goes first: a crash between the two writes leaves no session and no mark (the sign-in
 * screen), never a dead session still in the vault.
 */
internal fun recordDeviceSignedOut(store: StateStore, vault: SessionVault) {
    vault.clear()
    store.clearPendingSignOut()
    store.writeSignedOut()
}

/** #135: the reader's view model lives in the activity's store, so it can outlive its own sign-out
 * while the sign-in screen is up. Once a new sign-in has cleared the persisted mark, coming back to
 * the foreground revives it instead of keeping [SignOutState.SignedOut]'s dead end; while the mark
 * stands, SignedOut stays terminal. Nothing else is changed. */
internal fun signOutStateOnForeground(current: SignOutState, persistedSignedOut: Boolean): SignOutState =
    if (current is SignOutState.SignedOut && !persistedSignedOut) SignOutState.Idle else current
