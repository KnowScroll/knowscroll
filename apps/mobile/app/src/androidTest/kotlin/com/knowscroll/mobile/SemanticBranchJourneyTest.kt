package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsProperties
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
 * #131/#134 — the first live semantic journey on a real emulator against a disposable API,
 * worker and PostgreSQL loaded with the editorial substrate (scripts/android-semantic-journey.py).
 *
 * A reader reaches, by ordinary deliberate discovery, a Scroll with live continuations; inspects
 * why it connects (mechanism, limits, cited evidence); follows one; survives recreation on the
 * target; returns with system Back to the origin at its exact reading position; and hides the
 * connection for themselves. The runner then verifies the causal lineage in the database.
 */
@RunWith(AndroidJUnit4::class)
class SemanticBranchJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)
    private val emptyReasons = listOf(
        "This Scroll has not been mapped", "No sourced connection leads on", "A connection exists, but no Scroll", "No sourced connection is available",
    )

    private fun screenshot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun waitReadingExposed(assetId: String? = null) = compose.waitUntil(20_000) {
        val s = store().read()
        s != null && s.exposureId.isNotEmpty() && (assetId == null || s.item.assetId == assetId) &&
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
    }

    private fun textShown(text: String, substring: Boolean = false): Boolean =
        compose.onAllNodes(hasText(text, substring = substring), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    /** Continuations settled: either the rail offers some (and the "why" action), or it says why not. */
    private fun waitBranchesSettled(): Boolean {
        compose.waitUntil(20_000) { textShown("Why these connections?") || emptyReasons.any { textShown(it, substring = true) } }
        return textShown("Why these connections?")
    }

    @Test
    fun followsASourcedConnectionInspectsItReturnsExactlyAndHidesIt() {
        try { journey() } catch (failure: Throwable) { runCatching { screenshot("semantic-failure.png") }; throw failure }
    }

    private fun journey() {
        check(instrumentation.targetContext.packageName.startsWith("com.knowscroll.mobile.journey")) { "Semantic journey requires the separate journey app" }
        compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        waitReadingExposed()

        // Ordinary deliberate discovery until an encounter has live continuations.
        val skipped = mutableListOf<String>()
        var connected = waitBranchesSettled()
        while (!connected && skipped.size < 24) {
            val current = store().read()!!.item.assetId
            skipped += current
            compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasContentDescription("Get the next Scroll"))
            compose.onNodeWithContentDescription("Get the next Scroll").performClick()
            compose.waitUntil(20_000) { store().read()?.item?.assetId?.let { it != current } == true }
            waitReadingExposed()
            connected = waitBranchesSettled()
        }
        assertTrue("no encounter with live continuations was reached", connected)
        val origin = store().read()!!

        // Read into the origin so the return can be checked against a real position.
        compose.onNodeWithContentDescription("Scroll reading content").performTouchInput { swipeUp() }
        compose.waitUntil(10_000) { (store().read()?.readingPosition ?: 0) > 0 }
        Thread.sleep(400)
        assertTrue(store().read()!!.readingPosition > 0)

        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText("Why these connections?"))
        compose.onNodeWithText("Why these connections?").performClick()
        compose.waitUntil(10_000) { textShown("How these connect") }
        for (heading in listOf("The connection", "Where it stops", "Evidence")) assertTrue(heading, textShown(heading))
        screenshot("semantic-connections.png")

        compose.waitForIdle()
        // Exact return means where the reader was when they branched (the rail), not an earlier point.
        val originPosition = store().read()!!.readingPosition
        assertTrue(originPosition > 0)
        compose.onAllNodesWithText("Follow this connection")[0].performScrollTo().performClick()
        compose.waitUntil(20_000) { store().read()?.branchFrom != null && store().read()?.exposureId?.isNotEmpty() == true }
        val target = store().read()!!
        assertEquals(origin.item.assetId, target.branchFrom!!.fromAssetId)
        assertNotEquals(origin.item.assetId, target.item.assetId)
        compose.waitUntil(10_000) { textShown("FOLLOWED A CONNECTION") }
        compose.onNodeWithContentDescription("Back to ${origin.item.title}").assertExists()
        screenshot("semantic-branch-target.png")

        // Recreation keeps the target, its origin and the way back.
        compose.activityRule.scenario.recreate()
        waitReadingExposed(target.item.assetId)
        compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("Back to ${origin.item.title}").fetchSemanticsNodes().isNotEmpty() }

        // System Back returns to the origin at its exact reading position.
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(15_000) { store().read()?.item?.assetId == origin.item.assetId }
        waitReadingExposed(origin.item.assetId)
        assertEquals(originPosition, store().read()!!.readingPosition)
        // …and the screen itself is back at that position, not merely the stored number.
        val expectedDescription = instrumentation.targetContext.getString(R.string.reader_position_description, originPosition)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes()
                .any { it.config.getOrElseNullable(SemanticsProperties.StateDescription) { null } == expectedDescription }
        }
        assertEquals(origin.exposureId, store().read()!!.exposureId)
        assertNull(store().read()!!.branchFrom)
        screenshot("semantic-branch-return.png")

        // Hide the connection for this reader: it disappears from the rail, sources unchanged.
        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText("Why these connections?"))
        compose.onNodeWithText("Why these connections?").performClick()
        compose.waitUntil(10_000) { textShown("How these connect") }
        val offered = compose.onAllNodesWithText("Follow this connection").fetchSemanticsNodes().size
        compose.waitForIdle()
        compose.onAllNodesWithText("Seems wrong")[0].performScrollTo().performClick()
        // Settled: the sheet has closed on the refreshed list, and the rail again either offers fewer
        // connections or says why it offers none — never a transient loading state.
        compose.waitUntil(15_000) {
            !textShown("How these connect") && !textShown("Finding a continuation…") &&
                (emptyReasons.any { textShown(it, substring = true) } || textShown("Why these connections?"))
        }
        val remainingAfter = if (textShown("Why these connections?")) {
            compose.onNodeWithText("Why these connections?").performClick()
            compose.waitUntil(10_000) { textShown("How these connect") }
            compose.onAllNodesWithText("Follow this connection").fetchSemanticsNodes().size.also {
                compose.activityRule.scenario.onActivity { a -> a.onBackPressedDispatcher.onBackPressed() }
                compose.waitUntil(10_000) { !textShown("How these connect") }
            }
        } else 0
        assertTrue("the hidden connection is no longer offered ($offered -> $remainingAfter)", remainingAfter < offered)
        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText("Continue this idea →"))
        screenshot("semantic-hidden.png")

        File(instrumentation.targetContext.filesDir, "semantic-branch.json").writeText(JSONObject().apply {
            put("originAssetId", origin.item.assetId); put("originTitle", origin.item.title)
            put("originExposureId", origin.exposureId); put("originPosition", originPosition)
            put("targetAssetId", target.item.assetId); put("targetTitle", target.item.title)
            put("branchDecisionId", target.decisionId); put("targetExposureId", target.exposureId)
            put("bridgeId", target.branchFrom!!.bridgeId); put("recorded", target.branchFrom!!.recorded)
            put("relationSentence", target.branchFrom!!.relationSentence)
            put("skippedBeforeConnected", skipped.size); put("offeredAtObjection", offered); put("offeredAfterObjection", remainingAfter)
        }.toString(2))
    }
}
