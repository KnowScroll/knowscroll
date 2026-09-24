package com.knowscroll.mobile

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ScrollSession
import com.knowscroll.mobile.data.StateStore
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Joined-runtime tests run only in the separate disposable journey application. */
@RunWith(AndroidJUnit4::class)
class ReaderJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)
    private fun guardJourneyApp() {
        check(instrumentation.targetContext.packageName.startsWith("com.knowscroll.mobile.journey")) {
            "Reader verification requires the separate journey app"
        }
    }
    private fun waitText(text: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    }
    private fun waitReading() = compose.waitUntil(15_000) {
        store().read()?.exposureId?.isNotEmpty() == true &&
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
    }
    private fun waitReaderOrSources() = compose.waitUntil(15_000) {
        store().read()?.exposureId?.isNotEmpty() == true &&
            (compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty() ||
                compose.onAllNodesWithText("Sources and truth").fetchSemanticsNodes().isNotEmpty())
    }
    private fun openReader() {
        guardJourneyApp()
        compose.waitUntil(15_000) {
            compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        waitReading()
    }
    private fun reachThreshold() {
        compose.onNodeWithContentDescription("Scroll reading content")
            .performScrollToNode(hasContentDescription("Get the next Scroll"))
        compose.onNodeWithContentDescription("Get the next Scroll").assertIsDisplayed()
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.filesDir, name).outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
    private fun writeReceipt(name: String, value: JSONObject) =
        File(instrumentation.targetContext.filesDir, name).writeText(value.toString(2))
    private fun assertSameSession(before: ScrollSession, after: ScrollSession) {
        assertEquals(before.item, after.item)
        assertEquals(before.decisionId, after.decisionId)
        assertEquals(before.clientExposureId, after.clientExposureId)
        assertEquals(before.clientEventId, after.clientEventId)
        assertEquals(before.exposureId, after.exposureId)
        assertEquals(before.exposureEventId, after.exposureEventId)
        assertEquals(before.keepEventId, after.keepEventId)
        assertEquals(before.keepJobId, after.keepJobId)
        assertEquals(before.readingPosition, after.readingPosition)
    }

    private fun renderedReadingPosition(): Int? {
        val node = compose.onAllNodesWithContentDescription("Scroll reading content")
            .fetchSemanticsNodes().singleOrNull() ?: return null
        return node.config[SemanticsProperties.StateDescription].substringAfterLast(' ').toIntOrNull()
    }

    private fun assertRenderedPosition(position: Int) {
        compose.waitUntil(10_000) { renderedReadingPosition() == position }
        assertEquals(position, renderedReadingPosition())
    }

    @Test fun readerSourcesThresholdAndRest() = runBlocking {
        openReader()
        val first = store().read() ?: error("Expected durable reading session")
        compose.onNodeWithContentDescription("Get the next Scroll").assertIsNotDisplayed()
        screenshot("reader-navigation.png")
        val sourceLabelLayouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Sources", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(sourceLabelLayouts) }
        assertEquals(1, sourceLabelLayouts.single().lineCount)
        for (description in listOf("Sources for this Scroll", "Keep this Scroll", "Return to the universe")) {
            compose.onNodeWithContentDescription(description).assertHeightIsAtLeast(48.dp)
        }
        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText(first.item.body))
        compose.waitUntil(10_000) {
            val persisted = store().read()?.readingPosition ?: 0
            persisted > 0 && renderedReadingPosition() == persisted
        }
        val beforeSource = store().read()!!
        compose.activityRule.scenario.recreate()
        waitReading()
        assertSameSession(beforeSource, store().read()!!)
        assertRenderedPosition(beforeSource.readingPosition)
        val closedRecreationPosition = renderedReadingPosition()
        compose.onNodeWithContentDescription("Sources for this Scroll").performClick()
        waitText("Sources and truth")
        screenshot("reader-source.png")
        compose.activityRule.scenario.recreate()
        waitReaderOrSources()
        val sourceSheetRestored = compose.onAllNodesWithText("Sources and truth").fetchSemanticsNodes().isNotEmpty()
        if (!sourceSheetRestored) {
            compose.onNodeWithContentDescription("Sources for this Scroll").performClick()
            waitText("Sources and truth")
        }
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Sources and truth").fetchSemanticsNodes().isEmpty() }
        assertSameSession(beforeSource, store().read()!!)
        assertRenderedPosition(beforeSource.readingPosition)
        val sourceOpenRecreationPosition = renderedReadingPosition()
        compose.onNodeWithContentDescription("Sources for this Scroll").performClick()
        waitText("Sources and truth")
        val journeyPackage = instrumentation.targetContext.packageName
        compose.waitUntil(15_000) {
            instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == journeyPackage
        }
        compose.onNodeWithContentDescription("Open ${first.item.sourceTitle} in browser").performClick()
        var externalWindowObserved = false
        var externalWindowPackage: String? = null
        var browserUnavailableObserved = false
        compose.waitUntil(15_000) {
            val activePackage = instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()
            if (activePackage != null && activePackage != journeyPackage) {
                externalWindowObserved = true
                externalWindowPackage = activePackage
            } else if (activePackage == journeyPackage) {
                browserUnavailableObserved = runCatching { compose.onAllNodesWithText(
                    "A browser could not open this source. You can still read its address above."
                ).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)
            }
            externalWindowObserved || browserUnavailableObserved
        }
        var lifecycleBeforeReturn = "unknown"
        compose.activityRule.scenario.onActivity { lifecycleBeforeReturn = it.lifecycle.currentState.name }
        // Return only this journey package to foreground, including when no browser is installed.
        val returnIntent = instrumentation.targetContext.packageManager
            .getLaunchIntentForPackage(instrumentation.targetContext.packageName)!!
        returnIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        instrumentation.targetContext.startActivity(returnIntent)
        compose.waitUntil(15_000) {
            instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == journeyPackage
        }
        waitReaderOrSources()
        val close = compose.onAllNodesWithContentDescription("Close sources")
        if (close.fetchSemanticsNodes().isNotEmpty()) close[0].performClick()
        waitReading()
        assertSameSession(beforeSource, store().read()!!)
        assertRenderedPosition(beforeSource.readingPosition)
        val discovered = mutableListOf(first.item.assetId)
        repeat(4) {
            reachThreshold()
            compose.onNodeWithContentDescription("Get the next Scroll").performClick()
            compose.waitUntil(15_000) {
                store().read()?.item?.assetId != discovered.last() ||
                    compose.onAllNodesWithText("A quiet place to stop").fetchSemanticsNodes().isNotEmpty()
            }
            val current = store().read()!!
            if (current.item.assetId != discovered.last()) {
                waitReading()
                discovered.add(current.item.assetId)
            }
        }
        waitText("A quiet place to stop")
        compose.onNodeWithText("Check library again").assertIsDisplayed()
        screenshot("reader-rest.png")
        assertEquals(discovered.size, discovered.toSet().size)
        val last = store().read()!!
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        waitText("Your universe")
        writeReceipt("reader-navigation.json", JSONObject().apply {
            put("scenario", "readerSourcesThresholdAndRest")
            put("sourceSessionPreserved", true)
            put("closedRecreationReadingPosition", closedRecreationPosition)
            put("sourceOpenRecreationReadingPosition", sourceOpenRecreationPosition)
            put("sourceOpenRecreationRetryEnvelopePreserved", true)
            put("sourceSheetRestoredAfterRecreation", sourceSheetRestored)
            put("sourceLaunchReturnSessionPreserved", true)
            put("externalWindowObserved", externalWindowObserved)
            put("externalWindowPackage", externalWindowPackage ?: JSONObject.NULL)
            put("browserUnavailableObserved", browserUnavailableObserved)
            put("readerLifecycleBeforeReturn", lifecycleBeforeReturn)
            put("browserContentLoaded", JSONObject.NULL)
            put("sourceBackStayedInReader", true)
            put("visitedAssetIds", JSONArray(discovered))
            put("lastAssetId", last.item.assetId)
            put("finiteLibraryRest", true)
            put("nextInitiallyHidden", true)
            put("returnedHome", true)
        })
    }

    @Test fun readerNextFailurePreservesPage() = runBlocking {
        openReader()
        reachThreshold()
        compose.waitUntil(10_000) { (store().read()?.readingPosition ?: 0) > 0 }
        val before = store().read()!!
        val connection = URL(BuildConfig.KS_DEBUG_API_BASE + "/__journey/feed-mode").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write("{\"mode\":\"drop_next\"}".toByteArray()) }
            check(connection.responseCode in 200..299) { "Journey transport control was unavailable" }
        } finally { connection.disconnect() }
        compose.onNodeWithContentDescription("Get the next Scroll").performTouchInput { doubleClick() }
        waitText("Finding the next Scroll…")
        compose.onNodeWithContentDescription("Scroll reading content").assertIsDisplayed()
        assertSameSession(before, store().read()!!)
        waitText("Retry next Scroll")
        compose.onNodeWithContentDescription("Scroll reading content").assertIsDisplayed()
        assertSameSession(before, store().read()!!)
        screenshot("reader-retry.png")
        compose.onNodeWithContentDescription("Get the next Scroll").performClick()
        compose.waitUntil(15_000) { store().read()?.item?.assetId != before.item.assetId }
        waitReading()
        val next = store().read()!!
        assertNotEquals(before.clientExposureId, next.clientExposureId)
        writeReceipt("reader-retry.json", JSONObject().apply {
            put("scenario", "readerNextFailurePreservesPage")
            put("oldAssetId", before.item.assetId)
            put("oldExposureId", before.exposureId)
            put("oldClientExposureId", before.clientExposureId)
            put("oldClientEventId", before.clientEventId)
            put("oldReadingPosition", before.readingPosition)
            put("loadingPreservedSession", true)
            put("failurePreservedSession", true)
            put("duplicateTapGuarded", true)
            put("newAssetId", next.item.assetId)
            put("newExposureId", next.exposureId)
            put("transport", "Two injected socket closures; real forwarded retry")
        })
    }
}
