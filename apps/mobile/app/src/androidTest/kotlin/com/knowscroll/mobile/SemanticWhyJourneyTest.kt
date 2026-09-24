package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.StateStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * #133 — journey G on a real emulator against a disposable API, worker and PostgreSQL loaded with
 * the editorial substrate, served by `composer-semantic-v3` (scripts/android-semantic-journey.py
 * --journey why). A reader keeps a Scroll and deliberately asks for the next one; its "why" shows
 * the recorded path that names that keep; "Less like this" corrects the route. The runner then
 * checks the decision, the cited keep and the correction in the database.
 */
@RunWith(AndroidJUnit4::class)
class SemanticWhyJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)

    private fun screenshot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun textShown(text: String, substring: Boolean = false): Boolean =
        compose.onAllNodes(hasText(text, substring = substring), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun waitReadingExposed(assetId: String? = null) = compose.waitUntil(20_000) {
        val s = store().read()
        s != null && s.exposureId.isNotEmpty() && (assetId == null || s.item.assetId == assetId) &&
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
    }

    @Test
    fun theWhySheetNamesTheKeepThatLedHereAndLessLikeThisCorrectsTheRoute() {
        try { journey() } catch (failure: Throwable) { runCatching { screenshot("why-failure.png") }; throw failure }
    }

    private fun journey() {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey") { "Semantic journey requires the separate journey app" }
        compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        waitReadingExposed()

        var citedTitle: String? = null
        var keeps = 0
        while (citedTitle == null && keeps < 8) {
            val kept = store().read()!!
            compose.onNodeWithContentDescription("Keep this Scroll").performClick()
            compose.waitUntil(20_000) { store().read()?.keepJobId?.isNotEmpty() == true }
            keeps += 1
            compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasContentDescription("Get the next Scroll"))
            compose.onNodeWithContentDescription("Get the next Scroll").performClick()
            compose.waitUntil(20_000) { store().read()?.item?.assetId?.let { it != kept.item.assetId } == true }
            waitReadingExposed()

            compose.onNodeWithContentDescription("Why this Scroll appeared").performClick()
            compose.waitUntil(10_000) { textShown("What led here") }
            compose.waitUntil(10_000) { !textShown("Reading what was recorded…") }
            if (textShown("You kept “${kept.item.title}”")) citedTitle = kept.item.title
            else {
                compose.onNodeWithText("Back to reading").performScrollTo().performClick()
                compose.waitUntil(10_000) { !textShown("What led here") }
            }
        }
        assertNotNull("no encounter's recorded path named the keep that led to it", citedTitle)
        compose.onNodeWithText("What led here").performScrollTo()
        screenshot("why-path.png")

        compose.onNodeWithText("Less like this").performScrollTo().performClick()
        compose.waitUntil(15_000) { textShown("You will see less of this route for 14 days", substring = true) }
        assertEquals("a made correction is not offered again", 0, compose.onAllNodesWithText("Less like this").fetchSemanticsNodes().size)
        compose.onNodeWithText("You will see less of this route for 14 days", substring = true).performScrollTo()
        screenshot("why-corrected.png")

        val served = store().read()!!
        File(instrumentation.targetContext.filesDir, "why-journey.json").writeText(JSONObject().apply {
            put("decisionId", served.decisionId); put("assetId", served.item.assetId); put("title", served.item.title)
            put("citedKeepTitle", citedTitle); put("keepsBeforeCited", keeps)
        }.toString(2))
    }
}
