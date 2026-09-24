package com.knowscroll.mobile.data

import com.knowscroll.mobile.ui.why.whyStepText
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #133: the reader's "why" is read back exactly as recorded, and a dishonest one is refused. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WhyTest {
    private fun why(family: String = "bridge", corrections: String = "[\"less_like_this\",\"wrong_connection\"]", evidence: String = BRIDGE_EVIDENCE) = JSONObject(
        """{"decisionId":"d1","assetId":"a2","policyVersion":"composer-semantic-v3","family":"$family",
            "reason":"A sourced connection from “Gravity pulls”: Gravity explains Tides.","evidence":$evidence,
            "terms":{"depth":1.2},"quotas":[],"corrections":$corrections}""",
    )

    @Test
    fun readsTheRecordedEvidencePathInOrder() {
        val parsed = parseWhy(why())
        assertEquals("bridge", parsed.family)
        assertEquals(listOf("less_like_this", "wrong_connection"), parsed.corrections)
        val mark = parsed.steps[0] as WhyStep.Mark
        assertEquals("ev1", mark.eventId)
        assertEquals("You kept “Gravity pulls”", whyStepText(mark))
        assertEquals("Gravity explains Tides", whyStepText(parsed.steps[1]))
    }

    @Test
    fun refusesAnExplanationTheServerCouldNotHaveRecorded() {
        assertThrows(IllegalArgumentException::class.java) { parseWhy(why(family = "because_you_like_it")) }
        assertThrows(IllegalArgumentException::class.java) { parseWhy(why(corrections = "[\"delete_my_profile\"]")) }
        // An unmapped encounter has no route to correct.
        assertThrows(IllegalArgumentException::class.java) { parseWhy(why(family = "fallback", corrections = "[\"less_like_this\"]", evidence = "[]")) }
        // Only a connection can be wrong.
        assertThrows(IllegalArgumentException::class.java) { parseWhy(why(family = "seed", evidence = """[{"kind":"outside","domain":"astro"}]""")) }
        // A mark must name the recorded act it cites.
        assertThrows(IllegalArgumentException::class.java) {
            parseWhy(why(evidence = """[{"kind":"mark","markKind":"keep","assetId":"a1","title":"t","at":"2026-09-24T00:00:00Z","eventId":""}]"""))
        }
        assertThrows(IllegalArgumentException::class.java) { parseWhy(why(evidence = """[{"kind":"interest","topic":"space"}]""")) }
    }

    @Test
    fun whyAndCorrectionTravelTheWireExactly() = runBlocking {
        ServerSocket(0).use { server ->
            val requests = java.util.Collections.synchronizedList(mutableListOf<Pair<String, String>>())
            val replies = listOf(
                200 to why().toString(),
                404 to """{"error":"No recorded explanation for this encounter"}""",
                201 to """{"feedbackId":"f1","kind":"less_like_this","suppressed":{"family":"bridge","concept":"t.tides","bridgeId":"br1","until":"2026-10-08T00:00:00Z"}}""",
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
            assertEquals("bridge", api.getWhy("d1", "a2")!!.family)
            assertNull("a decision with no recorded explanation is not an error", api.getWhy("d1", "a3"))
            val receipt = api.postEncounterFeedback("k1", "d1", "a2", "less_like_this", 0)
            assertEquals("f1", receipt.feedbackId)
            assertTrue(requests[0].first.startsWith("GET /v1/decisions/d1/why?assetId=a2 "))
            val sent = JSONObject(requests[2].second)
            assertEquals(setOf("clientFeedbackId", "decisionId", "assetId", "kind", "expectedPrivacyEpoch"), sent.keys().asSequence().toSet())
            worker.join(2_000)
        }
    }

    private companion object {
        const val BRIDGE_EVIDENCE = """[{"kind":"mark","markKind":"keep","assetId":"a1","title":"Gravity pulls","at":"2026-09-24T01:00:00.000Z","eventId":"ev1"},
            {"kind":"bridge","bridgeId":"br1","sentence":"Gravity explains Tides"}]"""
    }
}
