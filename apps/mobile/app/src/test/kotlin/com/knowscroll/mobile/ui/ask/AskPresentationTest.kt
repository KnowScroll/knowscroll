package com.knowscroll.mobile.ui.ask

import com.knowscroll.mobile.data.AnswerBasisQuote
import com.knowscroll.mobile.data.AnswerStatus
import com.knowscroll.mobile.data.AnswerView
import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.WatchedAnswer
import org.junit.Assert.*
import org.junit.Test

/** #132: the pure Ask/answer transitions -- the polling loop's own decision, and which of the
 * four documented conditions a 409 names -- are unit-tested without any network or coroutine. */
class AskPresentationTest {
    @Test
    fun pollingKeepsWaitingOnlyWhileQueuedOrRunning() {
        assertEquals(AskStage.Waiting("a1", "queued"), stageAfterPoll("a1", AnswerView("a1", AnswerStatus.Queued, "t", null, kept = false, seemsWrong = false)))
        assertEquals(AskStage.Waiting("a1", "running"), stageAfterPoll("a1", AnswerView("a1", AnswerStatus.Running, "t", null, kept = false, seemsWrong = false)))

        val answered = AnswerView("a1", AnswerStatus.Answered("x", listOf(AnswerBasisQuote("q")), "l"), "t", "t2", kept = false, seemsWrong = false)
        assertEquals(AskStage.Final("a1", answered), stageAfterPoll("a1", answered))

        val cancelled = AnswerView("a1", AnswerStatus.Cancelled(listOf("cancelled by the reader")), "t", null, kept = false, seemsWrong = false)
        assertEquals(AskStage.Final("a1", cancelled), stageAfterPoll("a1", cancelled))

        val unavailable = AnswerView("a1", AnswerStatus.Unavailable, "t", null, kept = false, seemsWrong = false)
        assertEquals(AskStage.Final("a1", unavailable), stageAfterPoll("a1", unavailable))
    }

    @Test
    fun aFourZeroNineFromRequestingAnAnswerNamesExactlyOneOfTheFourDocumentedConditions() {
        assertEquals(AnswerRequestConflict.Paused, answerRequestConflict(ApiException.Server(409, """{"error":"Recording is paused"}""")))
        assertEquals(AnswerRequestConflict.StaleEpoch, answerRequestConflict(ApiException.Server(409, """{"error":"Answer request privacy epoch is stale"}""")))
        assertEquals(AnswerRequestConflict.AlreadyRequested, answerRequestConflict(ApiException.Server(409, """{"error":"An answer was already requested for this Ask"}""")))
        assertEquals(AnswerRequestConflict.NotAsker, answerRequestConflict(ApiException.Server(409, """{"error":"Only the session that asked can request its answer"}""")))
        assertNull("an unrecognized 409 is not silently mapped to one of the four", answerRequestConflict(ApiException.Server(409, "{}")))
        assertNull("only a 409 is a request-answer conflict", answerRequestConflict(ApiException.Server(503, """{"error":"Answers are not enabled on this deployment"}""")))
    }

    @Test
    fun aPanelLostWithTheProcessReopensOnTheAnswerItWasWaitingFor() {
        val watched = WatchedAnswer("a1", "scroll-1", 3, "Why?")
        assertEquals(AskPanel("scroll-1", AskStage.Waiting("a1", "queued"), "Why?"), reopenedAskPanel("scroll-1", 3, watched))
        assertEquals("another Scroll starts fresh", AskPanel("scroll-2"), reopenedAskPanel("scroll-2", 3, watched))
        assertEquals("another epoch never shows it", AskPanel("scroll-1"), reopenedAskPanel("scroll-1", 4, watched))
        assertEquals(AskPanel("scroll-1"), reopenedAskPanel("scroll-1", 3, null))
    }

    @Test
    fun cancelReportsOnlyTheAlreadyStartedConflict() {
        assertTrue(cancelAlreadyStarted(ApiException.Server(409, """{"error":"This answer has already started"}""")))
        assertFalse(cancelAlreadyStarted(ApiException.Server(409, "{}")))
        assertFalse(cancelAlreadyStarted(ApiException.Server(404, "not found")))
    }

    /** #166 review: closing the sheet stops polling, so reopening it on the same Scroll must watch an
     * answer still on its way again (or one whose polling timed out); nothing else restarts. */
    @Test fun reopeningTheSheetWatchesAnAnswerStillOnItsWayAgain() {
        val panel = { stage: AskStage -> AskPanel("asset-a", stage, "Why two tides?") }
        assertEquals("ask-1", askToWatchOnReopen(panel(AskStage.Waiting("ask-1", "queued")), polling = false))
        assertEquals("ask-1", askToWatchOnReopen(panel(AskStage.Waiting("ask-1", "running")), polling = false))
        assertEquals("ask-1", askToWatchOnReopen(panel(AskStage.TimedOut("ask-1")), polling = false))
        assertNull("a poll already running is left alone", askToWatchOnReopen(panel(AskStage.Waiting("ask-1", "queued")), polling = true))
        for (stage in listOf(AskStage.Composing, AskStage.Recorded("ask-1"), AskStage.Requesting, AskStage.Error("ask-1", "failed")))
            assertNull("$stage", askToWatchOnReopen(panel(stage), polling = false))
    }
}
