package com.knowscroll.mobile.ui.scroll

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.knowscroll.mobile.data.AnswerBasisQuote
import com.knowscroll.mobile.data.AnswerStatus
import com.knowscroll.mobile.data.AnswerView
import com.knowscroll.mobile.ui.ask.AskPanel
import com.knowscroll.mobile.ui.ask.AskStage
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #132 — ADR-0033: the Ask sheet only ever shows the reader's own recorded question and exactly
 * what the answer service returned -- never a claim it did not make. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
class AskSheetTest {
    @Test
    fun composingDisablesAskUntilAQuestionIsTypedAndSendsItLiterally() = runComposeUiTest {
        val sent = mutableListOf<String>()
        setContent {
            KnowScrollTheme { AskSheet(AskControls(AskPanel("a1"), onAsk = { sent += it })) {} }
        }
        onNodeWithText("Ask", substring = false).performScrollTo().assertIsNotEnabled()
        onNodeWithText("Your question").performScrollTo().performTextInput("Does this Scroll mention storm surge?")
        onNodeWithText("Ask", substring = false).performScrollTo().performClick()
        assertEquals(listOf("Does this Scroll mention storm surge?"), sent)
    }

    @Test
    fun recordingThenRecordedOffersGetAnAnswerAsASeparateAction() = runComposeUiTest {
        var gotAnswer = false
        val panel = mutableStateOf(AskPanel("a1", AskStage.Recording, "Does this cover storm surge?"))
        setContent { KnowScrollTheme { AskSheet(AskControls(panel.value, onGetAnswer = { gotAnswer = true })) {} } }
        onNodeWithText("Recording your question…").performScrollTo()

        panel.value = panel.value.copy(stage = AskStage.Recorded("ask1"))
        waitForIdle()
        onNodeWithText("Getting an answer sends your question and this Scroll's text to an outside AI model", substring = true).performScrollTo()
        onNodeWithText("Get an answer").performScrollTo().performClick()
        assertEquals(true, gotAnswer)
    }

    @Test
    fun waitingShowsCancelOnlyWhileQueued() = runComposeUiTest {
        var cancelled = false
        val panel = mutableStateOf(AskPanel("a1", AskStage.Waiting("ask1", "queued")))
        setContent { KnowScrollTheme { AskSheet(AskControls(panel.value, onCancel = { cancelled = true })) {} } }
        onNodeWithText("Your question is queued for an answer.").performScrollTo()
        onNodeWithText("Cancel").performScrollTo().performClick()
        assertEquals(true, cancelled)

        panel.value = panel.value.copy(stage = AskStage.Waiting("ask1", "running"))
        waitForIdle()
        onNodeWithText("Checking the answer against this Scroll…").performScrollTo()
        assertEquals(0, onAllNodesWithText("Cancel").fetchSemanticsNodes().size)
    }

    @Test
    fun anAnsweredResultShowsTheAnswerItsBasisAndWhereItStops() = runComposeUiTest {
        val view = AnswerView(
            "ask1",
            AnswerStatus.Answered(
                "The tide rises because gravity pulls the ocean toward the Moon.",
                listOf(AnswerBasisQuote("Gravity pulls the ocean toward the Moon.")),
                "This only covers lunar tides, not storm surge.",
            ),
            "2026-09-24T00:00:00Z", "2026-09-24T00:01:00Z",
        )
        setContent { KnowScrollTheme { AskSheet(AskControls(AskPanel("a1", AskStage.Final("ask1", view)))) {} } }
        onNodeWithText("The tide rises because gravity pulls the ocean toward the Moon.").performScrollTo()
        onNodeWithText("FROM THIS SCROLL").performScrollTo()
        onNodeWithText("· Gravity pulls the ocean toward the Moon.").performScrollTo()
        onNodeWithText("WHERE IT STOPS").performScrollTo()
        onNodeWithText("This only covers lunar tides, not storm surge.").performScrollTo()
    }

    @Test
    fun everyOtherTerminalStatusShowsItsOwnHonestCopyAndNeverAFabricatedAnswer() = runComposeUiTest {
        val panel = mutableStateOf(AskPanel("a1", AskStage.Final("ask1", AnswerView("ask1", AnswerStatus.NotInSource("This Scroll does not discuss storm surge."), "t", "t2"))))
        setContent { KnowScrollTheme { AskSheet(AskControls(panel.value)) {} } }
        onNodeWithText("This Scroll doesn't say.").performScrollTo()
        onNodeWithText("This Scroll does not discuss storm surge.").performScrollTo()

        panel.value = panel.value.copy(stage = AskStage.Final("ask1", AnswerView("ask1", AnswerStatus.Rejected(listOf("The draft cited a quote not in this Scroll.")), "t", "t2")))
        waitForIdle()
        onNodeWithText("The answer didn't hold up against the Scroll, so it isn't shown.").performScrollTo()

        panel.value = panel.value.copy(stage = AskStage.Final("ask1", AnswerView("ask1", AnswerStatus.Failed(listOf("The answer service could not complete this request.")), "t", "t2")))
        waitForIdle()
        onNodeWithText("The answer couldn't be completed. Nothing from it was kept.").performScrollTo()

        panel.value = panel.value.copy(stage = AskStage.Final("ask1", AnswerView("ask1", AnswerStatus.Cancelled(listOf("Cancelled before the job started.")), "t", null)))
        waitForIdle()
        onNodeWithText("You cancelled this question's answer.").performScrollTo()

        panel.value = panel.value.copy(stage = AskStage.Final("ask1", AnswerView("ask1", AnswerStatus.Unavailable, "t", null)))
        waitForIdle()
        onNodeWithText("No answer arrived in time.").performScrollTo()
    }

    @Test
    fun theClientGivingUpPollingShowsTheSameCopyAsAServerUnavailableStatusWithoutClaimingOne() = runComposeUiTest {
        setContent { KnowScrollTheme { AskSheet(AskControls(AskPanel("a1", AskStage.TimedOut("ask1")))) {} } }
        onNodeWithText("No answer arrived in time.").performScrollTo()
    }

    @Test
    fun anErrorKeepsTheTypedQuestionAndShowsTheMessage() = runComposeUiTest {
        setContent {
            KnowScrollTheme {
                AskSheet(AskControls(AskPanel("a1", AskStage.Error(null, "Recording is paused, so questions aren't recorded."), "Does this cover storm surge?"))) {}
            }
        }
        onNodeWithText("Recording is paused, so questions aren't recorded.").performScrollTo()
        onNodeWithText("Does this cover storm surge?").performScrollTo()
    }

    /** #132 review I5: after an unclear failure of "Get an answer" the question is already recorded,
     * so the sheet offers the same request again (the saved request key is reused) -- never a second
     * question that would record a second Ask and a second paid request. */
    @Test
    fun anUnclearAnswerRequestFailureOffersGetAnAnswerAgainNotANewQuestion() = runComposeUiTest {
        var retried = 0
        setContent {
            KnowScrollTheme { AskSheet(AskControls(AskPanel("a1", AskStage.Error("ask1", "The network dropped."), "Does this cover storm surge?"), onGetAnswer = { retried += 1 })) {} }
        }
        onNodeWithText("The network dropped.").performScrollTo()
        assertEquals(0, onAllNodesWithText("Your question").fetchSemanticsNodes().size)
        onNodeWithText("Get an answer").performScrollTo().performClick()
        assertEquals(1, retried)
    }
}
