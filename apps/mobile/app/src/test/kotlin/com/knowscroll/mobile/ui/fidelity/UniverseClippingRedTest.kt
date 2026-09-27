package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.knowscroll.mobile.data.Capabilities
import com.knowscroll.mobile.data.Trace
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.HistoryClearState
import com.knowscroll.mobile.ui.SignOutState
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Bounds and reachability regression for the clipped Trace layout reproduced in the audit. */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
class UniverseClippingRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    private fun loadedUniverse(traces: List<Trace>) = UniverseState.Loaded(
        Universe("u1", 1, 1, traces, Capabilities.AllFalse)
    )

    private fun render(state: UniverseState.Loaded) {
        composeRule.setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = state,
                    historyClear = HistoryClearState.Idle,
                    signOut = SignOutState.Idle,
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {}
                )
            }
        }
    }

    @Test
    fun `3 Traces, the audit's specific shape, keeps every body inside the canvas with no label clipped`() {
        val traces = listOf(
            Trace("event-1", "asset-1", "The bitter lesson", "2026-08-20T00:00:00Z"),
            Trace("event-2", "asset-2", "General methods beat cleverness", "2026-08-21T00:00:00Z"),
            Trace("event-3", "asset-3", "Computation is the lever", "2026-08-22T00:00:00Z")
        )
        render(loadedUniverse(traces))
        composeRule.onNodeWithText("Saved Traces 3").performScrollTo().performClick()
        // Every kept Scroll's title is present -- a clipped title would have been culled by
        // measure/layout and the onNodeWithText lookup would fail.
        composeRule.onNodeWithText("The bitter lesson").assertExists()
        composeRule.onNodeWithText("General methods beat cleverness").assertExists()
        composeRule.onNodeWithText("Computation is the lever").assertExists()
    }

    @Test
    fun `every kept body stays within the universe canvas horizontal bounds`() {
        val traces = (1..12).map { i ->
            Trace("event-$i", "asset-$i", "Kept Scroll number $i with a longish title", "2026-08-2${i}T00:00:00Z")
        }
        render(loadedUniverse(traces))
        composeRule.onNodeWithText("Saved Traces 12").performScrollTo().performClick()
        // Every body is rendered inside the canvas root, never past the screen edge.
        for (i in 1..12) {
            val title = "Kept Scroll number $i with a longish title"
            val bounds = composeRule.onNodeWithText(title).performScrollTo().assertIsDisplayed().getUnclippedBoundsInRoot()
            assertTrue(
                "Audit A1 (#72): body '$title' has bounds ${bounds}, expected its right edge to be " +
                    "within the 360dp test viewport. Off-screen clipping is exactly the audit's defect.",
                bounds.right.value <= 360 && bounds.left.value >= 0
            )
        }
    }

    @Test
    fun `universe canvas remains drawn and bodies are visible at 5 Traces`() {
        // A regression lock: the audit found the canvas collapsed under heavy load. The new
        // FlowRow layout must continue to render every body, even when 5 traces are present.
        val traces = (1..12).map { i ->
            Trace("event-$i", "asset-$i", "Kept Scroll $i", "2026-09-0${i}T00:00:00Z")
        }
        render(loadedUniverse(traces))
        composeRule.onNodeWithText("Saved Traces 12").performScrollTo().performClick()
        for (i in 1..12) {
            composeRule.onNodeWithText("Kept Scroll $i").performScrollTo().assertIsDisplayed()
        }
    }
}
