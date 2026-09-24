package com.knowscroll.mobile.ui.ask

import androidx.test.core.app.ApplicationProvider
import com.knowscroll.mobile.data.AnswerRequestReceipt
import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.PendingAnswerRequest
import com.knowscroll.mobile.data.StateStore
import com.knowscroll.mobile.data.WatchedAnswer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #182: an answer request the server accepted in the reader's current epoch is watched whatever the
 * reader did while it was in flight -- navigation decides only whether the sheet shows it -- and the
 * answer is watched in the same commit that drops its retry envelope, so no kill between two writes
 * loses both. A cold [StateStore] reads what a restarted process would.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RequestWatchedAnswerTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private fun freshStore(): StateStore {
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        return StateStore(context)
    }

    private val answer = WatchedAnswer("55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", 2, "Why do tides come twice a day?")
    private fun accepted(request: PendingAnswerRequest) = AnswerRequestReceipt("r1", request.askId, "j1", "queued")

    @Test
    fun anAnswerAcceptedAfterTheReaderMovedOnIsStillWatched() = runBlocking {
        val store = freshStore()
        var navigated = false
        val showWaiting = requestWatchedAnswer(store, answer, { request ->
            assertEquals("the envelope is saved before dispatch", request, store.readPendingAnswerRequest())
            navigated = true // the reader leaves the Scroll while the request is in flight
            accepted(request)
        }, epochIsCurrent = { true }, screenIsCurrent = { !navigated })
        assertFalse("the sheet is gone: nothing to show", showWaiting)
        val cold = StateStore(context)
        assertEquals(answer, cold.readWatchedAnswer())
        assertNull(cold.readPendingAnswerRequest())
    }

    @Test
    fun alreadyRequestedIsTheSameAcceptanceSeenAgain() = runBlocking {
        val store = freshStore()
        store.writePendingAnswerRequest(PendingAnswerRequest("cr1", answer.askId, answer.expectedPrivacyEpoch))
        var sent: PendingAnswerRequest? = null
        val showWaiting = requestWatchedAnswer(store, answer, { request ->
            sent = request
            throw ApiException.Server(409, """{"message":"An answer was already requested for this Ask"}""")
        }, epochIsCurrent = { true }, screenIsCurrent = { true })
        assertTrue(showWaiting)
        assertEquals("the saved envelope is retried, never a new request", "cr1", sent?.clientRequestId)
        assertEquals(answer, store.readWatchedAnswer())
        assertNull(store.readPendingAnswerRequest())
    }

    @Test
    fun anotherEpochWatchesNothingAndAnyOtherRefusalKeepsTheEnvelope() = runBlocking {
        val store = freshStore()
        assertFalse(requestWatchedAnswer(store, answer, ::accepted, epochIsCurrent = { false }, screenIsCurrent = { true }))
        assertNull("an answer of an epoch the reader left is never watched", store.readWatchedAnswer())

        val paused = freshStore()
        assertThrows(ApiException.Server::class.java) {
            runBlocking {
                requestWatchedAnswer(paused, answer, { throw ApiException.Server(409, """{"message":"Recording is paused"}""") },
                    epochIsCurrent = { true }, screenIsCurrent = { true })
            }
        }
        assertNull(paused.readWatchedAnswer())
        assertEquals(answer.askId, paused.readPendingAnswerRequest()?.askId)
    }
}
