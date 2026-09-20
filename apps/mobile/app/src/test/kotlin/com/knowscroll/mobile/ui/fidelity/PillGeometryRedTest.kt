package com.knowscroll.mobile.ui.fidelity

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.knowscroll.mobile.data.Capabilities
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.HistoryClearState
import com.knowscroll.mobile.ui.SignOutState
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * docs/product/ui-system.md sections 3 and 4b: "Pills for every control" at weight 800 / 13px,
 * and "touch targets are at least 48dp" (the Android platform minimum, which overrides the
 * 40px/height:40px pill CSS inherits from Cosmos).
 *
 * Uses `createComposeRule()` measured bounds rather than pixel inspection, per the issue's
 * fallback guidance -- exact height and text style are answered directly by Compose's own layout
 * and theming APIs, with no need to rasterize anything.
 *
 * The typography test is RED against the unmodified UI: `MaterialTheme.typography.labelLarge`
 * (Theme.kt) is SemiBold/14sp, not 800/13sp. The three height tests were written expecting the
 * same result, since none of the three buttons has an explicit `heightIn(min = 48.dp)` in source
 * -- but measured, they are already 51dp today. The pinned Material3 BOM (2026.09.00) raised
 * `ButtonDefaults`' own default minimum height past 40dp, ahead of this being asserted anywhere in
 * this codebase. Recorded honestly rather than dropped (per the issue): these three do **not**
 * discriminate against the current scaffold. They are kept as a regression lock -- a restyle that
 * shrinks these controls back under 48dp, e.g. by fixing a literal height instead of a minimum,
 * will still be caught here.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PillGeometryRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun `pill label typography is weight 800 at 13sp`() {
        var weight by mutableStateOf<FontWeight?>(null)
        var size by mutableStateOf(0.sp)
        composeRule.setContent {
            KnowScrollTheme {
                val style = MaterialTheme.typography.labelLarge
                weight = style.fontWeight
                size = style.fontSize
            }
        }
        composeRule.waitForIdle()
        assertEquals(
            "Cosmos spec: every pill's label is weight 800 (ui-system.md section 3). " +
                "MaterialTheme.typography.labelLarge (what Button/OutlinedButton draw their " +
                "label with) is currently ${weight}.",
            FontWeight(800),
            weight
        )
        assertEquals(
            "Cosmos spec: every pill's label is 13sp (ui-system.md section 3). " +
                "MaterialTheme.typography.labelLarge is currently $size.",
            13.sp,
            size
        )
    }

    @Test
    fun `retry pill on the unavailable universe screen is at least 48dp tall`() {
        composeRule.setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = UniverseState.Unavailable("offline"),
                    historyClear = HistoryClearState.Idle,
                    signOut = SignOutState.Idle,
                    onEnterScroll = {}, onOpenTrace = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {}
                )
            }
        }
        val bounds = composeRule.onNodeWithContentDescription("Retry loading the universe")
            .getUnclippedBoundsInRoot()
        val height = bounds.bottom - bounds.top
        assertTrue(
            "docs/product/ui-system.md section 4b: touch targets are at least 48dp. The Retry " +
                "control on Universe.Unavailable has no explicit heightIn(min = 48.dp) in source, " +
                "but Material3's own default already clears it (measured $height). Not currently " +
                "red; kept as a regression lock in case a future literal height undoes that.",
            height >= 48.dp
        )
    }

    @Test
    fun `enter scroll pill on the loaded universe screen is at least 48dp tall`() {
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
        val bounds = composeRule.onNodeWithContentDescription("Enter Scroll")
            .getUnclippedBoundsInRoot()
        val height = bounds.bottom - bounds.top
        assertTrue(
            "docs/product/ui-system.md section 4b: touch targets are at least 48dp. 'Enter " +
                "Scroll' has no explicit heightIn(min = 48.dp) in source, but Material3's own " +
                "default already clears it (measured $height). Not currently red; kept as a " +
                "regression lock in case a future literal height undoes that.",
            height >= 48.dp
        )
    }

    @Test
    fun `clear history pill on the loaded universe screen is at least 48dp tall`() {
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
        val bounds = composeRule.onNodeWithContentDescription("Clear Scroll history")
            .getUnclippedBoundsInRoot()
        val height = bounds.bottom - bounds.top
        assertTrue(
            "docs/product/ui-system.md section 4b: touch targets are at least 48dp. 'Clear " +
                "Scroll history' has no explicit heightIn(min = 48.dp) in source, but Material3's " +
                "own default already clears it (measured $height). Not currently red; kept as a " +
                "regression lock in case a future literal height undoes that.",
            height >= 48.dp
        )
    }
}
