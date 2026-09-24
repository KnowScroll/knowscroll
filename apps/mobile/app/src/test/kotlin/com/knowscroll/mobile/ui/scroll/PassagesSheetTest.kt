package com.knowscroll.mobile.ui.scroll

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.data.PassagesResponse
import com.knowscroll.mobile.data.RelicTarget
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.data.ScrollPassage
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.assertNoSourceShown
import com.knowscroll.mobile.ui.keep.KeepControls
import com.knowscroll.mobile.ui.keep.KeepableState
import com.knowscroll.mobile.ui.keep.PassagesState
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #165 (ADR-0044): the Scroll reader's passages -- each claim of the Scroll on screen, with Keep (a
 * passage Relic at the revision read) and "Seems wrong"; a withdrawn claim is marked and not offered,
 * a revised Scroll offers nothing until it is read again, nothing is offered while paused, and a
 * claim is never shown with where it came from (#161).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
class PassagesSheetTest {
    private val sourceTitle = "NASA · Orbits and Kepler’s Laws"
    private val sourceUrl = "https://science.nasa.gov/solar-system/orbits-and-keplers-laws/"
    private val item = ScrollItem(
        "55555555-5555-4555-8555-555555555555", 2, "Scroll", "Why an orbit keeps falling", "Sideways speed and a steady pull.",
        "An orbit is a fall that keeps missing the ground.", sourceTitle, sourceUrl, "documented", "Opened from your universe.",
    )
    private val fall = ScrollPassage("clm.orbit.fall", "An orbit is a fall that keeps missing the ground.", withdrawn = false, kept = false, seemsWrong = false)
    private val kepler = ScrollPassage("clm.orbit.kepler", "Planets sweep equal areas in equal times.", withdrawn = true, kept = false, seemsWrong = false)
    private val fallTarget = RelicTarget.Passage(item.assetId, 2, fall.claimKey)

    private fun loaded(vararg passages: ScrollPassage, revision: Int = 2) =
        PassagesState.Loaded(PassagesResponse(4, item.assetId, revision, recordingPaused = false, passages = passages.toList()))

    @Test
    fun eachClaimCanBeKeptAtTheRevisionReadOrSaidToSeemWrong() = runComposeUiTest {
        val chosen = mutableListOf<RelicTarget>()
        val keeps = KeepControls(onKeep = { chosen += it }, onSeemsWrong = { chosen += it })
        setContent { KnowScrollTheme { PassagesSheet(item, PassagesControls(loaded(fall), keeps)) {} } }
        onNodeWithText(fall.statement).performScrollTo()
        onNodeWithContentDescription("Keep this passage").performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        onNodeWithContentDescription("This passage seems wrong").performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(listOf<RelicTarget>(fallTarget, fallTarget), chosen)
        assertNoSourceShown(sourceTitle, sourceUrl)
    }

    @Test
    fun aWithdrawnClaimIsMarkedAndNotOffered() = runComposeUiTest {
        setContent { KnowScrollTheme { PassagesSheet(item, PassagesControls(loaded(kepler))) {} } }
        onNodeWithText("What this was based on was withdrawn.").performScrollTo()
        assertEquals(0, onAllNodesWithContentDescription("Keep this passage").fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithContentDescription("This passage seems wrong").fetchSemanticsNodes().size)
    }

    @Test
    fun aKeptOrDoubtedPassageSaysSoAndIsNotOfferedAgain() = runComposeUiTest {
        val keeps = KeepControls(states = mapOf(fallTarget to KeepableState(kept = true, markedWrong = true)))
        setContent { KnowScrollTheme { PassagesSheet(item, PassagesControls(loaded(fall), keeps)) {} } }
        onNodeWithText("Kept in your Relics").performScrollTo()
        onNodeWithText("You marked this as seeming wrong").performScrollTo()
        assertEquals(0, onAllNodesWithContentDescription("Keep this passage").fetchSemanticsNodes().size)
    }

    @Test
    fun aScrollRevisedSinceItWasReadOffersNothingUntilItIsReadAgain() = runComposeUiTest {
        setContent { KnowScrollTheme { PassagesSheet(item, PassagesControls(loaded(fall, revision = 3))) {} } }
        onNodeWithText("This Scroll has changed since you read it: read it again to keep a passage.").performScrollTo()
        assertEquals(0, onAllNodesWithContentDescription("Keep this passage").fetchSemanticsNodes().size)
    }

    @Test
    fun whileRecordingIsPausedNothingIsKeptOrObjectedTo() = runComposeUiTest {
        val orbit = fall.copy(claimKey = "clm.orbit.sideways", statement = "Sideways speed keeps it from landing.")
        setContent { KnowScrollTheme { PassagesSheet(item, PassagesControls(loaded(fall, orbit), KeepControls(paused = true))) {} } }
        // Said once for the sheet, not under every passage (nor read once per passage by TalkBack).
        assertEquals(1, onAllNodesWithText("Recording is paused, so nothing new is kept.").fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithContentDescription("Keep this passage").fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithContentDescription("This passage seems wrong").fetchSemanticsNodes().size)
    }

    @Test
    fun aFailedReadSaysSoAndReadsAgainOnRequest() = runComposeUiTest {
        val opened = mutableListOf<String>()
        setContent {
            KnowScrollTheme { PassagesSheet(item, PassagesControls(PassagesState.Unavailable("Connection interrupted. Please retry."), onOpen = { opened += it })) {} }
        }
        onNodeWithText("Connection interrupted. Please retry.").performScrollTo()
        onNodeWithContentDescription("Retry loading the passages").performScrollTo().performClick()
        assertEquals(listOf(item.assetId), opened)
    }

    @Test
    fun theReaderOpensThePassagesOfTheScrollOnScreen() = runComposeUiTest {
        val opened = mutableListOf<String>()
        setContent {
            KnowScrollTheme {
                ScrollScreen(
                    state = ScrollState.Reading(item, "e1", "ev1", KeepState.Idle, 0, DiscoveryState.Idle, ReaderOrigin.Discovery),
                    onKeep = {}, onReturn = {}, onNext = {}, onRetry = {}, onReadingPosition = { _, _ -> }, onOpenKeep = {},
                    passages = PassagesControls(loaded(fall), onOpen = { opened += it }),
                )
            }
        }
        onNodeWithContentDescription("Keep a passage of this Scroll").assertHeightIsAtLeast(48.dp).performClick()
        onNodeWithText("Passages of this Scroll").assertExists()
        assertEquals(listOf(item.assetId), opened)
        assertNoSourceShown(sourceTitle, sourceUrl)
    }
}
