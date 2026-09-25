package com.knowscroll.mobile.ui.reel

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.knowscroll.mobile.data.ReelMedia
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.BranchAvailability
import com.knowscroll.mobile.ui.EncounterBranch
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.branch.BranchPanel
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #183: the Reel's "Continue this idea" chooser is the Scroll reader's own continuation section: a
 * chosen continuation shows it is opening and cannot be chosen again, a list that could not be
 * loaded offers Retry, an opening that failed says why, and one that opened leaves it closed. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
class ReelContinuationTest {
    private val reel = ScrollItem(
        "r1", 1, "Reel", "The sea, pulled", "A Reel over a tides Scroll", "", "", "", "synthesis", "",
        ReelMedia("/v1/media/${"a".repeat(64)}", 7.25, "1080:1920", true),
    )
    private val gravity = EncounterBranch("br1", "r1", 1, "s2", "Is explained by Gravity", "The Moon's pull raises the sea.")

    private fun ready(opening: String? = null, message: String? = null) =
        BranchPanel("r1", BranchAvailability.Ready(listOf(gravity)), opening = opening, message = message)

    @Composable
    private fun ReelWith(panel: BranchPanel, onBranch: (EncounterBranch) -> Unit = {}, onRetry: () -> Unit = {}) =
        ReelScreen(
            ScrollState.Reading(reel, "e1", "ev1", KeepState.Idle, 0), {}, {}, {}, {}, {}, {}, { _, _ -> },
            branches = panel, onBranch = onBranch, onRetryBranches = onRetry, mediaToken = null,
        )

    @Test
    fun aChosenContinuationShowsItIsOpeningAndCannotBeChosenAgain() = runComposeUiTest {
        val panel = mutableStateOf(ready())
        val chosen = mutableListOf<String>()
        setContent { KnowScrollTheme { ReelWith(panel.value, onBranch = { chosen += it.id; panel.value = ready(opening = it.id) }) } }
        onNodeWithText("Continue →").performClick()
        onNodeWithText(gravity.title).performClick()
        waitForIdle()
        assertEquals(listOf(gravity.id), chosen)
        onNodeWithText("Opening the connection…").assertExists()
        onNodeWithText(gravity.title).assertIsNotEnabled()
        assertEquals("the chooser has no connection sheet of its own", 0, onAllNodesWithText("Why these connections?").fetchSemanticsNodes().size)
    }

    @Test
    fun continuationsThatCouldNotBeLoadedOfferRetry() = runComposeUiTest {
        var retried = 0
        setContent { KnowScrollTheme { ReelWith(BranchPanel("r1", BranchAvailability.Failed), onRetry = { retried += 1 }) } }
        onNodeWithText("Continue →").performClick()
        onNodeWithText("Continuations are unavailable right now.").assertExists()
        onNodeWithText("Try continuations again").performClick()
        assertEquals(1, retried)
    }

    @Test
    fun anOpeningThatFailedSaysWhyInTheChooserAndCanBeChosenAgain() = runComposeUiTest {
        val panel = mutableStateOf(ready())
        setContent { KnowScrollTheme { ReelWith(panel.value, onBranch = { panel.value = ready(opening = it.id) }) } }
        onNodeWithText("Continue →").performClick()
        onNodeWithText(gravity.title).performClick()
        panel.value = ready(message = "That connection is no longer available.")
        waitForIdle()
        onNodeWithText("Back to Reel").assertExists()
        assertTrue(onAllNodesWithText("That connection is no longer available.").fetchSemanticsNodes().isNotEmpty())
        onNodeWithText(gravity.title).assertIsEnabled()
    }

    /** Opening a continuation takes the reader to its Scroll; the Reel they come back to (its panel
     * refreshed: nothing opening, no failure) has its chooser closed, and it opens again on request. */
    @Test
    fun aContinuationThatOpenedLeavesTheChooserClosed() = runComposeUiTest {
        val panel = mutableStateOf(ready())
        setContent { KnowScrollTheme { ReelWith(panel.value, onBranch = { panel.value = ready(opening = it.id) }) } }
        onNodeWithText("Continue →").performClick()
        onNodeWithText(gravity.title).performClick()
        panel.value = ready()
        waitForIdle()
        assertEquals(0, onAllNodesWithText("Back to Reel").fetchSemanticsNodes().size)
        // A swipe on the video later opens a continuation without the chooser: it stays closed.
        panel.value = ready(opening = gravity.id)
        waitForIdle()
        assertEquals(0, onAllNodesWithText("Back to Reel").fetchSemanticsNodes().size)
        panel.value = ready()
        onNodeWithText("Continue →").performClick()
        onNodeWithText("Back to Reel").assertExists()
    }
}
