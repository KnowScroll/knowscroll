package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.StateStore
import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LivingCableJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private val store
        get() = StateStore(instrumentation.targetContext)

    private fun waitFor(label: String) =
        compose.waitUntil(25_000) {
            compose.onAllNodesWithContentDescription(label).fetchSemanticsNodes().isNotEmpty()
        }

    private fun waitText(text: String) =
        compose.waitUntil(25_000) {
            compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }

    private fun capture(name: String) {
        compose.waitForIdle()
        val committed = java.util.concurrent.CountDownLatch(1)
        compose.activityRule.scenario.onActivity { activity ->
            activity.window.decorView.viewTreeObserver.registerFrameCommitCallback {
                committed.countDown()
            }
            activity.window.decorView.invalidate()
        }
        check(committed.await(10, java.util.concurrent.TimeUnit.SECONDS))
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(instrumentation.targetContext.filesDir, name).outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }

    @Test
    fun explicitModesAndOwnerAccessibleBranches() {
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName))
        try {
            waitFor("Enter Scroll")
            compose.onNodeWithContentDescription("Enter Scroll").performClick()
            waitFor("Scroll reading content")
            compose.waitUntil(20_000) { store.read()?.exposureId?.isNotBlank() == true }
            val original = store.read()!!
            compose.onNodeWithContentDescription("Scroll reading content").performTouchInput {
                swipeUp()
            }
            compose.waitUntil(5000) { store.read()!!.readingPosition > 0 }
            val position = store.read()!!.readingPosition
            compose.onNodeWithContentDescription("Cable Reel").performClick()
            waitFor("Reel video")
            compose.waitUntil(25_000) {
                store.read()?.item?.kind == "Reel" && store.read()?.exposureId?.isNotBlank() == true
            }
            val reel = store.read()!!
            // #167 (ADR-0043): the live Reel explains itself through the Scroll reader's why sheet,
            // with its recorded path, and never shows a source.
            compose.onNodeWithContentDescription("Why this Reel appeared").performClick()
            waitText("WHAT LED HERE")
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Reading what was recorded…").fetchSemanticsNodes().isEmpty()
            }
            for (source in listOf("Supplied demo library", "example.test")) {
                assertEquals(0, compose.onAllNodesWithText(source, substring = true).fetchSemanticsNodes().size)
            }
            capture("living-reel-why.png")
            compose.onNodeWithText("Back to reading").performScrollTo().performClick()
            waitFor("Reel video")
            compose.onNodeWithText("Pause").performClick()
            // Toggle while a horizontal drag is still in progress; the disposed player must
            // cancel its gesture without turning it into a discovery or exposure.
            compose.onNodeWithContentDescription("Reel video").performTouchInput {
                down(center)
                moveBy(androidx.compose.ui.geometry.Offset(40f, 0f))
            }
            compose.onNodeWithContentDescription("Cable Scroll").performSemanticsAction(
                androidx.compose.ui.semantics.SemanticsActions.OnClick
            ) {
                it()
            }
            compose.onRoot().performTouchInput { cancel() }
            waitFor("Scroll reading content")
            assertEquals(original.clientExposureId, store.read()!!.clientExposureId)
            assertTrue(store.read()!!.readingPosition >= position)
            repeat(3) {
                compose.onNodeWithContentDescription("Cable Reel").performClick()
                compose.onNodeWithContentDescription("Cable Scroll").performClick()
            }
            compose.onNodeWithContentDescription("Cable Reel").performClick()
            waitFor("Reel video")
            assertEquals(reel.clientExposureId, store.read()!!.clientExposureId)
            compose.onNodeWithText("Play", substring = false).assertExists()
            compose.activityRule.scenario.recreate()
            waitFor("Reel video")
            compose.onNodeWithContentDescription("Cable Reel").assertIsSelected()
            compose.onNodeWithContentDescription("Open authored interaction preview").performClick()
            waitFor("Preview Scroll reading")
            capture("living-scroll-top.png")
            val reading = compose.onNodeWithContentDescription("Preview Scroll reading")
            reading.performScrollToNode(hasContentDescription("Compare the two illustrations"))
            compose
                .onNodeWithContentDescription("Compare the two illustrations")
                .performTouchInput { swipeLeft() }
            compose.onNodeWithContentDescription("Preview Scroll reading").assertExists()
            reading.performTouchInput { swipeUp() }
            compose.waitUntil(5000) {
                reading.fetchSemanticsNode().config[SemanticsProperties.StateDescription] !=
                    "Position 0"
            }
            val before = reading.fetchSemanticsNode().config[SemanticsProperties.StateDescription]
            compose.onNodeWithText("Change speed →").performClick()
            waitText("What changes when speed changes?")
            instrumentation.uiAutomation.performGlobalAction(
                android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK
            )
            waitFor("Preview Scroll reading")
            assertEquals(
                before,
                compose
                    .onNodeWithContentDescription("Preview Scroll reading")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription],
            )
            capture("living-scroll.png")
            // Rail owns horizontal input; the document and its embedded blocks never branch.
            compose.onNodeWithContentDescription("Branch gesture rail").performTouchInput {
                swipeLeft()
            }
            waitText("What changes when speed changes?")
            compose.onNodeWithText("‹ Branch origin").performClick()
            compose
                .onNodeWithContentDescription("Preview Scroll reading")
                .performScrollToNode(hasText("Next preview discovery ↑"))
            compose.onNodeWithText("Next preview discovery ↑").performClick()
            waitText("What changes when speed changes?")
            compose.onNodeWithContentDescription("Cable Reel").performClick()
            waitFor("Reel video")
            compose.waitUntil(20_000) {
                compose
                    .onNodeWithContentDescription("Reel video")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription] == "Playing"
            }
            compose.onNodeWithText("SUPPLIED DEMO 1 / 3").assertExists()
            capture("living-reel.png")
            compose.onNodeWithContentDescription("Reel video").performTouchInput { swipeLeft() }
            waitText("SUPPLIED DEMO 2 / 3")
            waitText("‹ Branch origin")
            compose.onNodeWithText("‹ Branch origin").performClick()
            compose.onNodeWithContentDescription("Reel video").performTouchInput { swipeRight() }
            waitText("SUPPLIED DEMO 3 / 3")
            waitText("‹ Branch origin")
            instrumentation.uiAutomation.performGlobalAction(
                android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK
            )
            waitFor("Reel video")
            compose.onNodeWithContentDescription("Reel video").performTouchInput { swipeUp() }
            compose.onNodeWithText("Next ↑").performClick()
            compose.onNodeWithText("Previous ↓").performClick()
            // #161: a Reel offers no sources.
            compose.onAllNodesWithText("Sources", substring = true).assertCountEquals(0)
            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            waitFor("Reel video")
            compose.activityRule.scenario.recreate()
            waitFor("Reel video")
            compose.onNodeWithText("SUPPLIED DEMO 2 / 3").assertExists()
            compose.onNodeWithText("Close preview").performClick()
            waitFor("Reel video")
            assertEquals(reel.clientExposureId, store.read()!!.clientExposureId)
            assertEquals(reel.clientEventId, store.read()!!.clientEventId)
            File(instrumentation.targetContext.filesDir, "living-cable.json")
                .writeText(
                    JSONObject()
                        .put("modeRestoration", true)
                        .put("readingPositionRetained", true)
                        .put("exactRetryIdentityRetained", true)
                        .put("authoredPreview", true)
                        .put("liveBranches", false)
                        .put("liveReelWhy", true)
                        .put("horizontalBothDirections", true)
                        .put("toggleMidGesture", true)
                        .put("scrollReadingOwnsVertical", true)
                        .put("recreation", true)
                        .put("backgroundForeground", true)
                        .toString(2)
                )
        } catch (e: Throwable) {
            runCatching { capture("living-failure.png") }
            throw e
        }
    }
}
