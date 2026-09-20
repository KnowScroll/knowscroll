package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
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
 * docs/product/ui-system.md section 4b: "Bottom compass... ships with Home and Scroll" -- floating
 * navigation with a selected state, taken from Living Observatory's `.dock`. Nothing in
 * UniverseScreen.kt or ScrollScreen.kt renders one; the app switches full-screen between
 * `UniverseScreen` and `ScrollScreen` with no persistent navigation chrome at all.
 *
 * A plain text search for "Home" would find a false positive: ScrollScreen's reader already has a
 * "Home" button (return-to-universe), unrelated to a bottom compass. So this test looks for the
 * structural signature a tab-style compass entry would carry -- `Role.Tab` semantics -- which
 * nothing in the app sets today, on any screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BottomCompassRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun `universe screen has exactly two compass tabs, Home and Scroll`() {
        composeRule.setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = UniverseState.Loaded(Universe("u1", 1, 1, emptyList(), Capabilities.AllFalse)),
                    historyClear = HistoryClearState.Idle,
                    signOut = SignOutState.Idle,
                    onEnterScroll = {}, onOpenTrace = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {}
                )
            }
        }
        composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab))
            .assertCountEquals(2)
    }

    @Test
    fun `scroll screen has exactly two compass tabs, Home and Scroll`() {
        composeRule.setContent {
            KnowScrollTheme {
                com.knowscroll.mobile.ui.scroll.ScrollScreen(
                    state = com.knowscroll.mobile.ui.ScrollState.Idle,
                    onKeep = {}, onReturn = {}, onNext = {}, onRetry = {}, onReadingPosition = { _, _ -> }
                )
            }
        }
        composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab))
            .assertCountEquals(2)
    }
}
