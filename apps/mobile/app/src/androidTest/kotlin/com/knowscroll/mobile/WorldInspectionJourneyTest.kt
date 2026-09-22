package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.lifecycle.Lifecycle
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.HistoryClearRequest
import kotlinx.coroutines.runBlocking
import java.util.UUID
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Run against the seeded disposable audit API, never the owner application. */
@RunWith(AndroidJUnit4::class)
class WorldInspectionJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val world = SemanticsMatcher("source-backed world selector") {
        it.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() }
            .any { label -> label.startsWith("Explore world: ") }
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        Thread.sleep(350) // Let the compositor present the completed 240ms approach.
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(instrumentation.targetContext.filesDir, name).outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }
    @Test fun worldBackRecreationAndCollection() {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey")
        compose.waitUntil(15_000) {
            compose.onAllNodesWithContentDescription("Open the system view").fetchSemanticsNodes().isNotEmpty()
        }
        screenshot("atlas-ui.png")
        compose.onNodeWithContentDescription("Open the system view").performScrollTo().performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(world).fetchSemanticsNodes().isNotEmpty() }
        val selector = compose.onAllNodes(world)[0]
        val label = selector.fetchSemanticsNode().config[SemanticsProperties.ContentDescription].first()
        screenshot("system-ui.png")
        selector.performClick()
        compose.onNodeWithText(label.removePrefix("Explore world: ")).assertExists()
        compose.onNodeWithContentDescription("Close world detail and return to the system").assertIsDisplayed()
        screenshot("world-ui.png")
        compose.activityRule.scenario.recreate()
        compose.waitUntil(15_000) {
            compose.onAllNodesWithContentDescription("Close world detail and return to the system").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Open source").performScrollTo().assertIsDisplayed()
        val source = compose.onNodeWithText("Open source").getUnclippedBoundsInRoot()
        val dock = compose.onNodeWithText("Atlas").getUnclippedBoundsInRoot()
        assertTrue("Source action must remain above the dock", source.bottom <= dock.top)
        screenshot("world-source-ui.png")
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(10_000) { compose.onAllNodes(world).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription(label).assertIsDisplayed()
        compose.onNodeWithText("Keep").performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Saved Traces. Tap any to reopen the verified original.").fetchSemanticsNodes().isNotEmpty() }
        screenshot("keep-ui.png")
        File(instrumentation.targetContext.filesDir, "world-ui-receipt.json").writeText(
            """{"result":"passed","worldDetailRecreated":true,"systemBackPreserved":true,"sourceAboveDock":true,"keepReached":true,"sourceBrowserContentLoaded":null}"""
        )
    }
    @Test fun clearedWorldIsNotRestoredOnForeground() = runBlocking {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey")
        compose.waitUntil(15_000) {
            compose.onAllNodesWithContentDescription("Open the system view").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Open the system view").performScrollTo().performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(world).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(world)[0].performClick()
        compose.onNodeWithText("Open source").assertExists()
        val api = ApiClient()
        val before = api.getUniverse()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        val cleared = api.clearScrollHistory(HistoryClearRequest(requestId = UUID.randomUUID().toString(), expectedPrivacyEpoch = before.privacyEpoch, universeId = before.universeId))
        assertTrue(cleared.privacyEpoch > before.privacyEpoch)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(15_000) {
            compose.onAllNodesWithText("Your universe").fetchSemanticsNodes().isNotEmpty() &&
                compose.onAllNodesWithContentDescription("Close world detail and return to the system").fetchSemanticsNodes().isEmpty()
        }
        compose.onAllNodesWithText("Open source").assertCountEquals(0)
        assertTrue(api.getWorldSystem().system == null)
        File(instrumentation.targetContext.filesDir, "world-privacy-receipt.json").writeText(
            """{"result":"passed","worldPurgedAfterPrivacyEpochChange":true,"serverSystemEmpty":true}"""
        )
    }

}
