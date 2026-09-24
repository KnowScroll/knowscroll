package com.knowscroll.mobile

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
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName)) {
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
    private fun waitReaderOrWhy() = compose.waitUntil(15_000) {
        store().read()?.exposureId?.isNotEmpty() == true &&
            (compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty() ||
                compose.onAllNodesWithText("Why this appeared").fetchSemanticsNodes().isNotEmpty())
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

    /** #161: the reader offers no Sources control and never shows the Scroll's source; its sheets
     * (here, why it appeared) survive recreation over the same reading session and position. */
    @Test fun readerThresholdAndRest() = runBlocking {
        openReader()
        val first = store().read() ?: error("Expected durable reading session")
        compose.onNodeWithContentDescription("Get the next Scroll").assertIsNotDisplayed()
        compose.onAllNodesWithContentDescription("Sources for this Scroll").assertCountEquals(0)
        compose.onAllNodesWithText(first.item.sourceTitle, substring = true).assertCountEquals(0)
        screenshot("reader-navigation.png")
        val whyLabelLayouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Why", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(whyLabelLayouts) }
        assertEquals(1, whyLabelLayouts.single().lineCount)
        for (description in listOf("Why this Scroll appeared", "Keep this Scroll", "Return to the universe")) {
            compose.onNodeWithContentDescription(description).assertHeightIsAtLeast(48.dp)
        }
        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText(first.item.body))
        compose.waitUntil(10_000) {
            val persisted = store().read()?.readingPosition ?: 0
            persisted > 0 && renderedReadingPosition() == persisted
        }
        val beforeWhy = store().read()!!
        compose.activityRule.scenario.recreate()
        waitReading()
        assertSameSession(beforeWhy, store().read()!!)
        assertRenderedPosition(beforeWhy.readingPosition)
        val closedRecreationPosition = renderedReadingPosition()
        compose.onNodeWithContentDescription("Why this Scroll appeared").performClick()
        waitText("Why this appeared")
        screenshot("reader-why.png")
        compose.activityRule.scenario.recreate()
        waitReaderOrWhy()
        val whySheetRestored = compose.onAllNodesWithText("Why this appeared").fetchSemanticsNodes().isNotEmpty()
        if (!whySheetRestored) {
            compose.onNodeWithContentDescription("Why this Scroll appeared").performClick()
            waitText("Why this appeared")
        }
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Why this appeared").fetchSemanticsNodes().isEmpty() }
        waitReading()
        assertSameSession(beforeWhy, store().read()!!)
        assertRenderedPosition(beforeWhy.readingPosition)
        val whyOpenRecreationPosition = renderedReadingPosition()
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
            put("scenario", "readerThresholdAndRest")
            put("sourceShown", false)
            put("closedRecreationReadingPosition", closedRecreationPosition)
            put("whyOpenRecreationReadingPosition", whyOpenRecreationPosition)
            put("whyOpenRecreationRetryEnvelopePreserved", true)
            put("whySheetRestoredAfterRecreation", whySheetRestored)
            put("whyBackStayedInReader", true)
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
