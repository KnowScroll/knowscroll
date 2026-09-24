package com.knowscroll.mobile.data

import org.json.JSONObject

/**
 * #132 — ADR-0033: an authorized answer to a reader's Ask about the Scroll they are reading. The
 * client adds nothing -- no inference, no ranking, no fabricated confidence -- and refuses a
 * payload the answer service could not honestly have returned, the same discipline `data/Why.kt`
 * and `data/Branches.kt` already hold the Composer's own records to.
 */
data class AnswerBasisQuote(val quote: String)

sealed interface AnswerStatus {
    data object Queued : AnswerStatus
    data object Running : AnswerStatus
    data class Answered(val answer: String, val basis: List<AnswerBasisQuote>, val limits: String) : AnswerStatus
    data class NotInSource(val limits: String) : AnswerStatus
    data class Rejected(val reasons: List<String>) : AnswerStatus
    data class Failed(val reasons: List<String>) : AnswerStatus
    data class Cancelled(val reasons: List<String>) : AnswerStatus
    data object Unavailable : AnswerStatus
}

data class AnswerView(
    val askId: String,
    val status: AnswerStatus,
    val requestedAt: String,
    val answeredAt: String?,
)

data class AskReceipt(val askId: String, val eventId: String, val status: String)
data class AnswerRequestReceipt(val requestId: String, val askId: String, val jobId: String, val status: String)

/** The persisted retry envelope for `POST /v1/asks`: written before dispatch, retried with the
 * same key after an ambiguous failure, discarded once the server confirms it or the scope changes. */
data class PendingAsk(
    val clientAskId: String,
    val exposureId: String,
    val expectedPrivacyEpoch: Long,
    val question: String,
)

/** The persisted retry envelope for `POST /v1/asks/:id/answer` -- a separate reader action, never
 * dispatched automatically after an Ask is recorded. */
data class PendingAnswerRequest(
    val clientRequestId: String,
    val askId: String,
    val expectedPrivacyEpoch: Long,
)

/** #166: the answer the reader requested and is waiting for -- which Ask, on which Scroll, in which
 * epoch. Persisted once the request is accepted, so a panel lost with the process picks the same
 * answer up again (never a new request); dropped once the answer is final. */
data class WatchedAnswer(
    val askId: String,
    val assetId: String,
    val expectedPrivacyEpoch: Long,
    val question: String,
)

private val ANSWER_STATUSES = setOf(
    "queued", "running", "answered", "not_in_source", "rejected", "failed", "cancelled", "unavailable",
)
private val REASON_STATUSES = setOf("rejected", "failed", "cancelled")
private const val MAX_QUESTION_BYTES = 4096

/** Non-empty after trim, at most 4096 UTF-8 bytes, no NUL -- the same rule the server enforces on
 * `POST /v1/asks`. Used to disable the "Ask" control before a doomed request is ever sent. */
fun questionIsValid(question: String): Boolean {
    if (question.isBlank()) return false
    if (question.any { it == '\u0000' }) return false
    // The literal text is what is sent and what the server bounds (ADR-0016), spaces included.
    return question.toByteArray(Charsets.UTF_8).size <= MAX_QUESTION_BYTES
}

internal fun parseAnswerView(o: JSONObject): AnswerView {
    val askId = o.getString("askId")
    val status = o.getString("status")
    require(status in ANSWER_STATUSES) { "Unknown answer status" }

    val answer = if (o.isNull("answer")) null else o.getString("answer")
    require((answer != null) == (status == "answered")) { "An answer's text is present only when it was answered" }

    val basisArray = o.optJSONArray("basis")
    val basis = if (basisArray == null) emptyList() else List(basisArray.length()) { i ->
        AnswerBasisQuote(basisArray.getJSONObject(i).getString("quote"))
    }
    require(status == "answered" || basis.isEmpty()) { "Basis quotes are cited only for an answered view" }
    require(status != "answered" || basis.size in 1..4) { "An answered view must cite between 1 and 4 quotes" }

    val limitsPresent = !o.isNull("limits")
    val limits = if (limitsPresent) o.getString("limits") else null
    require(limitsPresent == (status == "answered" || status == "not_in_source")) {
        "Limits are recorded only where the answer service can say where it stops"
    }

    val reasonsArray = o.optJSONArray("reasons")
    val reasons = if (reasonsArray == null) emptyList() else List(reasonsArray.length()) { reasonsArray.getString(it) }
    require(reasons.isNotEmpty() == (status in REASON_STATUSES)) {
        "Reasons are recorded exactly for rejected, failed or cancelled"
    }

    val requestedAt = o.getString("requestedAt")
    val answeredAt = if (o.isNull("answeredAt")) null else o.getString("answeredAt")

    val parsed: AnswerStatus = when (status) {
        "queued" -> AnswerStatus.Queued
        "running" -> AnswerStatus.Running
        "answered" -> AnswerStatus.Answered(answer!!, basis, limits!!)
        "not_in_source" -> AnswerStatus.NotInSource(limits!!)
        "rejected" -> AnswerStatus.Rejected(reasons)
        "failed" -> AnswerStatus.Failed(reasons)
        "cancelled" -> AnswerStatus.Cancelled(reasons)
        else -> AnswerStatus.Unavailable
    }
    return AnswerView(askId, parsed, requestedAt, answeredAt)
}
