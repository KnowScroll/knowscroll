package com.knowscroll.mobile.ui.ask

import com.knowscroll.mobile.data.AnswerStatus
import com.knowscroll.mobile.data.AnswerView
import com.knowscroll.mobile.data.ApiException

/**
 * #132 — ADR-0033: authorized answers to a reader's Ask about the Scroll on screen. Recording a
 * question and requesting its answer are two separate, explicit reader actions -- never automatic
 * -- so this is the state machine between them, kept out of the ViewModel so its transitions and
 * copy are unit-testable and never claim more than the answer service actually returned.
 */
sealed interface AskStage {
    data object Composing : AskStage
    data object Recording : AskStage
    data class Recorded(val askId: String) : AskStage
    data object Requesting : AskStage
    /** [status] is "queued" or "running", read back from the server -- never guessed locally. */
    data class Waiting(val askId: String, val status: String) : AskStage
    data class Final(val askId: String, val view: AnswerView) : AskStage
    /** The client gave up polling after the bounded wait; the server was never told to stop and
     * may still finish the job. This is shown with the same copy as a server `unavailable`
     * status, but it is not a claim the server ever returned one. */
    data class TimedOut(val askId: String) : AskStage
    data class Error(val askId: String?, val message: String) : AskStage
}

data class AskPanel(
    val assetId: String,
    val stage: AskStage = AskStage.Composing,
    /** The last question text this panel recorded, so a reopened sheet still shows it. */
    val question: String = "",
)

/** After a poll, decide the next stage from the server's own view -- queued/running keep waiting,
 * everything else is terminal. Pure, so the polling loop's decision is unit-testable on its own. */
internal fun stageAfterPoll(askId: String, view: AnswerView): AskStage = when (view.status) {
    AnswerStatus.Queued -> AskStage.Waiting(askId, "queued")
    AnswerStatus.Running -> AskStage.Waiting(askId, "running")
    else -> AskStage.Final(askId, view)
}

enum class AnswerRequestConflict { Paused, NotAsker, AlreadyRequested, StaleEpoch }

/** A 409 from `POST /v1/asks/:id/answer` names exactly one of four conditions; the client tells
 * them apart from the server's own message, never by guessing. */
fun answerRequestConflict(error: ApiException.Server): AnswerRequestConflict? {
    if (error.statusCode != 409) return null
    val body = error.message ?: ""
    return when {
        body.contains("Recording is paused", ignoreCase = true) -> AnswerRequestConflict.Paused
        body.contains("privacy epoch is stale", ignoreCase = true) -> AnswerRequestConflict.StaleEpoch
        body.contains("already requested", ignoreCase = true) -> AnswerRequestConflict.AlreadyRequested
        body.contains("Only the session that asked", ignoreCase = true) -> AnswerRequestConflict.NotAsker
        else -> null
    }
}

/** A 409 from `POST /v1/asks/:id/answer/cancel`: the job already started and cannot be cancelled. */
fun cancelAlreadyStarted(error: ApiException.Server): Boolean =
    error.statusCode == 409 && (error.message ?: "").contains("already started", ignoreCase = true)

/** A compact, test-observable encoding of the panel's own stage -- carried as the sheet's
 * `stateDescription` the same way the reader's exact position is (see `ScrollScreen.kt`'s
 * `reader_position_description`), so an instrumentation test can read the real askId and status
 * without ever reading the answer text itself. */
internal fun askStateDescription(stage: AskStage?): String = when (stage) {
    null, AskStage.Composing -> "composing"
    AskStage.Recording -> "recording"
    is AskStage.Recorded -> "recorded:${stage.askId}"
    AskStage.Requesting -> "requesting"
    is AskStage.Waiting -> "waiting:${stage.askId}:${stage.status}"
    is AskStage.Final -> "final:${stage.askId}:${answerStatusName(stage.view.status)}"
    is AskStage.TimedOut -> "timedOut:${stage.askId}"
    is AskStage.Error -> "error:${stage.askId ?: ""}"
}

private fun answerStatusName(status: com.knowscroll.mobile.data.AnswerStatus): String = when (status) {
    com.knowscroll.mobile.data.AnswerStatus.Queued -> "queued"
    com.knowscroll.mobile.data.AnswerStatus.Running -> "running"
    is com.knowscroll.mobile.data.AnswerStatus.Answered -> "answered"
    is com.knowscroll.mobile.data.AnswerStatus.NotInSource -> "not_in_source"
    is com.knowscroll.mobile.data.AnswerStatus.Rejected -> "rejected"
    is com.knowscroll.mobile.data.AnswerStatus.Failed -> "failed"
    is com.knowscroll.mobile.data.AnswerStatus.Cancelled -> "cancelled"
    com.knowscroll.mobile.data.AnswerStatus.Unavailable -> "unavailable"
}
