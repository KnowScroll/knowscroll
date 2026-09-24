package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.StateStore
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #97 — with the reader open and a bottom sheet showing, an Activity recreation (rotation,
 * configuration change) used to leave the sheet closed, even though `sourcesOpen`/`explainOpen`/
 * `connectionsOpen` are `rememberSaveable`. Root cause: `AppViewModel.onForeground()` runs
 * `reconcilePrivacy(restoreStoredScroll = true)` on every `Lifecycle.State.STARTED` re-entry --
 * including the one right after `Activity.recreate()`, since `KnowScrollApp`'s
 * `repeatOnLifecycle(Lifecycle.State.STARTED)` restarts fresh on every `onStart` -- which briefly
 * sets `scroll` to `ScrollState.Loading` and then restores a *fresh* `Reading` for the same
 * assetId from the persisted store. That is a second mount of `ReadingSheet` inside the same live
 * composition, and Compose's `SaveableStateRegistry` only lets a `Bundle`-restored value be
 * consumed once, so the second mount fell back to the plain `false` default. The fix hoists the
 * sheet flags to `ScrollScreen`, above the `when` that used to remove them from composition during
 * that reload (see `ScrollScreen.kt`). This test drives the real app end to end (real
 * `AppViewModel`, real `onForeground()`), following `ReaderExplainJourneyTest`/
 * `SemanticBranchJourneyTest`'s launch/wait patterns, and is a joined-runtime journey on the
 * separate `journey` app: `KS_SEMANTIC_JOURNEY=sheets python3 scripts/android-semantic-journey.py`.
 */
@RunWith(AndroidJUnit4::class)
class ReaderSheetRecreationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)

    private fun guardJourneyApp() {
        check(instrumentation.targetContext.packageName.startsWith("com.knowscroll.mobile.journey")) {
            "Reader sheet recreation verification requires the separate journey app"
        }
    }

    private fun waitText(text: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    }
    private fun textShown(text: String): Boolean =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    private fun waitReading() = compose.waitUntil(15_000) {
        store().read()?.exposureId?.isNotEmpty() == true &&
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
    }

    /** The three tests share one install, so a later one may launch straight back into the reading
     * session an earlier one persisted; either starting point is a real reading Scroll, and each
     * test's new Activity starts with every sheet closed. */
    private fun openReader() {
        guardJourneyApp()
        compose.waitUntil(20_000) {
            compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty() ||
                compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
        }
        if (compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isEmpty()) {
            compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        }
        waitReading()
    }

    private fun screenshot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        val bitmap: Bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("Android screenshot was unavailable")
        File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun writeReceipt(name: String, value: JSONObject) =
        File(instrumentation.targetContext.filesDir, name).writeText(value.toString(2))

    @Test fun sourcesSheetSurvivesRecreation() {
        openReader()
        val before = store().read() ?: error("Expected a persisted reading session")
        compose.onNodeWithContentDescription("Sources for this Scroll").performClick()
        waitText("Sources and truth")

        compose.activityRule.scenario.recreate()
        waitText("Sources and truth")

        val after = store().read() ?: error("Reading session lost across recreation")
        assertEquals(before.item.assetId, after.item.assetId)
        assertEquals(before.exposureId, after.exposureId)
        screenshot("sources-sheet-recreate.png")
        writeReceipt("sources-sheet-recreate.json", JSONObject().apply {
            put("scenario", "sourcesSheetSurvivesRecreation")
            put("assetId", after.item.assetId); put("exposureId", after.exposureId)
            put("sheetRestoredAfterRecreation", true)
        })
    }

    @Test fun explainSheetSurvivesRecreation() {
        openReader()
        val before = store().read() ?: error("Expected a persisted reading session")
        compose.onNodeWithContentDescription("Why this Scroll appeared").performClick()
        waitText("Why this appeared")

        compose.activityRule.scenario.recreate()
        waitText("Why this appeared")

        val after = store().read() ?: error("Reading session lost across recreation")
        assertEquals(before.item.assetId, after.item.assetId)
        assertEquals(before.exposureId, after.exposureId)
        screenshot("explain-sheet-recreate.png")
        writeReceipt("explain-sheet-recreate.json", JSONObject().apply {
            put("scenario", "explainSheetSurvivesRecreation")
            put("assetId", after.item.assetId); put("exposureId", after.exposureId)
            put("sheetRestoredAfterRecreation", true)
        })
    }

    /** Best-effort: only Scrolls with live continuations offer the Connections sheet, so this
     * advances through ordinary discovery (as SemanticBranchJourneyTest does) until one is found,
     * bounded so a library without continuations does not hang. */
    @Test fun connectionsSheetSurvivesRecreationWhenAvailable() {
        openReader()
        var connected = textShown("Why these connections?")
        var hops = 0
        while (!connected && hops < 24) {
            val current = store().read()!!.item.assetId
            compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasContentDescription("Get the next Scroll"))
            compose.onNodeWithContentDescription("Get the next Scroll").performClick()
            compose.waitUntil(20_000) { store().read()?.item?.assetId?.let { it != current } == true }
            waitReading()
            connected = textShown("Why these connections?")
            hops++
        }
        org.junit.Assume.assumeTrue("no encounter with live continuations was reached in $hops hops", connected)

        val before = store().read() ?: error("Expected a persisted reading session")
        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText("Why these connections?"))
        compose.onNodeWithText("Why these connections?").performClick()
        waitText("How these connect")

        compose.activityRule.scenario.recreate()
        waitText("How these connect")

        val after = store().read() ?: error("Reading session lost across recreation")
        assertEquals(before.item.assetId, after.item.assetId)
        assertEquals(before.exposureId, after.exposureId)
        screenshot("connections-sheet-recreate.png")
        writeReceipt("connections-sheet-recreate.json", JSONObject().apply {
            put("scenario", "connectionsSheetSurvivesRecreationWhenAvailable")
            put("assetId", after.item.assetId); put("exposureId", after.exposureId); put("hopsToReachContinuations", hops)
            put("sheetRestoredAfterRecreation", true)
        })
    }
}
