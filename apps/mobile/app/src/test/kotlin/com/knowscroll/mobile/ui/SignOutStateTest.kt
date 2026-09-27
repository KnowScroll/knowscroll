package com.knowscroll.mobile.ui

import com.knowscroll.mobile.data.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure state-transition coverage for "Sign out this device" (#91): the local
 * decision of ambiguous-vs-resolved after a revoke attempt, and what a cold
 * restart must show for a durable terminal sign-out versus an unresolved one. */
class SignOutStateTest {

    @Test fun onlyAnActual401ResolvesAnAmbiguousRevokeAsSignedOut() {
        assertFalse("A definite 401 proves the session was already invalid", isSignOutAmbiguous(ApiException.Server(401, "rejected")))
    }

    @Test fun everyOtherTransportOutcomeStaysAmbiguousAndRetryable() {
        assertTrue(isSignOutAmbiguous(ApiException.Network("offline")))
        assertTrue(isSignOutAmbiguous(ApiException.Server(500, "unavailable")))
        assertTrue(isSignOutAmbiguous(ApiException.Server(503, "unavailable")))
        assertTrue(isSignOutAmbiguous(ApiException.Server(409, "unexpected")))
        assertTrue(isSignOutAmbiguous(ApiException.Server(400, "unexpected")))
        assertTrue(isSignOutAmbiguous(ApiException.Protocol("malformed")))
        assertTrue(isSignOutAmbiguous(ApiException.MissingToken))
    }

    @Test fun restorationWithNoPriorAttemptIsIdle() {
        assertEquals(SignOutState.Idle, signOutRestoreState(pendingSignOut = false, signedOut = false))
    }

    @Test fun restorationWithAnUnresolvedPendingRequestOffersRetryAndKeepsLocalState() {
        val restored = signOutRestoreState(pendingSignOut = true, signedOut = false)
        assertTrue(restored is SignOutState.Retryable)
    }

    @Test fun restorationWithADurableTerminalSignOutAlwaysWinsOverAPendingFlag() {
        // Both flags set (e.g. the terminal marker was written just before a crash
        // cleared the pending one) must never regress to a retryable, half-signed-out
        // display: the durable marker is authoritative.
        assertEquals(SignOutState.SignedOut, signOutRestoreState(pendingSignOut = true, signedOut = true))
        assertEquals(SignOutState.SignedOut, signOutRestoreState(pendingSignOut = false, signedOut = true))
    }

    @Test fun ambiguousThen401EndsAsSignedOutNeverAsStillAuthorized() {
        // Simulates the full sequence: confirm -> dispatch -> network loss (ambiguous,
        // local state kept) -> cold restart -> explicit retry -> 401 (already revoked).
        val afterNetworkLoss = signOutRestoreState(pendingSignOut = true, signedOut = false)
        assertTrue(afterNetworkLoss is SignOutState.Retryable)
        val retryOutcome = ApiException.Server(401, "rejected")
        assertFalse(isSignOutAmbiguous(retryOutcome))
        // The view model resolves a non-ambiguous outcome by writing the durable
        // marker and clearing the pending flag; restoring afterward must be terminal.
        assertEquals(SignOutState.SignedOut, signOutRestoreState(pendingSignOut = false, signedOut = true))
    }

    /** #135 review: the reader's view model can outlive its sign-out in the activity's store; once a
     * new sign-in has cleared the persisted flag, coming back to the foreground revives it instead of
     * keeping #91's dead end. While the flag stands, SignedOut stays terminal. */
    @Test fun aReaderThatOutlivedItsSignOutRevivesOnceANewSignInClearedTheFlag() {
        assertEquals(SignOutState.Idle, signOutStateOnForeground(SignOutState.SignedOut, persistedSignedOut = false))
        assertEquals(SignOutState.SignedOut, signOutStateOnForeground(SignOutState.SignedOut, persistedSignedOut = true))
        assertEquals(SignOutState.Confirming, signOutStateOnForeground(SignOutState.Confirming, persistedSignedOut = false))
        assertEquals(SignOutState.Idle, signOutStateOnForeground(SignOutState.Idle, persistedSignedOut = false))
        val retryable = SignOutState.Retryable(SIGN_OUT_AMBIGUOUS_MESSAGE)
        assertEquals(retryable, signOutStateOnForeground(retryable, persistedSignedOut = false))
    }
}
