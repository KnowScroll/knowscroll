package com.knowscroll.mobile.ui.reel

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.knowscroll.mobile.data.EncounterWhy
import com.knowscroll.mobile.data.ReelMedia
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.data.WhyStep
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.scroll.ExplainSheet
import com.knowscroll.mobile.ui.scroll.WhyControls
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.why.WhyAvailability
import com.knowscroll.mobile.ui.why.WhyPanel
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #167 (ADR-0043): a Reel explains itself with the Scroll reader's own why sheet — its recorded
 * path and "less like this" — worded for a Reel, and never shows a source (owner decision). */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
class ReelWhyTest {
    private val reel = ScrollItem(
        "r1", 1, "Reel", "The sea, pulled", "A Reel over a tides Scroll", "", "NOAA Tides and Currents",
        "https://tidesandcurrents.example.invalid/facts", "synthesis", "Continues Tides: you kept “Why the sea rises”.",
        ReelMedia("/v1/media/${"a".repeat(64)}", 7.25, "1080:1920", true),
    )
    private val recorded = EncounterWhy("d1", "r1", "continue", reel.reason, listOf(
        WhyStep.Mark("keep", "s1", "Why the sea rises", "2026-09-24T01:00:00Z", "ev1"),
    ), listOf("less_like_this"))

    @Test
    fun theReelsWhySheetShowsItsRecordedPathAndNoSource() = runComposeUiTest {
        val sent = mutableListOf<String>()
        setContent { KnowScrollTheme { ExplainSheet(reel, ReaderOrigin.Discovery, WhyPanel("d1", "r1", WhyAvailability.Ready(recorded)), { sent += it }) {} } }
        onNodeWithText(reel.reason).performScrollTo()
        onNodeWithText("You opened this Reel through deliberate discovery from your universe.").performScrollTo()
        onNodeWithText("WHAT LED HERE").performScrollTo()
        onNodeWithText("· You kept “Why the sea rises”").performScrollTo()
        onNodeWithText("Less like this").performScrollTo().performClick()
        assertEquals(listOf("less_like_this"), sent)
        // No source name, publisher, address, licence or count. (The synthesis truth state's own
        // fixed meaning, "a source-grounded explanation", names no source.)
        for (source in listOf("NOAA", "Tides and Currents", "example.invalid", "https://", "licen")) {
            assertEquals("the why sheet shows no source ($source)", 0, onAllNodes(hasText(source, substring = true, ignoreCase = true)).fetchSemanticsNodes().size)
        }
        for (label in listOf("SOURCE", "Sources")) {
            assertEquals("the why sheet shows no source label or count ($label)", 0, onAllNodes(hasText(label, substring = true)).fetchSemanticsNodes().size)
        }
    }

    @Test
    fun theReelReaderOpensItsWhyAndLoadsTheRecordedPath() = runComposeUiTest {
        val panel = mutableStateOf<WhyPanel?>(null)
        var opened = 0
        setContent {
            KnowScrollTheme {
                ReelScreen(
                    ScrollState.Reading(reel, "e1", "ev1", KeepState.Idle, 0), {}, {}, {}, {}, {}, {}, { _, _ -> },
                    why = WhyControls(panel.value, { opened += 1; panel.value = WhyPanel("d1", "r1", WhyAvailability.Ready(recorded)) }),
                    mediaToken = null,
                )
            }
        }
        onNodeWithContentDescription("Why this Reel appeared").performClick()
        waitForIdle()
        assertEquals("opening the sheet reads the recorded why once", 1, opened)
        onNodeWithText("· You kept “Why the sea rises”").performScrollTo()
        onNodeWithText("Back to reading").performScrollTo().performClick()
        waitForIdle()
        assertEquals(0, onAllNodesWithText("WHAT LED HERE").fetchSemanticsNodes().size)
    }

    @Test
    fun theAuthoredPreviewHasNoRecordedDecisionSoOffersNoWhy() = runComposeUiTest {
        setContent {
            KnowScrollTheme {
                ReelScreen(ScrollState.Reading(reel, "preview-no-exposure", "", KeepState.Idle, 0), {}, {}, {}, {}, {}, {}, { _, _ -> }, preview = true, mediaToken = null)
            }
        }
        assertEquals(0, onAllNodesWithText("Why").fetchSemanticsNodes().size)
    }
}
