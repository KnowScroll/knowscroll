package com.knowscroll.mobile

import android.graphics.Bitmap
import android.os.Handler
import android.os.HandlerThread
import android.view.FrameMetrics
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.StateStore
import java.io.File
import java.util.Collections
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeSpatialJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private fun store() = StateStore(instrumentation.targetContext)

    private fun waitDescription(label: String) =
        compose.waitUntil(20_000) {
            compose.onAllNodesWithContentDescription(label).fetchSemanticsNodes().isNotEmpty()
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

    private val worlds =
        SemanticsMatcher("world") {
            it.config
                .getOrElse(SemanticsProperties.ContentDescription) { emptyList() }
                .any { label -> label.startsWith("Explore world: ") }
        }

    @Test
    fun worldToRealReelAndBack() {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey")
        val frames = Collections.synchronizedList(mutableListOf<Long>())
        val thread = HandlerThread("native-frame-metrics").apply { start() }
        val listener =
            android.view.Window.OnFrameMetricsAvailableListener { _, metrics, _ ->
                frames.add(metrics.getMetric(FrameMetrics.TOTAL_DURATION))
            }
        compose.activityRule.scenario.onActivity {
            it.window.addOnFrameMetricsAvailableListener(listener, Handler(thread.looper))
        }
        try {
            waitDescription("Enter Scroll")
            compose.onNodeWithContentDescription("Enter Scroll").performClick()
            compose.waitUntil(20_000) { store().read() != null }
            if (store().read()!!.item.kind == "Reel") {
                waitDescription("Reel video")
                compose.waitUntil(20_000) { store().read()?.exposureId?.isNotBlank() == true }
                compose.onNodeWithText("Next ↑").performClick()
            }
            waitDescription("Scroll reading content")
            compose.waitUntil(20_000) { store().read()?.exposureId?.isNotBlank() == true }
            val originTitle = store().read()!!.item.sourceTitle
            compose.onNodeWithContentDescription("Return to the universe").performClick()
            waitDescription("Open the system view")
            compose
                .onNodeWithContentDescription("Open the system view")
                .performScrollTo()
                .performClick()
            waitDescription("Spatial atlas")
            compose.onNodeWithContentDescription("Spatial atlas").performTouchInput {
                val delta = androidx.compose.ui.geometry.Offset(50f, 0f)
                pinch(center - delta, center - delta * 2f, center + delta, center + delta * 2f, 400)
            }
            compose.onNodeWithContentDescription("Spatial atlas").performTouchInput {
                swipe(center, center + androidx.compose.ui.geometry.Offset(-60f, 40f), 300)
            }
            compose.onNodeWithContentDescription("Zoom in").performClick()
            compose.waitForIdle()
            capture("spatial-map.png")
            val camera =
                compose
                    .onNodeWithContentDescription("Spatial atlas")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription]
            // The accessible list works even after the user pans a world off-screen.
            compose.onNodeWithText("Worlds", substring = true).performClick()
            compose.onNodeWithText(originTitle).performClick()
            waitDescription("Close world detail and return to the system")
            capture("spatial-world.png")
            compose.onNodeWithText("Open discovery").performScrollTo().performClick()
            waitDescription("Scroll reading content")
            var attempts = 0
            while (store().read()?.item?.kind != "Reel" && attempts++ < 8) {
                val previous = store().read()!!.item.assetId
                compose
                    .onNodeWithContentDescription("Scroll reading content")
                    .performScrollToNode(hasContentDescription("Get the next Scroll"))
                compose.onNodeWithContentDescription("Get the next Scroll").performClick()
                compose.waitUntil(20_000) { store().read()?.item?.assetId != previous }
            }
            assertEquals("Reel", store().read()!!.item.kind)
            waitDescription("Reel video")
            compose.waitUntil(20_000) { store().read()?.exposureId?.isNotBlank() == true }
            val exposed = store().read()!!.clientExposureId
            capture("real-reel.png")
            compose.onNodeWithText("Pause").performClick()
            compose.onNodeWithText("Play").assertExists()
            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            waitDescription("Reel video")
            compose.waitUntil(20_000) {
                compose.onAllNodesWithText("Play").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("Play").performClick()
            assertEquals(exposed, store().read()!!.clientExposureId)
            compose.onNodeWithText("Sources & truth").performClick()
            compose.onNodeWithText("Sources and truth").assertExists()
            compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            waitDescription("Reel video")
            compose.onNodeWithText("Continue →").performClick()
            compose.onNodeWithText("Back to Reel").performClick()
            waitDescription("Reel video")
            // Actual vertical discovery leaves video; it never creates a horizontal branch.
            compose.onNodeWithContentDescription("Reel video").performTouchInput {
                swipeUp(durationMillis = 300)
            }
            compose.waitUntil(20_000) {
                store().read()?.item?.kind == "Scroll" ||
                    compose
                        .onAllNodesWithText("You have reached the end of this library.")
                        .fetchSemanticsNodes()
                        .isNotEmpty()
            }
            val verticalOutcome =
                if (store().read()?.item?.kind == "Scroll") "next-scroll" else "library-exhausted"
            if (verticalOutcome == "next-scroll") {
                waitDescription("Scroll reading content")
                compose.onNodeWithContentDescription("Return to the universe").performClick()
            } else compose.onNodeWithText("‹ Return to origin").performClick()
            waitDescription("Close world detail and return to the system")
            compose
                .onNodeWithContentDescription("Close world detail and return to the system")
                .performClick()
            waitDescription("Spatial atlas")
            compose.waitUntil(10_000) {
                compose
                    .onNodeWithContentDescription("Spatial atlas")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription] == camera
            }
            capture("spatial-return.png")
            // Exhaustion is real. Starting another voyage clears only the local visited set,
            // after which a vertical swipe must reach a different real Scroll.
            if (verticalOutcome == "library-exhausted") {
                compose.onNodeWithContentDescription("Return to Universe").performClick()
                waitDescription("Enter Scroll")
                compose.onNodeWithContentDescription("Enter Scroll").performClick()
                waitDescription("Reel video")
                compose.onNodeWithText("‹ Return to origin").performClick()
                waitDescription("Enter Scroll")
                compose.onNodeWithContentDescription("Enter Scroll").performClick()
                waitDescription("Reel video")
                compose.onNodeWithContentDescription("Reel video").performTouchInput {
                    swipeUp(durationMillis = 300)
                }
                compose.waitUntil(20_000) { store().read()?.item?.kind == "Scroll" }
                waitDescription("Scroll reading content")
            }

            val memory = android.os.Debug.MemoryInfo().also { android.os.Debug.getMemoryInfo(it) }
            val samples = synchronized(frames) { frames.toList().sorted() }
            File(instrumentation.targetContext.filesDir, "native-journey.json")
                .writeText(
                    JSONObject()
                        .put("totalPssKb", memory.totalPss)
                        .put("result", "passed")
                        .put("nextScrollVerified", true)
                        .put("verticalDiscoveryOutcome", verticalOutcome)
                        .put("pausedAcrossAuthorityRecheck", true)
                        .put("realVideoRendered", true)
                        .put("originCameraRestored", true)
                        .put("frameCount", samples.size)
                        .put("p50Ms", samples[samples.size / 2] / 1e6)
                        .put("p95Ms", samples[(samples.size * .95).toInt()] / 1e6)
                        .put("over16_67ms", samples.count { it > 16_666_667 })
                        .put("build", "debug API36 emulator")
                        .put("liveBranchIntegration", false)
                        .toString(2)
                )
        } catch (error: Throwable) {
            runCatching { capture("native-failure.png") }
            runCatching { compose.onAllNodes(isRoot())[0].printToLog("NativeFailure") }
            throw error
        } finally {
            compose.activityRule.scenario.onActivity {
                it.window.removeOnFrameMetricsAvailableListener(listener)
            }
            thread.quitSafely()
        }
    }
}
