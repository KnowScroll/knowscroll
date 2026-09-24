package com.knowscroll.mobile.data

import androidx.test.core.app.ApplicationProvider
import com.knowscroll.mobile.ui.BranchAvailability
import com.knowscroll.mobile.ui.branch.BranchOpenConflict
import com.knowscroll.mobile.ui.branch.branchAvailabilityOf
import com.knowscroll.mobile.ui.branch.branchOpenConflict
import com.knowscroll.mobile.ui.branch.railLabel
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #131: the client shows only what the server's admitted bridges say, and refuses a dishonest list. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BranchesTest {
    private val branchJson = """
        {"branchId":"b1","bridgeId":"br1","relationType":"explains","direction":"reverse","relationPhrase":"is explained by",
         "fromConcept":{"code":"t.tides","name":"Tides"},"toConcept":{"code":"t.gravity","name":"Gravity"},
         "mechanism":"The Moon and Sun pull on the oceans with gravity so water bulges.",
         "limitations":[{"kind":"scope_limit","statement":"Coastlines change local timing"}],"prerequisites":["Masses attract"],
         "evidence":[{"claimKey":"c1","statement":"Gravity causes tides.","supports":"mechanism","sourceTitle":"NOAA · Tides","sourceUrl":"https://example.test/t"}],
         "target":{"assetId":"a2","revision":1,"kind":"Scroll","title":"Gravity pulls","summary":"s","sourceTitle":"NASA · Gravity"},"seen":false}
    """.trimIndent()

    private fun response(branches: String, emptyReason: String?) = JSONObject(
        """{"assetId":"a1","revision":1,"privacyEpoch":0,"branches":[$branches],"emptyReason":${emptyReason?.let { "\"$it\"" } ?: "null"}}""",
    )

    private val parent = ScrollItem("a1", 1, "Scroll", "Why the sea rises", "s", "b", "NOAA", "https://example.test", "documented", "")

    @Test
    fun parsesALiveBranchInTheReadersTravelOrder() {
        val result = parseEncounterBranches(response(branchJson, null))
        val branch = result.branches.single()
        assertEquals("Tides is explained by Gravity", branch.relationSentence)
        assertEquals("Is explained by Gravity", railLabel(branch))
        val ready = branchAvailabilityOf(result, parent) as BranchAvailability.Ready
        assertEquals("a2", ready.branches.single().targetAssetId)
        assertEquals("a1", ready.branches.single().parentAssetId)
    }

    @Test
    fun anEmptyListCarriesItsReasonAndNothingElse() {
        val empty = parseEncounterBranches(response("", "no_admitted_bridge"))
        val shown = branchAvailabilityOf(empty, parent) as BranchAvailability.Empty
        assertEquals("No connection leads on from this idea yet.", shown.reason)
        assertThrows(IllegalArgumentException::class.java) { parseEncounterBranches(response("", null)) }
        assertThrows(IllegalArgumentException::class.java) { parseEncounterBranches(response(branchJson, "no_admitted_bridge")) }
        assertThrows(IllegalArgumentException::class.java) { parseEncounterBranches(response("", "because_i_said_so")) }
        val noEvidence = branchJson.replace(Regex("\"evidence\":\\[.*?]"), "\"evidence\":[]")
        assertThrows(IllegalArgumentException::class.java) { parseEncounterBranches(response(noEvidence, null)) }
    }

    @Test
    fun aWithdrawnConnectionIsNotAPrivacyFailure() {
        assertEquals(BranchOpenConflict.StaleEpoch, branchOpenConflict(ApiException.Server(409, """{"error":"Branch privacy epoch is stale"}""")))
        assertEquals(BranchOpenConflict.Unavailable, branchOpenConflict(ApiException.Server(409, """{"error":"This continuation is no longer available"}""")))
        assertNull(branchOpenConflict(ApiException.Server(422, "{}")))
    }

    @Test
    fun openBranchSendsTheWholeEnvelopeAndRejectsAnUnexpectedTarget() = runBlocking {
        ServerSocket(0).use { server ->
            val bodies = java.util.Collections.synchronizedList(mutableListOf<String>())
            val replies = listOf("a2", "zz")
            val worker = thread {
                replies.forEach { served ->
                    server.accept().use { socket ->
                        val input = socket.getInputStream().bufferedReader()
                        input.readLine()
                        var length = 0
                        while (true) {
                            val line = input.readLine()
                            if (line.isNullOrEmpty()) break
                            if (line.startsWith("Content-Length:", true)) length = line.substringAfter(":").trim().toInt()
                        }
                        bodies += String(CharArray(length).also { input.read(it, 0, length) })
                        val body = """{"decisionId":"d2","universeId":"u","accountRevision":0,"privacyEpoch":0,
                            "items":[{"assetId":"$served","revision":1,"kind":"Scroll","title":"t","summary":"s","body":"b","sourceTitle":"st","sourceUrl":"https://x","truthState":"documented","reason":"A connection you chose"}],
                            "branch":{"branchOpenId":"o1","recorded":true,"bridgeId":"br1","relationType":"explains","direction":"reverse"}}"""
                        socket.getOutputStream().write(("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body").toByteArray())
                    }
                }
            }
            val api = ApiClient("http://127.0.0.1:${server.localPort}", "fixture-token", maxAttempts = 1)
            val request = BranchOpenRequest("k1", "e1", "br1", "a2", 0, "u")
            val receipt = api.openBranch(request)
            assertEquals("d2", receipt.feed.decisionId)
            assertTrue(receipt.recorded)
            val sent = JSONObject(bodies.first())
            assertEquals(setOf("clientBranchId", "fromExposureId", "bridgeId", "targetAssetId", "expectedPrivacyEpoch"), sent.keys().asSequence().toSet())
            assertEquals("k1", sent.getString("clientBranchId"))
            val wrong = runCatching { api.openBranch(request) }.exceptionOrNull()
            assertTrue(wrong is ApiException.Protocol)
            worker.join(2_000)
        }
    }

    @Test
    fun aPausedBranchCarriesNoDecisionAndMayNotClaimToBeRecorded() = runBlocking {
        fun reply(decision: String, recorded: Boolean) = """{"decisionId":$decision,"universeId":"u","accountRevision":0,"privacyEpoch":0,
            "items":[{"assetId":"a2","revision":1,"kind":"Scroll","title":"t","summary":"s","body":"b","sourceTitle":"st","sourceUrl":"https://x","truthState":"documented","reason":"A connection you chose"}],
            "branch":{"branchOpenId":null,"recorded":$recorded,"bridgeId":"br1","relationType":"explains","direction":"reverse"}}"""
        ServerSocket(0).use { server ->
            val replies = listOf(reply("null", false), reply("null", true), reply("\"d2\"", false))
            val worker = thread {
                replies.forEach { body ->
                    server.accept().use { socket ->
                        val input = socket.getInputStream().bufferedReader()
                        var length = 0
                        while (true) {
                            val line = input.readLine()
                            if (line.isNullOrEmpty()) break
                            if (line.startsWith("Content-Length:", true)) length = line.substringAfter(":").trim().toInt()
                        }
                        input.read(CharArray(length), 0, length)
                        socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body").toByteArray())
                    }
                }
            }
            val api = ApiClient("http://127.0.0.1:${server.localPort}", "fixture-token", maxAttempts = 1)
            val request = BranchOpenRequest("k1", "e1", "br1", "a2", 0, "u")
            val paused = api.openBranch(request)
            assertEquals("", paused.feed.decisionId)
            assertFalse(paused.recorded)
            assertTrue(runCatching { api.openBranch(request) }.exceptionOrNull() is ApiException.Protocol)
            assertTrue(runCatching { api.openBranch(request) }.exceptionOrNull() is ApiException.Protocol)
            worker.join(2_000)
        }
    }

    @Test
    fun theReturnTrailAndPendingEnvelopeSurviveAndArePurgedWithPrivateState() {
        val store = StateStore(ApplicationProvider.getApplicationContext())
        val origin = ScrollSession("d1", parent, 0, "u", exposureId = "e1", exposureEventId = "ev1", readingPosition = 640)
        val target = ScrollSession("d2", parent.copy(assetId = "a2"), 0, "u", branchFrom = BranchFrom("a1", "Why the sea rises", "Tides is explained by Gravity", "br1", true))
        store.writeBranchTrail(listOf(origin))
        store.write(target)
        store.writePendingBranch(BranchOpenRequest("k1", "e1", "br1", "a2", 0, "u"))
        val restored = StateStore(ApplicationProvider.getApplicationContext())
        assertEquals(640, restored.readBranchTrail().single().readingPosition)
        assertEquals("Tides is explained by Gravity", restored.read()!!.branchFrom!!.relationSentence)
        assertEquals("k1", restored.readPendingBranch()!!.clientBranchId)
        store.writeBranchTrail(List(12) { origin.copy(decisionId = "d$it") })
        assertEquals(MAX_BRANCH_TRAIL, store.readBranchTrail().size)
        store.purgePrivateState("u", 1)
        assertTrue(store.readBranchTrail().isEmpty())
        assertNull(store.readPendingBranch())
    }
}
