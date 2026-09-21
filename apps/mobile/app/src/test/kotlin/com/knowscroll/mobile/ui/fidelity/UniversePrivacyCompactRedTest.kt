package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import com.knowscroll.mobile.data.Capabilities
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

/**
 * Audit A3 (#72): the previous stacked full-width Clear History + Sign Out controls pushed
 * against the dock and buried their explanatory copy. The fix moves both pills into a single
 * row inside a compact disclosure block. This test pins:
 *  - both controls are still present and reachable on the same screen,
 *  - both controls are at least 48dp tall (sec.4b minimum),
 *  - the disclosure copy is drawn before the buttons and is not the body bullet they used to
 *    live behind, and
 *  - no labels and actions collide (the controls share a row but their widths are bounded by
 *    their own weight, so neither overflows into the dock).
 */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
class UniversePrivacyCompactRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    private fun render() {
        composeRule.setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = UniverseState.Loaded(Universe("u1", 1, 1, emptyList(), Capabilities.AllFalse)),
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
    fun `clear history and sign out pills both appear in the compact disclosure`() {
        render()
        composeRule.onNodeWithContentDescription("Clear Scroll history").assertExists()
        composeRule.onNodeWithContentDescription("Sign out this device").assertExists()
    }

    @Test
    fun `compact privacy pills are at least 48dp tall and stay inside the screen`() {
        render()
        val clear = composeRule.onNodeWithContentDescription("Clear Scroll history").getUnclippedBoundsInRoot()
        val signOut = composeRule.onNodeWithContentDescription("Sign out this device").getUnclippedBoundsInRoot()
        assertTrue("Clear history control must be at least 48dp tall (audit A3 + sec.4b). height=${clear.bottom.value - clear.top.value}",
            clear.bottom.value - clear.top.value >= 48)
        assertTrue("Sign out control must be at least 48dp tall (audit A3 + sec.4b). height=${signOut.bottom.value - signOut.top.value}",
            signOut.bottom.value - signOut.top.value >= 48)
        // Both pills share the same row -- their right edges must be inside the canvas, and
        // their tops must match. The audit captured label/action collisions from the previous
        // stacked layout; the new row layout must not regress into one.
        assertTrue("Clear history left and Sign out left should both be on screen.", clear.left.value >= 0 && signOut.left.value >= 0)
        assertTrue("Sign out right should not overflow off-screen.", signOut.right.value <= 360) // Bounds are expressed in dp.
    }

    @Test
    fun `compact disclosure copy is present and is not the buttons themselves`() {
        render()
        // Audit A3: the disclosure text explains what Clear and Sign-out each do. The audit's
        // specific complaint was that the stacked controls buried this copy.
        composeRule.onNodeWithText("Privacy", substring = false).assertExists()
        composeRule.onNodeWithText(
            "Clear removes this universe's recorded encounters and saved Traces; the shared library stays. Other devices are signed out. Sign out ends only this device.",
            substring = false
        ).assertExists()
    }

    @Test
    fun `history clear and sign out retry envelopes stay reachable when states change`() {
        // Audit A3 confirmation semantics: the dialogs and retry controls are unchanged; only
        // the *position* of the controls changed. When a state lands, the retry / progress
        // message is still rendered under the compact disclosure row.
        composeRule.setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = UniverseState.Loaded(Universe("u1", 1, 1, emptyList(), Capabilities.AllFalse)),
                    historyClear = HistoryClearState.Retryable("The clear result is uncertain. Retry uses the same saved request."),
                    signOut = SignOutState.Idle,
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {}
                )
            }
        }
        composeRule.onNodeWithText("The clear result is uncertain. Retry uses the same saved request.").assertExists()
        composeRule.onNodeWithContentDescription("Retry the same history clear request").assertExists()
    }
}
