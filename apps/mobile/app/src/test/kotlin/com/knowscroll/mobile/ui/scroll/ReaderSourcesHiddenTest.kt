package com.knowscroll.mobile.ui.scroll

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.knowscroll.mobile.data.BranchEvidence
import com.knowscroll.mobile.data.BranchLimitation
import com.knowscroll.mobile.data.LiveBranch
import com.knowscroll.mobile.data.ReelMedia
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.assertNoSourceShown
import com.knowscroll.mobile.ui.reel.ReelScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #161: the reader's surfaces show the Scroll, its truth state and each claim -- never a source. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
class ReaderSourcesHiddenTest {
    private val sourceTitle = "NASA · Orbits and Kepler’s Laws"
    private val sourceUrl = "https://science.nasa.gov/solar-system/orbits-and-keplers-laws/"
    private val item = ScrollItem(
        "a1", 1, "Scroll", "Why an orbit keeps falling", "Sideways speed and a steady pull.",
        "An orbit is a fall that keeps missing the ground.", sourceTitle, sourceUrl, "documented", "Opened from your universe.",
    )

    private fun reading(item: ScrollItem) =
        ScrollState.Reading(item, "e1", "ev1", KeepState.Idle, 0, DiscoveryState.Idle, ReaderOrigin.Discovery)

    @Test
    fun theReaderShowsTheScrollButNeverItsSource() = runComposeUiTest {
        setContent {
            KnowScrollTheme {
                ScrollScreen(state = reading(item), onKeep = {}, onReturn = {}, onNext = {}, onRetry = {}, onReadingPosition = { _, _ -> }, onOpenKeep = {})
            }
        }
        onNodeWithText(item.title).assertExists()
        onNodeWithText(item.body).assertExists()
        assertNoSourceShown(sourceTitle, sourceUrl)
    }

    @Test
    fun theWhySheetShowsTheTruthStateButNeverASource() = runComposeUiTest {
        val origin = ReaderOrigin.Branch("Gravity pulls", "Gravity explains Orbits", recorded = true)
        setContent { KnowScrollTheme { ExplainSheet(item, origin, null, {}) {} } }
        onNodeWithText("DOCUMENTED").performScrollTo()
        assertNoSourceShown(sourceTitle, sourceUrl)
    }

    @Test
    fun theConnectionsSheetShowsEachClaimButNeverWhereItCameFrom() = runComposeUiTest {
        val claim = BranchEvidence("The Sun's gravity bends each planet's path toward it.", "mechanism", "NASA · Our Sun: Facts", "https://science.nasa.gov/sun/facts/")
        val branch = LiveBranch(
            "b1", "br1", "explains", "forward", "explains", "Gravity", "Orbits", "Gravity bends a path that would otherwise run straight.",
            listOf(BranchLimitation("scope", "Only for bodies far lighter than what they orbit.")), emptyList(), listOf(claim),
            "a2", 1, "Why an orbit keeps falling", "s", "NOAA · Tides and Orbits", seen = false,
        )
        setContent { KnowScrollTheme { ConnectionSheet(listOf(branch), {}, { _, _ -> }) {} } }
        onNodeWithText(claim.statement).performScrollTo()
        assertNoSourceShown(claim.sourceTitle, claim.sourceUrl, branch.targetSourceTitle)
    }

    /** A stopped lifecycle keeps the Reel's player unmounted, so this renders only the Reel's own controls. */
    private val stopped = object : LifecycleOwner {
        override val lifecycle = LifecycleRegistry.createUnsafe(this).apply { currentState = Lifecycle.State.CREATED }
    }

    @Test
    fun aReelShowsItsTitleButNeverASource() = runComposeUiTest {
        val reel = item.copy(kind = "Reel", media = ReelMedia("/v1/media/" + "a".repeat(64), 12.0, "9:16", simulated = false))
        setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides stopped) {
                KnowScrollTheme { ReelScreen(reading(reel), {}, {}, {}, {}, {}, {}, { _, _ -> }, mediaToken = null) }
            }
        }
        onNodeWithText(reel.title).assertExists()
        assertNoSourceShown(sourceTitle, sourceUrl)
    }
}
