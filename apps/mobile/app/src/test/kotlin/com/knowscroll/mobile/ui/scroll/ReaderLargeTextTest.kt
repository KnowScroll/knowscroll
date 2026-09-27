package com.knowscroll.mobile.ui.scroll

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #170: at the largest text size the reader's way back along a followed connection stays readable.
 * The origin chip and the back pill shared one row, so at 2.0× the pill was squeezed to "…".
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
// Real text measurement: the legacy graphics mode measures a character as one pixel wide.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReaderLargeTextTest {
    private val item = ScrollItem(
        "a1", 1, "Scroll", "A star is born from a cloud", "Gravity gathers a cloud into a star.",
        "Stars form when gravity collapses dense pockets of gas.", "Fixture source", "https://example.test/stars", "documented",
        "A connection you chose: Gravity explains Star formation.",
    )

    @Test
    fun theWayBackAlongAConnectionIsNotCutOffAtTheLargestText() = runComposeUiTest {
        val origin = ReaderOrigin.Branch("One force, many jobs", "Gravity explains Star formation", recorded = true)
        setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
                KnowScrollTheme {
                    ScrollScreen(state = ScrollState.Reading(item, "e1", "ev1", KeepState.Idle, 0, DiscoveryState.Idle, origin),
                        onKeep = {}, onReturn = {}, onNext = {}, onRetry = {}, onReadingPosition = { _, _ -> }, onOpenKeep = {})
                }
            }
        }
        val layouts = mutableListOf<TextLayoutResult>()
        onNodeWithText("← One force, many jobs").fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        val back = layouts.single()
        assertFalse("the back pill is cut to \"…\"", (0 until back.lineCount).any { back.isLineEllipsized(it) })
    }
}
