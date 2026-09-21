package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.knowscroll.mobile.data.Capabilities
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.HistoryClearState
import com.knowscroll.mobile.ui.SignOutState
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * docs/product/ui-system.md section 5b: the dock's real destinations are "**Cable** (read),
 * **Atlas** (universe), **Keep** (Traces) are real" -- the same three names the web build (#110)
 * shipped, which section 4b's own earlier draft (written before this client had a Keep contract)
 * had shipped as two placeholders, "Home"/"Scroll".
 *
 * A plain text search for "Home"/"Scroll" would have found a false positive even before this
 * rename: ScrollScreen's reader already has a "Home" button (return-to-universe), unrelated to a
 * bottom compass. So this test looks for the structural signature a tab-style compass entry
 * carries -- `Role.Tab` semantics -- and confirms the three real labels are the ones drawn.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BottomCompassRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun `universe screen has exactly three compass tabs, Atlas Cable and Keep`() {
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
        composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab))
            .assertCountEquals(3)
        composeRule.onNodeWithText("Atlas").assertExists()
        composeRule.onNodeWithText("Cable").assertExists()
        composeRule.onNodeWithText("Keep").assertExists()
    }

    @Test
    fun `scroll screen has exactly three compass tabs, Atlas Cable and Keep`() {
        composeRule.setContent {
            KnowScrollTheme {
                com.knowscroll.mobile.ui.scroll.ScrollScreen(
                    state = com.knowscroll.mobile.ui.ScrollState.Idle,
                    onKeep = {}, onReturn = {}, onNext = {}, onRetry = {}, onReadingPosition = { _, _ -> },
                    onOpenKeep = {}
                )
            }
        }
        composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab))
            .assertCountEquals(3)
        composeRule.onNodeWithText("Atlas").assertExists()
        composeRule.onNodeWithText("Cable").assertExists()
        composeRule.onNodeWithText("Keep").assertExists()
    }

    @Test
    fun `system screen has exactly three compass tabs, Atlas Cable and Keep`() {
        // #116: System has no dock entry of its own (sec.4b/5b name exactly Atlas/Cable/Keep) --
        // it marks Atlas, the level it is reached from and returns to.
        composeRule.setContent {
            KnowScrollTheme {
                com.knowscroll.mobile.ui.system.SystemScreen(
                    state = com.knowscroll.mobile.ui.SystemState.Idle,
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }
        composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab))
            .assertCountEquals(3)
        composeRule.onNodeWithText("Atlas").assertExists()
        composeRule.onNodeWithText("Cable").assertExists()
        composeRule.onNodeWithText("Keep").assertExists()
    }
}
