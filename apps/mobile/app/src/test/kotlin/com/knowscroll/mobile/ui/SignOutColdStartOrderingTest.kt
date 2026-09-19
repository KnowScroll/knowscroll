package com.knowscroll.mobile.ui

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Review fix for #91: on cold start with a restored, unresolved ("ambiguous") pending
 * sign-out, `beginSignOut()` (POST /v1/session/revoke) and `reconcilePrivacy()`
 * (GET /v1/universe) used to be dispatched as two independently launched coroutines,
 * so they could run concurrently against the same possibly-dead session token. The
 * fix makes `reconcilePrivacy` gate on [continueReconcilingAfterSignOutRetry], which
 * awaits the sign-out retry to completion, in the same coroutine, before anything else
 * may reuse the token.
 *
 * These tests exercise the exact gate function `AppViewModel.kt` now calls from inside
 * `reconcilePrivacy`, using fake suspend "clients" that record call order -- there is no
 * Robolectric/DI seam in this module to instantiate `AppViewModel` itself off-device.
 */
class SignOutColdStartOrderingTest {

    /** A fake sign-out client whose "network" reply is deliberately slow, so any
     * implementation that raced ahead to reconciliation instead of awaiting this
     * would observe the reconcile step recorded before the retry finished. */
    private class FakeSignOutClient(private val resolvesSignedOut: Boolean) {
        var retryCalls = 0
        val order = mutableListOf<String>()
        suspend fun retry() {
            retryCalls++
            delay(50)
            order += "revoke-complete"
        }
        fun isSignedOutNow() = resolvesSignedOut
    }

    @Test fun aRestoredAmbiguousSignOutFullyResolvesBeforeReconciliationIsAllowed() = runBlocking {
        val client = FakeSignOutClient(resolvesSignedOut = false)
        val proceed = continueReconcilingAfterSignOutRetry(
            retrySignOutFirst = true,
            retrySignOut = client::retry,
            isSignedOutNow = client::isSignedOutNow
        )
        if (proceed) client.order += "reconcile-allowed"
        assertEquals(
            "The slow revoke must finish before reconciliation is ever allowed to proceed",
            listOf("revoke-complete", "reconcile-allowed"), client.order
        )
        assertTrue(proceed)
        assertEquals(1, client.retryCalls)
    }

    @Test fun aRetryThatResolvesSignedOutStopsReconciliationFromReusingTheDeadToken() = runBlocking {
        val client = FakeSignOutClient(resolvesSignedOut = true)
        var reconcileCalls = 0
        val proceed = continueReconcilingAfterSignOutRetry(
            retrySignOutFirst = true,
            retrySignOut = client::retry,
            isSignedOutNow = client::isSignedOutNow
        )
        if (proceed) reconcileCalls++
        assertFalse("A resolved sign-out must never let reconciliation fire with the dead token", proceed)
        assertEquals(0, reconcileCalls)
        // Exactly one revoke attempt: the dead token is never hit twice by this path.
        assertEquals(1, client.retryCalls)
    }

    @Test fun noPendingSignOutNeverInvokesRetryAndAlwaysReconciles() = runBlocking {
        val client = FakeSignOutClient(resolvesSignedOut = false)
        val proceed = continueReconcilingAfterSignOutRetry(
            retrySignOutFirst = false,
            retrySignOut = client::retry,
            isSignedOutNow = client::isSignedOutNow
        )
        assertTrue(proceed)
        assertEquals(0, client.retryCalls)
    }

    /** Documents exactly the previous bug shape (two independently launched coroutines,
     * neither awaiting the other) so the regression is legible on its own: with that
     * shape, a synchronous "reconcile" step is recorded before the slower in-flight
     * "revoke" resolves -- the ordering the fix above makes impossible. This does not
     * call any AppViewModel/production code (there is no seam to do so off-device); it
     * demonstrates why the old concurrent `beginSignOut()` + `reconcilePrivacy(true)`
     * dispatch in `init` was wrong, which `continueReconcilingAfterSignOutRetry` fixes. */
    @Test fun theOldConcurrentDispatchShapeLetReconciliationRaceTheStillInFlightRetry() = runBlocking {
        val order = mutableListOf<String>()
        coroutineScope {
            launch { delay(50); order += "revoke-complete" }
            launch { order += "reconcile-started" }
        }
        assertEquals("reconcile-started", order.first())
        assertFalse("Old shape: reconciliation must not have waited for the revoke", order.first() == "revoke-complete")
    }
}
