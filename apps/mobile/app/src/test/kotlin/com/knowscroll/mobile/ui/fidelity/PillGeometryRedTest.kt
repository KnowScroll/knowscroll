package com.knowscroll.mobile.ui.fidelity

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.knowscroll.mobile.data.Capabilities
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.HistoryClearState
import com.knowscroll.mobile.ui.SignOutState
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.system.SystemScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

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
 *
 * `@GraphicsMode(NATIVE)` (#116 addition): the system-level tests below measure controls whose
 * size depends on real wrapped text. Under Robolectric's default (legacy) graphics mode, text
 * measures at a degenerate ~1dp per character -- confirmed directly: a bare `Text("plainA")`
 * measured 6dp x 36dp for six characters. NATIVE mode (Roborazzi/Robolectric's real rendering
 * path, already used by `ScreenshotEvidenceTest`/`TruthPillRedTest` for the same reason) gives real
 * font metrics. This is a test-environment property, not a production layout defect; the four
 * pre-existing tests above do not depend on text-width measurement (Material3's own fixed button
 * minimum, not glyph metrics) and are unaffected.
 */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
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

    /** Audit D1 (#72): displayLarge is now weight 800 (spec section 2: 700-800). The previous
     * Light weight is what the audit captured as the system reading like a different product. */
    @Test
    fun `displayLarge is weight 800 so headings read with the spec's Cosmos authority`() {
        var weight by mutableStateOf<FontWeight?>(null)
        composeRule.setContent {
            KnowScrollTheme {
                weight = MaterialTheme.typography.displayLarge.fontWeight
            }
        }
        composeRule.waitForIdle()
        assertEquals(
            "Audit D1 (#72): displayLarge must be weight 700-800 per docs/product/ui-system.md " +
                "section 2. Current value: $weight.",
            FontWeight(800), weight
        )
    }

    /** Audit D1 (#72): headlineMedium is now weight 700. */
    @Test
    fun `headlineMedium is weight 700 so section and system headings read with the spec's authority`() {
        var weight by mutableStateOf<FontWeight?>(null)
        composeRule.setContent {
            KnowScrollTheme {
                weight = MaterialTheme.typography.headlineMedium.fontWeight
            }
        }
        composeRule.waitForIdle()
        assertEquals(
            "Audit D1 (#72): headlineMedium must be weight 700 per docs/product/ui-system.md " +
                "section 2. Current value: $weight.",
            FontWeight(700), weight
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
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {}
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
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {}
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
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {}
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

    // #116: the system level's own entry point and controls.

    @Test
    fun `the SYSTEM VIEW control on the loaded universe screen is a real 48dp control that opens the system view`() {
        var opened = false
        composeRule.setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = UniverseState.Loaded(Universe("u1", 1, 1, emptyList(), Capabilities.AllFalse)),
                    historyClear = HistoryClearState.Idle,
                    signOut = SignOutState.Idle,
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = { opened = true }, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {}
                )
            }
        }
        val node = composeRule.onNodeWithContentDescription("Open the system view")
        val bounds = node.getUnclippedBoundsInRoot()
        val height = bounds.bottom - bounds.top
        assertTrue(
            "docs/product/ui-system.md section 4b: touch targets are at least 48dp. Measured $height.",
            height >= 48.dp
        )
        // The universe screen's content column scrolls (UniverseCanvasScreen.kt); the control sits
        // near the bottom of the 340dp canvas and can start outside the small default Robolectric
        // window's visible bounds, so it must be scrolled into view before a synthetic click will
        // actually land, the same way a real touch would need it on-screen first.
        node.performScrollTo().performClick()
        assertTrue("Tapping the SYSTEM VIEW control must actually invoke onEnterSystem, not just look clickable.", opened)
    }

    @Test
    fun `retry pill on the unavailable system screen is at least 48dp tall`() {
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = SystemState.Unavailable("offline"),
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }
        val bounds = composeRule.onNodeWithContentDescription("Retry loading the system")
            .getUnclippedBoundsInRoot()
        val height = bounds.bottom - bounds.top
        assertTrue(
            "docs/product/ui-system.md section 4b: touch targets are at least 48dp. Measured $height.",
            height >= 48.dp
        )
    }

    @Test
    fun `back pill on the system screen is at least 48dp tall and returns to Universe`() {
        var returned = false
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = SystemState.Idle,
                    onReturn = { returned = true }, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }
        val node = composeRule.onNodeWithContentDescription("Return to Universe")
        val bounds = node.getUnclippedBoundsInRoot()
        val height = bounds.bottom - bounds.top
        assertTrue(
            "docs/product/ui-system.md section 4b: touch targets are at least 48dp. Measured $height.",
            height >= 48.dp
        )
        node.performClick()
        assertTrue("The back pill must actually invoke onReturn.", returned)
    }
}
