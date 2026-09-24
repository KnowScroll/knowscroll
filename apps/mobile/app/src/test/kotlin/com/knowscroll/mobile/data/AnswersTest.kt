package com.knowscroll.mobile.data

import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #132 — ADR-0033: an authorized answer is read back exactly as the answer service recorded it,
 * and a payload it could not honestly have returned is refused (see `data/WhyTest.kt`'s
 * companion `data/Why.kt` for the same discipline over the Composer's own records). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AnswersTest {
    private fun answerJson(
        askId: String = "ask1", status: String = "answered",
        answer: String? = "The tide rises because gravity pulls the ocean toward the Moon.",
        basis: String = """[{"quote":"Gravity pulls the ocean toward the Moon."}]""",
        limits: String? = "This only covers lunar tides, not storm surge.",
        reasons: String = "[]",
        requestedAt: String = "2026-09-24T00:00:00.000Z",
        answeredAt: String? = "2026-09-24T00:01:00.000Z",
    ) = JSONObject(
        """{"askId":"$askId","status":"$status","answer":${answer?.let { "\"$it\"" } ?: "null"},
            "basis":$basis,"limits":${limits?.let { "\"$it\"" } ?: "null"},"reasons":$reasons,
            "requestedAt":"$requestedAt","answeredAt":${answeredAt?.let { "\"$it\"" } ?: "null"}}""",
    )

    private fun queuedJson() = answerJson(status = "queued", answer = null, basis = "[]", limits = null, reasons = "[]", answeredAt = null)
    private fun runningJson() = answerJson(status = "running", answer = null, basis = "[]", limits = null, reasons = "[]", answeredAt = null)
    private fun notInSourceJson() = answerJson(
        status = "not_in_source", answer = null, basis = "[]",
        limits = "This Scroll does not discuss storm surge.",
    )
    private fun rejectedJson() = answerJson(
        status = "rejected", answer = null, basis = "[]", limits = null,
        reasons = """["The draft answer cited a quote that was not in this Scroll."]""",
    )
    private fun failedJson() = answerJson(
        status = "failed", answer = null, basis = "[]", limits = null,
        reasons = """["The answer service could not complete this request."]""",
    )
    private fun cancelledJson() = answerJson(
        status = "cancelled", answer = null, basis = "[]", limits = null,
        reasons = """["Cancelled before the job started."]""",
    )
    private fun unavailableJson() = answerJson(status = "unavailable", answer = null, basis = "[]", limits = null, reasons = "[]", answeredAt = null)

    @Test
    fun parsesEveryValidStatusShape() {
        assertEquals(AnswerStatus.Queued, parseAnswerView(queuedJson()).status)
        assertEquals(AnswerStatus.Running, parseAnswerView(runningJson()).status)

        val answered = parseAnswerView(answerJson()).status as AnswerStatus.Answered
        assertEquals("The tide rises because gravity pulls the ocean toward the Moon.", answered.answer)
        assertEquals(listOf(AnswerBasisQuote("Gravity pulls the ocean toward the Moon.")), answered.basis)
        assertEquals("This only covers lunar tides, not storm surge.", answered.limits)

        val notInSource = parseAnswerView(notInSourceJson()).status as AnswerStatus.NotInSource
        assertEquals("This Scroll does not discuss storm surge.", notInSource.limits)

        assertEquals(
            listOf("The draft answer cited a quote that was not in this Scroll."),
            (parseAnswerView(rejectedJson()).status as AnswerStatus.Rejected).reasons,
        )
        assertEquals(
            listOf("The answer service could not complete this request."),
            (parseAnswerView(failedJson()).status as AnswerStatus.Failed).reasons,
        )
        assertEquals(
            listOf("Cancelled before the job started."),
            (parseAnswerView(cancelledJson()).status as AnswerStatus.Cancelled).reasons,
        )
        assertEquals(AnswerStatus.Unavailable, parseAnswerView(unavailableJson()).status)

        // Up to 4 quotes are accepted; every field a status is allowed to omit stays null.
        val fourQuotes = JSONArray().apply { repeat(4) { put(JSONObject().put("quote", "q$it")) } }
        val wide = parseAnswerView(answerJson(basis = fourQuotes.toString())).status as AnswerStatus.Answered
        assertEquals(4, wide.basis.size)
        assertNull(parseAnswerView(queuedJson()).answeredAt)
    }

    @Test
    fun refusesAPayloadTheAnswerServiceCouldNotHaveReturned() {
        // An unknown status is never shown.
        assertThrows(IllegalArgumentException::class.java) { parseAnswerView(answerJson(status = "because_i_feel_like_it")) }
        // Answer text only belongs to an answered view.
        assertThrows(IllegalArgumentException::class.java) { parseAnswerView(queuedJson().put("answer", "Surprise")) }
        assertThrows(IllegalArgumentException::class.java) { parseAnswerView(answerJson().put("answer", JSONObject.NULL)) }
        // Basis quotes are cited only for an answered view, and between 1 and 4 of them.
        assertThrows(IllegalArgumentException::class.java) {
            parseAnswerView(queuedJson().put("basis", JSONArray().put(JSONObject().put("quote", "x"))))
        }
        assertThrows(IllegalArgumentException::class.java) { parseAnswerView(answerJson(basis = "[]")) }
        val fiveQuotes = JSONArray().apply { repeat(5) { put(JSONObject().put("quote", "q$it")) } }
        assertThrows(IllegalArgumentException::class.java) { parseAnswerView(answerJson(basis = fiveQuotes.toString())) }
        // Limits are recorded exactly for answered and not_in_source.
        assertThrows(IllegalArgumentException::class.java) { parseAnswerView(answerJson().put("limits", JSONObject.NULL)) }
        assertThrows(IllegalArgumentException::class.java) { parseAnswerView(queuedJson().put("limits", "should not be here")) }
        // Reasons are recorded exactly for rejected, failed or cancelled, and never empty there.
        assertThrows(IllegalArgumentException::class.java) { parseAnswerView(rejectedJson().put("reasons", JSONArray())) }
        assertThrows(IllegalArgumentException::class.java) {
            parseAnswerView(queuedJson().put("reasons", JSONArray().put("should not be here")))
        }
    }

    @Test
    fun questionValidityMatchesTheServersRule() {
        assertFalse(questionIsValid(""))
        assertFalse(questionIsValid("   \n  "))
        assertFalse(questionIsValid("has a nul \u0000 in it"))
        assertTrue(questionIsValid("  What does this Scroll say about tides?  "))
        assertTrue(questionIsValid("a".repeat(4096)))
        assertFalse(questionIsValid("a".repeat(4097)))
        // The server bounds the literal text (ADR-0016): surrounding spaces count toward the limit.
        assertFalse(questionIsValid("  " + "a".repeat(4095)))
    }

    @Test
    fun theFourCallsTravelTheWireExactlyAndA404ReadsAsNoAnswerEverRequested() = runBlocking {
        ServerSocket(0).use { server ->
            val requests = java.util.Collections.synchronizedList(mutableListOf<Pair<String, String>>())
            val replies = listOf(
                201 to """{"askId":"ask1","eventId":"ev1","status":"recorded_only"}""",
                202 to """{"requestId":"req1","askId":"ask1","jobId":"job1","status":"queued"}""",
                200 to answerJson().toString(),
                404 to """{"error":"No answer was ever requested for this Ask"}""",
                200 to cancelledJson().toString(),
            )
            val worker = thread {
                replies.forEach { (status, body) ->
                    server.accept().use { socket ->
                        val input = socket.getInputStream().bufferedReader()
                        val requestLine = input.readLine()
                        var length = 0
                        while (true) {
                            val line = input.readLine()
                            if (line.isNullOrEmpty()) break
                            if (line.startsWith("Content-Length:", true)) length = line.substringAfter(":").trim().toInt()
                        }
                        requests += requestLine to String(CharArray(length).also { input.read(it, 0, length) })
                        socket.getOutputStream().write(("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body").toByteArray())
                    }
                }
            }
            val api = ApiClient("http://127.0.0.1:${server.localPort}", "fixture-token", maxAttempts = 1)

            val askReceipt = api.postAsk(PendingAsk("ca1", "exp1", 0, "What does this Scroll say about tides?"))
            assertEquals("ask1", askReceipt.askId)
            assertEquals("recorded_only", askReceipt.status)

            val answerReceipt = api.requestAnswer(PendingAnswerRequest("cr1", "ask1", 0))
            assertEquals("req1", answerReceipt.requestId)
            assertEquals("job1", answerReceipt.jobId)

            val view = api.getAnswer("ask1")!!
            assertTrue(view.status is AnswerStatus.Answered)

            assertNull("no answer was ever requested reads as null, not an error", api.getAnswer("ask1"))

            val cancelled = api.cancelAnswer("ask1", 0)
            assertTrue(cancelled.status is AnswerStatus.Cancelled)

            assertTrue(requests[0].first.startsWith("POST /v1/asks "))
            val askBody = JSONObject(requests[0].second)
            assertEquals(setOf("clientAskId", "exposureId", "expectedPrivacyEpoch", "question"), askBody.keys().asSequence().toSet())
            assertEquals("ca1", askBody.getString("clientAskId"))
            assertEquals("What does this Scroll say about tides?", askBody.getString("question"))

            assertTrue(requests[1].first.startsWith("POST /v1/asks/ask1/answer "))
            val requestBody = JSONObject(requests[1].second)
            assertEquals(setOf("clientRequestId", "expectedPrivacyEpoch"), requestBody.keys().asSequence().toSet())
            assertEquals("cr1", requestBody.getString("clientRequestId"))

            assertTrue(requests[2].first.startsWith("GET /v1/asks/ask1/answer "))
            assertTrue(requests[3].first.startsWith("GET /v1/asks/ask1/answer "))

            assertTrue(requests[4].first.startsWith("POST /v1/asks/ask1/answer/cancel "))
            val cancelBody = JSONObject(requests[4].second)
            assertEquals(setOf("expectedPrivacyEpoch"), cancelBody.keys().asSequence().toSet())
            worker.join(2_000)
        }
    }

    @Test
    fun aPendingAskAndAnswerRequestSurviveAndArePurgedWithPrivateState() {
        val store = StateStore(androidx.test.core.app.ApplicationProvider.getApplicationContext())
        store.writePendingAsk(PendingAsk("ca1", "exp1", 0, "What does this Scroll say about tides?"))
        store.writePendingAnswerRequest(PendingAnswerRequest("cr1", "ask1", 0))
        val restored = StateStore(androidx.test.core.app.ApplicationProvider.getApplicationContext())
        assertEquals("ca1", restored.readPendingAsk()!!.clientAskId)
        assertEquals("cr1", restored.readPendingAnswerRequest()!!.clientRequestId)
        restored.purgePrivateState("u", 1)
        assertNull(restored.readPendingAsk())
        assertNull(restored.readPendingAnswerRequest())
    }
}
