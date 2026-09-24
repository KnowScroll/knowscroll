package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.lifecycle.Lifecycle
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.HistoryClearRequest
import com.knowscroll.mobile.data.WorldSummary
import kotlinx.coroutines.runBlocking
import java.util.UUID
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * #161: the system view is the reader's own places. The server still derives worlds from what was
 * read, but a world is one source and its only name is that source's, so none is ever drawn -- not
 * on arrival, not after recreation. Run against the seeded disposable audit API, never the owner
 * application.
 */
@RunWith(AndroidJUnit4::class)
class SystemViewJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
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
    private fun waitDescription(label: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithContentDescription(label).fetchSemanticsNodes().isNotEmpty()
    }
    private fun openSystem() {
        waitDescription("Open the system view")
        compose.onNodeWithContentDescription("Open the system view").performScrollTo().performClick()
        waitDescription("Spatial atlas")
    }
    private fun assertNoWorldShown(worlds: List<WorldSummary>) {
        compose.onAllNodesWithContentDescription("Explore world:", substring = true).assertCountEquals(0)
        for (world in worlds) {
            compose.onAllNodesWithText(world.sourceTitle, substring = true).assertCountEquals(0)
            compose.onAllNodesWithContentDescription(world.sourceTitle, substring = true).assertCountEquals(0)
        }
    }
    @Test fun systemNamesNoSourceAcrossRecreationAndBack() = runBlocking {
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName))
        val worlds = ApiClient().getWorldSystem().system?.worlds.orEmpty()
        assertTrue("The seeded universe has reached at least one source", worlds.isNotEmpty())
        waitDescription("Open the system view")
        screenshot("atlas-ui.png")
        openSystem()
        assertNoWorldShown(worlds)
        screenshot("system-ui.png")
        compose.activityRule.scenario.recreate()
        waitDescription("Spatial atlas")
        assertNoWorldShown(worlds)
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitDescription("Open the system view")
        compose.onNodeWithText("Keep").performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Saved Traces. Tap any to reopen the verified original.").fetchSemanticsNodes().isNotEmpty() }
        screenshot("keep-ui.png")
        File(instrumentation.targetContext.filesDir, "system-ui-receipt.json").writeText(
            """{"result":"passed","worldsOnServer":${worlds.size},"sourceShown":false,"systemRecreated":true,"systemBackPreserved":true,"keepReached":true}"""
        )
    }
    @Test fun clearedSystemIsNotRestoredOnForeground() = runBlocking {
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName))
        openSystem()
        val api = ApiClient()
        val before = api.getUniverse()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        val cleared = api.clearScrollHistory(HistoryClearRequest(requestId = UUID.randomUUID().toString(), expectedPrivacyEpoch = before.privacyEpoch, universeId = before.universeId))
        assertTrue(cleared.privacyEpoch > before.privacyEpoch)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(15_000) {
            compose.onAllNodesWithText("Your universe").fetchSemanticsNodes().isNotEmpty() &&
                compose.onAllNodesWithContentDescription("Spatial atlas").fetchSemanticsNodes().isEmpty()
        }
        assertTrue(api.getWorldSystem().system == null)
        File(instrumentation.targetContext.filesDir, "system-privacy-receipt.json").writeText(
            """{"result":"passed","systemPurgedAfterPrivacyEpochChange":true,"serverSystemEmpty":true}"""
        )
    }
}
