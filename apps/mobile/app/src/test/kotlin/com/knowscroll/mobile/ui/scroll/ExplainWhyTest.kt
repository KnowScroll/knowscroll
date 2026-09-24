package com.knowscroll.mobile.ui.scroll

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.knowscroll.mobile.data.EncounterWhy
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.data.WhyStep
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.why.WhyAvailability
import com.knowscroll.mobile.ui.why.WhyPanel
import com.knowscroll.mobile.ui.why.correctedText
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #133: the why sheet shows the recorded path and offers only the corrections the server allows. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
class ExplainWhyTest {
    private val item = ScrollItem("a2", 1, "Scroll", "Why the sea rises", "s", "b", "NOAA", "https://example.invalid", "documented",
        "A sourced connection from “Gravity pulls”: Gravity explains Tides.")
    private val recorded = EncounterWhy("d1", "a2", "bridge", item.reason, listOf(
        WhyStep.Mark("keep", "a1", "Gravity pulls", "2026-09-24T01:00:00Z", "ev1"),
        WhyStep.Bridge("br1", "Gravity explains Tides"),
    ), listOf("less_like_this", "wrong_connection"))

    @Test
    fun theRecordedPathAndItsCorrectionsAreShownAndSent() = runComposeUiTest {
        val sent = mutableListOf<String>()
        val panel = mutableStateOf(WhyPanel("d1", "a2", WhyAvailability.Ready(recorded)))
        setContent { KnowScrollTheme { ExplainSheet(item, ReaderOrigin.Discovery, panel.value, { sent += it }) {} } }
        onNodeWithText("WHAT LED HERE").performScrollTo()
        onNodeWithText("· You kept “Gravity pulls”").performScrollTo()
        onNodeWithText("· Gravity explains Tides").performScrollTo()
        onNodeWithText("Less like this").performScrollTo().performClick()
        assertEquals(listOf("less_like_this"), sent)

        panel.value = panel.value.copy(sending = "less_like_this")
        waitForIdle()
        onNodeWithText("Wrong connection").performScrollTo().assertIsNotEnabled()

        panel.value = panel.value.copy(sending = null, corrected = setOf("less_like_this"), message = correctedText("less_like_this"))
        waitForIdle()
        onNodeWithText(correctedText("less_like_this")).performScrollTo()
        assertEquals("a made correction is not offered again", 0, onAllNodesWithText("Less like this").fetchSemanticsNodes().size)
        // …while the other correction this connection supports stays available.
        onNodeWithText("Wrong connection").performScrollTo()
    }

    @Test
    fun anEncounterTheComposerDidNotChooseSaysSo() = runComposeUiTest {
        setContent { KnowScrollTheme { ExplainSheet(item, ReaderOrigin.Discovery, WhyPanel("", "a2", WhyAvailability.Unrecorded), {}) {} } }
        onNodeWithText("This step was not chosen by the Composer, so there is no recorded path to show.").performScrollTo()
        assertEquals(0, onAllNodesWithText("Less like this").fetchSemanticsNodes().size)
    }
}
