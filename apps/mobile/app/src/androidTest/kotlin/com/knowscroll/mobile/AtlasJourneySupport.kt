package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.StateStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import java.io.File

/** #134 — the reader walk shared by the atlas journeys ([PlacesJourneyTest], [FoundationJourneyTest]):
 * open the reader, keep target Scrolls whenever the Composer offers them, open the System. */
abstract class AtlasJourneySupport {

    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    protected val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    protected fun store() = StateStore(instrumentation.targetContext)

    protected fun screenshot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        Thread.sleep(350)
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    protected fun waitReading() = compose.waitUntil(20_000) {
        store().read()?.exposureId?.isNotEmpty() == true &&
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
    }

    protected fun openReader() {
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName)) { "Atlas journeys require the separate journey app" }
        compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        waitReading()
    }

    /** Ordinary deliberate discovery, bounded, exactly like `SemanticBranchJourneyTest`: each target
     * Scroll (by the start of its real title) is kept whenever the feed offers it, in whatever order
     * the Composer chooses -- a trip never re-offers what it has already shown, so walking past one
     * target while looking for another would lose it. Each keep waits for its real job to project. */
    protected fun keepWhenOffered(vararg titlePrefixes: String) {
        val remaining = titlePrefixes.toMutableList()
        var tries = 0
        while (remaining.isNotEmpty() && tries < 30) {
            val title = store().read()!!.item.title
            val target = remaining.firstOrNull { title.startsWith(it) }
            if (target != null) {
                keepCurrent(target)
                remaining.remove(target)
                if (remaining.isEmpty()) break
            }
            val current = store().read()!!.item.assetId
            compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasContentDescription("Get the next Scroll"))
            compose.onNodeWithContentDescription("Get the next Scroll").performClick()
            compose.waitUntil(20_000) { store().read()?.item?.assetId != current }
            waitReading()
            tries++
        }
        assertTrue("the feed never offered $remaining within a bounded trip", remaining.isEmpty())
    }

    protected fun keepCurrent(titlePrefix: String) {
        // Keep lives in the fixed reader toolbar, outside the scrolling content (as in SemanticWhyJourneyTest).
        compose.onNodeWithContentDescription("Keep this Scroll").performClick()
        compose.waitUntil(15_000) { store().read()?.keepJobId?.isNotEmpty() == true }
        val eventId = store().read()!!.keepEventId
        runBlocking {
            var projected = false
            repeat(40) {
                if (!projected) {
                    projected = ApiClient().getEvent(eventId).projected
                    if (!projected) delay(250)
                }
            }
            assertTrue("keep of \"$titlePrefix\" never projected", projected)
        }
    }

    protected fun openSystem() {
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithContentDescription("Open the system view").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Open the system view").performScrollTo().performClick()
    }
}
