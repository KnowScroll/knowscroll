package com.knowscroll.mobile.ui.account

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.knowscroll.mobile.data.Inquiry
import com.knowscroll.mobile.data.InquiriesResponse
import com.knowscroll.mobile.data.InquiryConcept
import com.knowscroll.mobile.data.InquiryConsent
import com.knowscroll.mobile.data.InquiryEvidence
import com.knowscroll.mobile.data.InquiryFound
import com.knowscroll.mobile.data.InquiryPair
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** #132 (ADR-0038): what the Privacy & account screen's connections section says for each state --
 * every decision is [InquiriesViewModel]'s (see `InquiriesViewModelTest`); this checks the rendering,
 * the plain wording per status and reason, and that every control is a reachable 48dp target. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class InquiriesSectionTest {
    @get:Rule val composeRule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private fun noop() = InquiryActions(onRetryLoad = {}, onRefresh = {}, onSetEnabled = {}, onSetDailyLimit = {}, onRetryChange = {})

    private fun consent(enabled: Boolean = true, dailyLimit: Int = 3, available: Boolean = true, usedToday: Int = 0) =
        InquiryConsent(enabled, dailyLimit, if (enabled) "2026-09-24T10:00:00.000Z" else null, available, usedToday)

    private val sunGravity = InquiryPair(InquiryConcept("astro.sun", "The Sun"), InquiryConcept("physics.gravity", "Gravity"))

    private fun inquiry(status: String, reasons: List<String> = emptyList(), pairs: List<InquiryPair> = listOf(sunGravity), found: InquiryFound? = null) = Inquiry(
        inquiryId = "11111111-1111-4111-8111-111111111111", status = status, requestedAt = "2026-09-24T10:00:00.000Z",
        closedAt = if (status == "waiting" || status == "looking") null else "2026-09-24T10:05:00.000Z",
        pairs = pairs, reasons = reasons, found = found,
    )

    private fun found(bridgeStatus: String = "admitted") = InquiryFound(
        bridgeId = "22222222-2222-4222-8222-222222222222", bridgeStatus = bridgeStatus, relationType = "compares_mechanism",
        fromConcept = InquiryConcept("astro.sun", "The Sun"), toConcept = InquiryConcept("physics.gravity", "Gravity"),
        sentence = "The Sun keeps every planet on a closed path because its gravity bends each one toward it.",
        evidence = listOf(
            InquiryEvidence("clm.gravity.sun_holds_earth", "The Sun's gravity holds Earth in its orbit.", "mechanism", "NASA · Our Sun: Facts", "https://science.nasa.gov/sun/facts/"),
            InquiryEvidence("clm.gravity.definition", "Gravity is a force that pulls masses together.", "to", "NASA · What Is Gravity?", "https://spaceplace.nasa.gov/what-is-gravity/"),
        ),
    )

    private fun loaded(consent: InquiryConsent = consent(), inquiries: List<Inquiry> = emptyList(), refreshing: Boolean = false, refreshFailed: String? = null) =
        InquiriesState.Loaded(InquiriesResponse(4, consent, inquiries), refreshing, refreshFailed)

    private fun render(
        state: InquiriesState,
        change: ConsentChangeState = ConsentChangeState.Idle,
        recordingPaused: Boolean = false,
        actions: InquiryActions = noop(),
    ) {
        composeRule.setContent {
            KnowScrollTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) { InquiriesSection(state, change, recordingPaused, actions) }
            }
        }
    }

    private fun shown(text: String) = composeRule.onAllNodesWithText(text).assertCountEquals(1)

    // ---- The switch, its limit and the honest lines ----

    @Test
    fun theSwitchIsA48dpTargetThatReflectsConsentAndAsksToTurnItOn() {
        var asked: Boolean? = null
        render(loaded(consent(enabled = false)), actions = noop().copy(onSetEnabled = { asked = it }))
        val toggle = composeRule.onNodeWithContentDescription("Look for connections between my places")
        toggle.assertHeightIsAtLeast(48.dp).assertIsOff().assertIsEnabled()
        shown("Look for connections between my places")
        toggle.performClick()
        assertEquals(true, asked)
    }

    @Test
    fun turningItOffIsTheSameSwitch() {
        var asked: Boolean? = null
        render(loaded(consent(enabled = true)), actions = noop().copy(onSetEnabled = { asked = it }))
        composeRule.onNodeWithContentDescription("Look for connections between my places").assertIsOn().performClick()
        assertEquals(false, asked)
    }

    @Test
    fun whatItCostsAndDoesIsSaidInOnePlainSentence() {
        render(loaded(consent(enabled = false)))
        shown("Each look is one model request that sends only your places' names and their sourced claims, never your reading, and a connection is kept only if KnowScroll's own checks confirm it.")
    }

    @Test
    fun anUnavailableDeploymentSaysNothingWillRun() {
        render(loaded(consent(enabled = true, available = false)))
        shown("This deployment has no background route enabled; nothing will run.")
    }

    @Test
    fun anAvailableDeploymentDoesNotClaimOtherwise() {
        render(loaded(consent(enabled = true, available = true)))
        composeRule.onAllNodesWithText("This deployment has no background route enabled; nothing will run.").assertCountEquals(0)
    }

    @Test
    fun pausedRecordingSaysNothingNewIsLookedFor() {
        render(loaded(consent(enabled = true)), recordingPaused = true)
        shown("Recording is paused, so nothing new is looked for.")
    }

    @Test
    fun theDailyLimitIsAStepperOfReachableTargetsWithinOneToTen() {
        var limit: Int? = null
        render(loaded(consent(enabled = true, dailyLimit = 3, usedToday = 1)), actions = noop().copy(onSetDailyLimit = { limit = it }))
        shown("Up to 3 a day · 1 used today")
        composeRule.onNodeWithContentDescription("Raise the daily limit").assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp).performClick()
        assertEquals(4, limit)
        composeRule.onNodeWithContentDescription("Lower the daily limit").assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp).performClick()
        assertEquals(2, limit)
    }

    @Test
    fun theStepperStopsAtItsBounds() {
        render(loaded(consent(enabled = true, dailyLimit = 10)))
        composeRule.onNodeWithContentDescription("Raise the daily limit").assertIsNotEnabled()
        composeRule.onNodeWithContentDescription("Lower the daily limit").assertIsEnabled()
    }

    @Test
    fun theStepperStopsAtOneToo() {
        render(loaded(consent(enabled = true, dailyLimit = 1)))
        composeRule.onNodeWithContentDescription("Lower the daily limit").assertIsNotEnabled()
    }

    @Test
    fun theLimitIsOnlyOfferedWhileLookingIsOn() {
        render(loaded(consent(enabled = false)))
        composeRule.onAllNodesWithContentDescription("Raise the daily limit").assertCountEquals(0)
    }

    @Test
    fun whileAChangeIsWorkingTheControlsWait() {
        render(loaded(consent(enabled = false)), change = ConsentChangeState.Working(enabled = true, dailyLimit = 3))
        composeRule.onNodeWithContentDescription("Look for connections between my places").assertIsNotEnabled()
        shown("Working…")
    }

    @Test
    fun anUnconfirmedChangeOffersRetryOfTheSameRequest() {
        var retried = false
        render(loaded(), change = ConsentChangeState.Failed("The last change is unconfirmed. Retry sends the same request; nothing is repeated.", canRetry = true),
            actions = noop().copy(onRetryChange = { retried = true }))
        shown("The last change is unconfirmed. Retry sends the same request; nothing is repeated.")
        composeRule.onNodeWithContentDescription("Retry the change to looking for connections").assertHeightIsAtLeast(48.dp).performClick()
        assertTrue(retried)
    }

    @Test
    fun aRefusedChangeIsExplainedButNotRetried() {
        render(loaded(), change = ConsentChangeState.Failed("This changed just before it was applied.", canRetry = false))
        shown("This changed just before it was applied.")
        composeRule.onAllNodesWithContentDescription("Retry the change to looking for connections").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Look for connections between my places").assertIsEnabled()
    }

    // ---- Loading, failure, refresh ----

    @Test
    fun loadingAndAFailedLoad() {
        var retried = false
        render(InquiriesState.Unavailable("Connection interrupted."), actions = noop().copy(onRetryLoad = { retried = true }))
        shown("Connection interrupted.")
        composeRule.onAllNodesWithContentDescription("Look for connections between my places").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Retry loading connections between your places").assertHeightIsAtLeast(48.dp).performClick()
        assertTrue(retried)
    }

    @Test
    fun loadingShowsNoSwitch() {
        render(InquiriesState.Loading)
        shown("Loading what KnowScroll looked for…")
        composeRule.onAllNodesWithContentDescription("Look for connections between my places").assertCountEquals(0)
    }

    @Test
    fun anEmptyListSaysWhenItWillLookAndRefreshIsReachable() {
        var refreshed = false
        render(loaded(), actions = noop().copy(onRefresh = { refreshed = true }))
        shown("What KnowScroll looked for")
        shown("Nothing yet. KnowScroll looks only after a new place forms while this is on.")
        composeRule.onNodeWithContentDescription("Refresh what KnowScroll looked for").performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        assertTrue(refreshed)
    }

    @Test
    fun aFailedRefreshSaysSoAndKeepsTheList() {
        render(loaded(inquiries = listOf(inquiry("looking")), refreshFailed = "Could not refresh. What is shown may be out of date."))
        shown("Could not refresh. What is shown may be out of date.")
        shown("Looking now for a sourced connection.")
    }

    // ---- Each status, in plain words ----

    @Test
    fun waitingSaysItGathersChangesFirstAndNamesNoPairYet() {
        render(loaded(inquiries = listOf(inquiry("waiting", pairs = emptyList()))))
        shown("Waiting to look (it gathers a few changes first).")
        shown("Your places")
    }

    @Test
    fun waitingAtTodaysLimitSaysSo() {
        render(loaded(consent(enabled = true, dailyLimit = 2, usedToday = 2), inquiries = listOf(inquiry("waiting", pairs = emptyList()))))
        shown("Waiting: today's limit is reached, so it looks again tomorrow.")
    }

    @Test
    fun lookingNamesThePairsItIsLookingBetween() {
        val tidesOrbit = InquiryPair(InquiryConcept("astro.orbit", "Orbit"), InquiryConcept("earth.tides", "Tides"))
        render(loaded(inquiries = listOf(inquiry("looking", pairs = listOf(sunGravity, tidesOrbit)))))
        shown("The Sun and Gravity · Orbit and Tides")
        shown("Looking now for a sourced connection.")
    }

    @Test
    fun foundShowsTheBridgeSentenceAndItsSources() {
        render(loaded(inquiries = listOf(inquiry("found", found = found()))))
        shown("Found a connection.")
        shown("The Sun keeps every planet on a closed path because its gravity bends each one toward it.")
        shown("The Sun's gravity holds Earth in its orbit.")
        shown("NASA · Our Sun: Facts")
        shown("NASA · What Is Gravity?")
        composeRule.onAllNodesWithText("A later source correction withdrew this connection.").assertCountEquals(0)
    }

    @Test
    fun aFoundConnectionALaterCorrectionWithdrewSaysSo() {
        render(loaded(inquiries = listOf(inquiry("found", found = found(bridgeStatus = "revoked")))))
        shown("A later source correction withdrew this connection.")
    }

    @Test
    fun nothingFound() {
        render(loaded(inquiries = listOf(inquiry("nothing_found"))))
        shown("Looked, and the sources offered no connection between these places.")
    }

    @Test
    fun didNotHoldUpTranslatesTheValidatorsReasons() {
        render(loaded(inquiries = listOf(inquiry("did_not_hold_up", listOf("from_side_unsupported", "mechanism_is_label")))))
        shown("A connection was proposed but did not hold up: one side had no source of its own; it named the link without explaining how it works.")
    }

    @Test
    fun didNotHoldUpTranslatesAShapeRule() {
        render(loaded(inquiries = listOf(inquiry("did_not_hold_up", listOf("shape", "claim_not_offered")))))
        shown("A connection was proposed but did not hold up: it cited a claim that was not offered.")
    }

    @Test
    fun anUnknownReasonIsNamedRatherThanHidden() {
        render(loaded(inquiries = listOf(inquiry("did_not_hold_up", listOf("brand_new_rule")))))
        shown("A connection was proposed but did not hold up: a check it did not pass (brand_new_rule).")
    }

    @Test
    fun nothingToAsk() {
        render(loaded(inquiries = listOf(inquiry("nothing_to_ask", listOf("no_candidate_pair"), pairs = emptyList()))))
        shown("Nothing to ask: every pair of your places is already connected or was already asked about.")
    }

    @Test
    fun failedSaysWhyAndThatNothingIsSentTwice() {
        render(loaded(inquiries = listOf(inquiry("failed", listOf("outcome_unknown")))))
        shown("Could not finish: the answer never arrived, and a request is never sent twice.")
    }

    @Test
    fun failedOnAStaleContextNamesWhatChanged() {
        render(loaded(inquiries = listOf(inquiry("failed", listOf("stale_context", "pair_connected")))))
        shown("Could not finish: the two places became connected meanwhile.")
    }

    @Test
    fun withdrawnSaysWhy() {
        render(loaded(inquiries = listOf(
            inquiry("withdrawn", listOf("consent_off"), pairs = emptyList()),
            inquiry("withdrawn", listOf("recording_paused"), pairs = emptyList()),
        )))
        shown("Stopped: you turned this off, so nothing from it was kept.")
        shown("Stopped: recording was paused, so nothing from it was kept.")
    }

    // ---- Placement on the Privacy & account screen ----

    @Test
    fun thePrivacyScreenShowsTheSectionOnceLoaded() {
        composeRule.setContent {
            KnowScrollTheme {
                PrivacyScreen(
                    PrivacyState.Loaded("u1", recordingPausedAt = null, privacyEpoch = 4),
                    PrivacyOperationState.Idle, PrivacyOperationState.Idle, ExportState.Idle, PrivacyOperationState.Idle,
                    PrivacyOperationState.Idle, PrivacyOperationState.Idle, privacyTestActions(),
                    inquiries = { paused -> InquiriesSection(loaded(consent(enabled = false)), ConsentChangeState.Idle, paused, noop()) },
                )
            }
        }
        composeRule.onNodeWithText("Connections between your places").performScrollTo()
        composeRule.onNodeWithContentDescription("Look for connections between my places").performScrollTo().assertHeightIsAtLeast(48.dp)
    }

    private fun privacyTestActions() = PrivacyActions(
        onBack = {}, onRetryLoad = {},
        onRequestPause = {}, onRetryPause = {}, onRequestResume = {}, onRetryResume = {},
        onRequestExport = {}, onRetryExport = {}, onExportSaved = {},
        onRequestResetConfirmation = {}, onCancelReset = {}, onConfirmReset = {}, onRetryReset = {},
        onRequestDeleteConfirmation = {}, onCancelDelete = {}, onConfirmDelete = {}, onRetryDelete = {},
        onRequestSignOutConfirmation = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
    )
}
