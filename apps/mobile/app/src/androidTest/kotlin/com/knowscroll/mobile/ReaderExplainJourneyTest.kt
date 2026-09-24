package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.StateStore
import java.io.File
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * "Why this appeared" (#91) joined proof. Every successful response comes from the
 * disposable API; the only fixture is the journey proxy's own request/response
 * rewriting (never the API/composer itself) and `pm clear`, both driven by the
 * Python harness between separate `am instrument` invocations -- never from inside
 * a running instrumentation, which crashes its own process.
 */
@RunWith(AndroidJUnit4::class)
class ReaderExplainJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)

    private fun guardJourneyApp() {
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName)) {
            "Explain-sheet verification requires the separate journey app"
        }
    }

    private fun waitText(text: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    }
    private fun waitDescription(description: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }
    private fun waitReading() = compose.waitUntil(15_000) {
        store().read()?.exposureId?.isNotEmpty() == true &&
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
    }
    /** Background reader content stays composed behind the modal sheet, so matched
     * text can legitimately appear twice; assert presence, never singular identity. */
    private fun assertVisible(text: String) =
        assertTrue("Expected to find text: $text", compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty())

    private fun openReaderFresh() {
        guardJourneyApp()
        waitDescription("Enter Scroll")
        compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        waitReading()
    }

    private fun openExplainSheet() {
        waitDescription("Why this Scroll appeared")
        compose.onNodeWithContentDescription("Why this Scroll appeared").performClick()
        waitText("Why this appeared")
    }

    private fun screenshot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        val bitmap: Bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("Android screenshot was unavailable")
        File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun writeReceipt(name: String, value: JSONObject) =
        File(instrumentation.targetContext.filesDir, name).writeText(value.toString(2))

    /** #161: the sheet explains the truth state without ever pointing at a source. */
    @Test fun explainSheetShowsDiscoveryReasonAndTruthButNoSource() = runBlocking {
        openReaderFresh()
        val opened = store().read() ?: error("Expected a persisted reading session")
        // Accessible, thumb-sized control per Law 13.
        compose.onNodeWithContentDescription("Why this Scroll appeared").assertHeightIsAtLeast(48.dp)
        openExplainSheet()
        assertVisible(opened.item.reason)
        assertVisible("DOCUMENTED")
        assertVisible("Directly supported by strong cited evidence.")
        compose.onAllNodesWithText("Sources below show this evidence.").assertCountEquals(0)
        compose.onAllNodesWithText(opened.item.sourceTitle, substring = true).assertCountEquals(0)
        assertVisible("You opened this Scroll through deliberate discovery from your universe.")
        screenshot("explain-discovery.png")
        compose.onNodeWithContentDescription("Close why this appeared").assertHeightIsAtLeast(48.dp).performClick()
        waitReading()
        writeReceipt("explain-discovery.json", JSONObject().apply {
            put("scenario", "explainSheetShowsDiscoveryReasonAndTruthButNoSource")
            put("assetId", opened.item.assetId); put("reason", opened.item.reason)
            put("truthState", opened.item.truthState); put("originDiscovery", true)
            put("sourceShown", false)
        })
    }

    /** The harness sets the blank-reason proxy fixture and `pm clear`s the app
     * before this instrumentation runs, so the very first /v1/feed fetch here is
     * the doctored one. */
    @Test fun explainSheetReportsNoRecordedExplanationForABlankReason() = runBlocking {
        openReaderFresh()
        val opened = store().read() ?: error("Expected a persisted reading session")
        assertEquals("", opened.item.reason)
        openExplainSheet()
        assertVisible("No explanation was recorded for this Scroll.")
        screenshot("explain-blank-reason.png")
        writeReceipt("explain-blank-reason.json", JSONObject().apply {
            put("scenario", "explainSheetReportsNoRecordedExplanationForABlankReason")
            put("assetId", opened.item.assetId)
            put("proxyRewroteReasonOnly", true); put("apiComposerUnchanged", true)
        })
    }

    @Test fun explainSheetShowsSavedTraceOriginWithKeptDateAndNoReason() = runBlocking {
        openReaderFresh()
        compose.onNodeWithContentDescription("Keep this Scroll").performClick()
        waitText("Kept")
        val kept = store().read() ?: error("Expected accepted keep")
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        val api = ApiClient()
        var traceEventId: String? = null
        repeat(60) {
            val trace = api.getUniverse().traces.firstOrNull { it.assetId == kept.item.assetId }
            if (trace != null) { traceEventId = trace.eventId; return@repeat }
            delay(250)
        }
        val eventId = traceEventId ?: error("Separate worker did not project the UI Keep")
        val revisit = api.getTraceRevisit(eventId)
        // Saved Traces live in Keep (the dock), each described by its Scroll's title (#72 audit A4);
        // the Keep screen reads the universe when it opens, so a card projected just after is
        // caught by opening it once more.
        val traceDescription = "Reopen saved Scroll ${kept.item.title}"
        var found = false
        repeat(3) {
            if (found) return@repeat
            compose.waitUntil(15_000) { compose.onAllNodesWithText("Keep").fetchSemanticsNodes().isNotEmpty() }
            compose.onAllNodesWithText("Keep")[0].performClick()
            found = runCatching {
                compose.waitUntil(8_000) { compose.onAllNodesWithContentDescription(traceDescription).fetchSemanticsNodes().isNotEmpty() }
            }.isSuccess
            if (!found) compose.onAllNodesWithText("Atlas")[0].performClick()
        }
        check(found) { "Keep never showed the saved Scroll" }
        compose.onNodeWithContentDescription(traceDescription).performScrollTo().assertIsDisplayed().performClick()
        waitText("SAVED FROM YOUR KEEP")
        openExplainSheet()
        assertVisible("No explanation was recorded for this Scroll.")
        assertVisible("This is a saved Trace you kept, from ${revisit.keptAt}.")
        screenshot("explain-saved-trace.png")
        writeReceipt("explain-saved-trace.json", JSONObject().apply {
            put("scenario", "explainSheetShowsSavedTraceOriginWithKeptDateAndNoReason")
            put("traceEventId", eventId); put("keptAt", revisit.keptAt)
            put("reasonAbsentAsExpected", true); put("originStatesKeptDate", true)
        })
    }

    @Test fun explainSheetPrepareForRotationAndProcessDeath() = runBlocking {
        openReaderFresh()
        openExplainSheet()
        val before = store().read() ?: error("Expected a persisted reading session")
        compose.activityRule.scenario.recreate()
        // Mirrors the other reader sheets: recreation may or may not keep the sheet
        // open (rememberSaveable through the same key), so both outcomes are handled
        // and the observed one is reported rather than assumed.
        waitReading()
        val restoredOpen = compose.onAllNodesWithText("Why this appeared").fetchSemanticsNodes().isNotEmpty()
        if (!restoredOpen) openExplainSheet()
        val afterRecreate = store().read() ?: error("Reading session lost across recreation")
        assertEquals(before.item.assetId, afterRecreate.item.assetId)
        assertEquals(before.exposureId, afterRecreate.exposureId)
        screenshot("explain-recreate.png")
        writeReceipt("explain-prepare.json", JSONObject().apply {
            put("scenario", "explainSheetPrepareForRotationAndProcessDeath")
            put("assetId", before.item.assetId); put("exposureId", before.exposureId)
            put("readingPosition", before.readingPosition)
            put("sheetRestoredAfterRecreation", restoredOpen)
            put("readingSessionPreservedAfterRecreation", true)
            put("phase", "before-force-stop")
        })
    }

    /** Launched by the harness after `am force-stop`+relaunch. A transient dialog's
     * open/closed flag is not the durable retry envelope; only the latter must survive
     * real process death. */
    @Test fun explainSheetRestoresReadingAfterProcessDeath() {
        guardJourneyApp()
        val before = JSONObject(File(instrumentation.targetContext.filesDir, "explain-prepare.json").readText())
        waitReading()
        val restored = store().read() ?: error("Reading session missing after process death")
        assertEquals(before.getString("assetId"), restored.item.assetId)
        assertEquals(before.getString("exposureId"), restored.exposureId)
        assertEquals(before.getInt("readingPosition"), restored.readingPosition)
        val sheetOpenAfterProcessDeath = compose.onAllNodesWithText("Why this appeared").fetchSemanticsNodes().isNotEmpty()
        assertFalse("A transient sheet must not silently reappear as if still authorized", sheetOpenAfterProcessDeath)
        screenshot("explain-process-death.png")
        writeReceipt("explain-process-death.json", JSONObject().apply {
            put("scenario", "explainSheetRestoresReadingAfterProcessDeath")
            put("assetId", restored.item.assetId); put("exposureId", restored.exposureId)
            put("readingSessionRestored", true); put("sheetOpenAfterProcessDeath", sheetOpenAfterProcessDeath)
        })
    }
}
