package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertExists
import org.junit.Assert.assertNotEquals
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.StateStore
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Joined proof only: every successful Trace response comes from the disposable
 * API. Proxy controls only interrupt or alter its real backing state.
 */
@RunWith(AndroidJUnit4::class)
class TraceRevisitJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)

    private fun guardJourneyApp() {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey") {
            "Trace revisit verification requires the separate journey app"
        }
    }

    private fun fingerprint(value:String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }.take(16)

    private fun waitUntil(block:()->Boolean) = compose.waitUntil(15_000, block)
    private fun traceDescription(eventId:String) = "Reopen saved Scroll $eventId"
    private fun displayedPosition():String? {
        val node=compose.onAllNodesWithContentDescription("Scroll reading content")
            .fetchSemanticsNodes().singleOrNull() ?: return null
        return node.config[SemanticsProperties.StateDescription]
    }

    private fun projectedTrace() = runBlocking {
        guardJourneyApp()
        ApiClient().getUniverse().traces.firstOrNull()
            ?: error("Runner must project a real Keep before Trace revisit checks")
    }

    private fun keepThroughUi() = runBlocking {
        guardJourneyApp()
        waitUntil { compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        waitUntil { store().read()?.exposureId?.isNotEmpty()==true }
        compose.onNodeWithContentDescription("Keep this Scroll").performClick()
        waitUntil { store().read()?.keepJobId?.isNotEmpty()==true }
        val kept=store().read() ?: error("Missing accepted Keep")
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        val api=ApiClient()
        repeat(60) {
            val trace=api.getUniverse().traces.firstOrNull { it.assetId==kept.item.assetId }
            if(trace!=null) return@runBlocking trace
            delay(250)
        }
        error("Separate worker did not project the UI Keep")
    }

    private fun showTraceCard(traceEventId:String) {
        // A fresh instrumentation Activity first reconciles/refetches its saved origin.
        waitUntil {
            compose.onAllNodesWithContentDescription(traceDescription(traceEventId)).fetchSemanticsNodes().isNotEmpty() ||
                compose.onAllNodesWithContentDescription("Return to the universe").fetchSemanticsNodes().isNotEmpty()
        }
        if(compose.onAllNodesWithContentDescription(traceDescription(traceEventId)).fetchSemanticsNodes().isEmpty()) {
            val home=compose.onAllNodesWithContentDescription("Return to the universe")
            if(home.fetchSemanticsNodes().isNotEmpty()) home[0].performClick()
        }
        waitUntil { compose.onAllNodesWithContentDescription(traceDescription(traceEventId)).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun open(traceEventId:String) {
        showTraceCard(traceEventId)
        compose.onNodeWithContentDescription(traceDescription(traceEventId)).assertIsDisplayed().performClick()
        waitUntil {
            store().readRevisit()?.eventId == traceEventId &&
                compose.onAllNodesWithText("SAVED FROM YOUR KEEP").fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun screenshot(name:String) {
        compose.waitForIdle();instrumentation.waitForIdleSync()
        val bitmap:Bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("Android screenshot was unavailable")
        File(instrumentation.targetContext.filesDir,name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }
    }

    private fun receipt(name:String,scenario:String,traceEventId:String,extra:JSONObject.()->Unit={}) {
        val state=store().readRevisit()
        File(instrumentation.targetContext.filesDir,name).writeText(JSONObject().apply {
            put("scenario",scenario);put("traceEventFingerprint",fingerprint(traceEventId))
            put("assetFingerprint",state?.assetId?.let(::fingerprint));put("universeFingerprint",state?.universeId?.let(::fingerprint))
            put("selectionRevision",state?.revision);put("readingPosition",state?.readingPosition)
            extra();put("result","passed")
        }.toString(2))
    }

    private fun control(path:String,body:JSONObject):Int {
        val connection=(URL(BuildConfig.KS_DEBUG_API_BASE+path).openConnection() as HttpURLConnection)
        return try {
            connection.requestMethod="POST";connection.connectTimeout=5_000;connection.readTimeout=5_000
            connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json")
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            connection.responseCode.also { check(it in 200..299) { "Journey control unavailable: HTTP $it" } }
        } finally { connection.disconnect() }
    }

    @Test fun prepareProjectedTraceForRevisit() {
        val trace=keepThroughUi()
        open(trace.eventId)
        val selected=runBlocking { ApiClient().getTraceRevisit(trace.eventId) }
        compose.onNodeWithText(selected.scroll.title).assertExists()
        compose.onNodeWithText(selected.scroll.body).assertExists()
        compose.onNodeWithText(selected.scroll.sourceTitle).assertExists()
        assertEquals(selected.scroll.revision,store().readRevisit()?.revision)
        compose.onNodeWithContentDescription("Scroll reading content")
            .performScrollToNode(hasContentDescription("Get the next Scroll"))
        waitUntil { (store().readRevisit()?.readingPosition ?: 0)>0 }
        val before=store().readRevisit() ?: error("Missing revisit before recreation")
        compose.activityRule.scenario.recreate()
        waitUntil {
            compose.onAllNodesWithText("SAVED FROM YOUR KEEP").fetchSemanticsNodes().isNotEmpty() &&
                displayedPosition()=="Reading position ${before.readingPosition}"
        }
        assertEquals(before,store().readRevisit())
        screenshot("trace-revisit-prepare.png")
        receipt("trace-revisit-prepare.json","prepareProjectedTraceForRevisit",trace.eventId) {
            put("traceReaderVisible",true);put("savedOriginVisible",true)
            put("exactSelectedContentAsserted",true);put("activityRecreationPreservedIdentityAndPosition",true)
        }
    }

    /** The harness force-stops and relaunches the .journey app between this and prepare. */
    @Test fun coldRestoreRefetchesSavedTraceIdentityAndPosition() {
        guardJourneyApp()
        val before=store().readRevisit() ?: error("Expected persisted saved-Trace identity after cold preparation")
        waitUntil {
            store().readRevisit()?.eventId==before.eventId &&
                compose.onAllNodesWithText("SAVED FROM YOUR KEEP").fetchSemanticsNodes().isNotEmpty() &&
                displayedPosition()=="Reading position ${before.readingPosition}"
        }
        assertEquals(before.revision,store().readRevisit()?.revision)
        screenshot("trace-revisit-cold.png")
        receipt("trace-revisit-cold.json","coldRestoreRefetchesSavedTraceIdentityAndPosition",before.eventId) {
            put("coldRefetchedSameIdentity",true);put("positionRestored",true)
        }
    }

    @Test fun reopensVerifiedTraceShowsSourcesAndReturns() {
        val trace=projectedTrace()
        open(trace.eventId)
        compose.onNodeWithContentDescription("Sources for this Scroll").performClick()
        waitUntil { compose.onAllNodesWithText("Sources and truth").fetchSemanticsNodes().isNotEmpty() }
        screenshot("trace-revisit-sources.png")
        compose.onNodeWithContentDescription("Close sources").performClick()
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        waitUntil { compose.onAllNodesWithContentDescription(traceDescription(trace.eventId)).fetchSemanticsNodes().isNotEmpty() }
        receipt("trace-revisit-sources.json","reopensVerifiedTraceShowsSourcesAndReturns",trace.eventId) {
            put("sourcesVisible",true);put("returnedToUniverse",true)
        }
    }

    @Test fun traceReadDropRetriesSameIdentity() {
        val trace=projectedTrace()
        showTraceCard(trace.eventId)
        val controlStatus=control("/__journey/trace-mode",JSONObject().put("eventId",trace.eventId).put("mode","drop_next"))
        compose.onNodeWithContentDescription(traceDescription(trace.eventId)).performClick()
        waitUntil { compose.onAllNodesWithText("This Scroll is unavailable.").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(trace.eventId,store().readRevisit()?.eventId)
        compose.onNodeWithText("Retry").performClick()
        waitUntil { compose.onAllNodesWithText("SAVED FROM YOUR KEEP").fetchSemanticsNodes().isNotEmpty() }
        screenshot("trace-revisit-retry.png")
        receipt("trace-revisit-retry.json","traceReadDropRetriesSameIdentity",trace.eventId) {
            put("controlStatus",controlStatus);put("sameIdentityRetried",true)
        }
    }

    @Test fun changedSourceDiscardsTraceReader() {
        val trace=projectedTrace()
        showTraceCard(trace.eventId)
        val changed=control("/__journey/source-mode",JSONObject().put("assetId",trace.assetId).put("mode","changed"))
        try {
            compose.onNodeWithContentDescription(traceDescription(trace.eventId)).performClick()
            waitUntil { compose.onAllNodesWithText("This Scroll is unavailable.").fetchSemanticsNodes().isNotEmpty() }
            assertNull(store().readRevisit())
            waitUntil { compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isEmpty() }
            screenshot("trace-revisit-drift.png")
            receipt("trace-revisit-drift.json","changedSourceDiscardsTraceReader",trace.eventId) {
            put("controlStatus",changed);put("revisitPurged",true);put("contentAbsent",true)
            put("requestedAssetFingerprint",fingerprint(trace.assetId))
            }
        } finally {
            control("/__journey/source-mode",JSONObject().put("assetId",trace.assetId).put("mode","original"))
        }
    }

    @Test fun explicitNextLeavesTraceForFreshDiscovery() {
        val trace=projectedTrace();open(trace.eventId)
        compose.onNodeWithContentDescription("Scroll reading content")
            .performScrollToNode(hasContentDescription("Get the next Scroll"))
        compose.onNodeWithContentDescription("Get the next Scroll").performClick()
        waitUntil {
            store().readRevisit()==null && store().readScreen()=="scroll" &&
                store().read()?.let { it.item.assetId!=trace.assetId && it.exposureId.isNotEmpty() }==true
        }
        assertNotEquals(trace.assetId,store().read()?.item?.assetId)
        assertEquals("",store().read()?.keepJobId)
        screenshot("trace-revisit-next.png")
        receipt("trace-revisit-next.json","explicitNextLeavesTraceForFreshDiscovery",trace.eventId) {
            put("freshExposureRecorded",true);put("savedOriginDiscarded",true)
        }
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        showTraceCard(trace.eventId)
    }

    @Test fun clearHistoryDiscardsOpenTrace() {
        val trace=projectedTrace();open(trace.eventId)
        val status=control("/__journey/clear-history",JSONObject())
        compose.activityRule.scenario.recreate()
        waitUntil { store().readRevisit()==null && compose.onAllNodesWithText("Your universe").fetchSemanticsNodes().isNotEmpty() }
        screenshot("trace-revisit-clear.png")
        receipt("trace-revisit-clear.json","clearHistoryDiscardsOpenTrace",trace.eventId) {
            put("controlStatus",status);put("revisitPurged",true);put("contentAbsent",true)
            put("requestedAssetFingerprint",fingerprint(trace.assetId))
        }
    }

    @Test fun revokedSessionDiscardsOpenTrace() {
        val trace=keepThroughUi();open(trace.eventId)
        val status=control("/__journey/revoke-sessions",JSONObject())
        compose.activityRule.scenario.recreate()
        waitUntil { store().readRevisit()==null && compose.onAllNodesWithText("The universe is unreachable.").fetchSemanticsNodes().isNotEmpty() }
        screenshot("trace-revisit-authority.png")
        receipt("trace-revisit-authority.json","revokedSessionDiscardsOpenTrace",trace.eventId) {
            put("controlStatus",status);put("revisitPurged",true);put("contentAbsent",true)
            put("requestedAssetFingerprint",fingerprint(trace.assetId))
        }
    }
}
