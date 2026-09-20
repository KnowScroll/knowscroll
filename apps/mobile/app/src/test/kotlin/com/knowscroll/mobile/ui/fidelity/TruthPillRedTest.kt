package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.scroll.ScrollScreen
import com.knowscroll.mobile.ui.theme.Cosmos
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * docs/product/ui-system.md section 5: "Each [truth] state has one pill, always adjacent to the
 * claim it qualifies... A compelling presentation may never upgrade a weak claim, so the pill is
 * drawn with equal weight regardless of state" -- which requires the seven states to actually be
 * *visually distinguishable* from one another, or the pill carries no information at all. The
 * issue's own framing: "today they render as identical plain grey text."
 *
 * ScrollScreen.kt's reading sheet draws the truth state as
 * `Text(stringResource(R.string.reader_truth_label, item.truthState.uppercase()),
 * color = Cosmos.MutedOnCream)` unconditionally -- no branch on `truthState` at all. The first
 * test below pins the current absence of any machine-readable truth-pill identity (no
 * contentDescription names it, so assistive tech gets only "SCROLL · DOCUMENTED" as body text,
 * indistinguishable from any other label). The second test proves the visual claim directly, by
 * rendering all seven states, capturing a real rasterized screenshot of each (Roborazzi, native
 * graphics, no emulator), cropping to the truth label's own measured bounds, and finding each
 * crop's dominant non-background ("ink") colour. Comparing words rather than colours would be the
 * wrong test here -- the seven state names are different strings by construction, so their glyphs
 * always differ; what must differ, and today does not, is the *colour* applied to whichever word
 * is drawn.
 */
@OptIn(ExperimentalTestApi::class, ExperimentalComposeUiApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class TruthPillRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val truthStates = listOf(
        "documented", "synthesis", "interpretation", "disputed", "modelled", "counterfactual", "fictional"
    )

    private fun readingState(truthState: String) = ScrollState.Reading(
        item = ScrollItem(
            assetId = "asset-$truthState", revision = 1, kind = "scroll",
            title = "A claim worth reading", summary = "One line of context.",
            body = "The body of the Scroll.", sourceTitle = "A source",
            sourceUrl = "https://example.invalid/source", truthState = truthState, reason = ""
        ),
        exposureId = "exposure-1", eventId = "event-1", keep = KeepState.Idle, readingPosition = 0,
        discovery = DiscoveryState.Idle, origin = ReaderOrigin.Discovery
    )

    @Test
    fun `truth pill has no machine-readable identity today`() {
        composeRule.setContent {
            KnowScrollTheme {
                ScrollScreen(
                    state = readingState("disputed"), onKeep = {}, onReturn = {}, onNext = {},
                    onRetry = {}, onReadingPosition = { _, _ -> }
                )
            }
        }
        composeRule.waitForIdle()
        // Documented contract this pins: a real truth pill should be reachable independently of
        // its label text, e.g. by a contentDescription such as "Truth state: disputed" (spec
        // section 5/12), so assistive tech and tests do not depend on the exact rendered string.
        // No such node exists today -- ScrollScreen.kt's truth Text carries no semantics of its
        // own beyond the text itself -- so this assertion is expected to fail with Compose's own
        // "failed to find" error until one is added.
        composeRule.onNodeWithContentDescription("Truth state: disputed").assertExists()
    }

    @Test
    fun `seven truth states are not visually distinguishable today`() {
        val background = Cosmos.Cream.toArgb()
        val inkColors = truthStates.associateWith { truthState ->
            var color: Int? = null
            runComposeUiTest {
                setContent {
                    KnowScrollTheme {
                        ScrollScreen(
                            state = readingState(truthState), onKeep = {}, onReturn = {}, onNext = {},
                            onRetry = {}, onReadingPosition = { _, _ -> }
                        )
                    }
                }
                waitForIdle()
                val label = "SCROLL · ${truthState.uppercase()}"
                val bitmap = onNodeWithText(label).captureToImage().asAndroidBitmap()
                // captureToImage() on the node itself is already cropped to its own bounds, so
                // sample against (0,0)-(width,height) of that bitmap rather than root coordinates.
                val localRect = IntRectPx(0, 0, bitmap.width, bitmap.height)
                color = bitmap.dominantInkColor(localRect, background)
            }
            color
        }
        val distinctColors = inkColors.values.filterNotNull().toSet()
        assertTrue(
            "docs/product/ui-system.md section 5: the seven truth states must be visually " +
                "distinguishable. Rendered and rasterized (Roborazzi, no emulator), their " +
                "dominant label-ink colours today are: " +
                inkColors.mapValues { (_, c) -> c?.let { "#%08X".format(it) } } + ". " +
                "Expected at least 4 distinct colours across 7 states; found ${distinctColors.size} " +
                "-- ScrollScreen.kt draws every truth label with the same unconditional " +
                "color = Cosmos.MutedOnCream.",
            distinctColors.size >= 4
        )
    }
}
