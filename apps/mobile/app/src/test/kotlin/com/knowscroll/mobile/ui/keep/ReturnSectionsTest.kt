package com.knowscroll.mobile.ui.keep

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.knowscroll.mobile.data.AwayItem
import com.knowscroll.mobile.data.AwayResponse
import com.knowscroll.mobile.data.Capabilities
import com.knowscroll.mobile.data.InquiryConcept
import com.knowscroll.mobile.data.InquiryEvidence
import com.knowscroll.mobile.data.InquiryFound
import com.knowscroll.mobile.data.InquiryPair
import com.knowscroll.mobile.data.Relic
import com.knowscroll.mobile.data.RelicProvenance
import com.knowscroll.mobile.data.RelicsResponse
import com.knowscroll.mobile.data.Trace
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.system.AwayControls
import com.knowscroll.mobile.ui.system.AwaySection
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * #134 (ADR-0039): what the return section on the Atlas, a found connection's sheet and Keep's
 * Relics say and offer -- every decision is [ReturnViewModel]'s (see `ReturnViewModelTest`); this
 * checks the rendering: each item's one plain line from its type and fields, the section absent when
 * there is nothing to show, "Mark as seen" gone while paused, and that Keep, Seems wrong and Let go
 * are reachable 48dp targets with the content descriptions the emulator journey drives.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class ReturnSectionsTest {
    @get:Rule val composeRule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val sun = InquiryConcept("astro.sun", "The Sun")
    private val gravity = InquiryConcept("physics.gravity", "Gravity")
    private val bridgeId = "22222222-2222-4222-8222-222222222222"
    private val relicId = "66666666-6666-4666-8666-666666666666"

    private fun found(bridgeStatus: String = "admitted") = InquiryFound(
        bridgeId = bridgeId, bridgeStatus = bridgeStatus, relationType = "compares_mechanism", fromConcept = sun, toConcept = gravity,
        sentence = "The Sun keeps every planet on a closed path because its gravity bends each one toward it.",
        evidence = listOf(
            InquiryEvidence("clm.gravity.sun_holds_earth", "The Sun's gravity holds Earth in its orbit.", "mechanism", "NASA · Our Sun: Facts", "https://science.nasa.gov/sun/facts/"),
            InquiryEvidence("clm.gravity.definition", "Gravity is a force that pulls masses together.", "to", "NASA · What Is Gravity?", "https://spaceplace.nasa.gov/what-is-gravity/"),
        ),
    )

    private val inquiryId = "11111111-1111-4111-8111-111111111111"
    private fun at(minute: Int) = "2026-09-24T10:%02d:00.000Z".format(minute)
    private val foundItem = AwayItem.ConnectionFound(at(9), inquiryId, found())
    private val refusedItem = AwayItem.ConnectionDidNotHoldUp(at(8), inquiryId, listOf(InquiryPair(sun, gravity)), listOf("from_side_unsupported", "mechanism_is_label"))
    private val nothingItem = AwayItem.NothingFound(
        at(7), inquiryId, listOf(InquiryPair(sun, gravity), InquiryPair(InquiryConcept("astro.orbit", "Orbit"), InquiryConcept("earth.tides", "Tides"))),
    )
    private val placeItem = AwayItem.PlaceChanged(at(6), "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
        "foundation_withdrawn", "source_correction", "Gravity no longer holds up Tides: a source was corrected.")
    private val revokedItem = AwayItem.ConnectionCorrected(at(5), bridgeId, "revoked", sun, gravity)
    private val supersededItem = AwayItem.ConnectionCorrected(at(4), bridgeId, "superseded", sun, gravity)

    private fun away(vararg items: AwayItem, more: Long = 0, paused: Boolean = false) =
        AwayState.Loaded(AwayResponse(4, null, items.toList(), more, paused))

    private val noConnection = ConnectionActions({}, {}, {}, {})

    private fun controls(
        state: AwayState, acknowledge: ReturnActionState = ReturnActionState.Idle,
        onMarkSeen: () -> Unit = {}, onRetryMarkSeen: () -> Unit = {},
    ) = AwayControls(state, acknowledge, emptyMap(), onMarkSeen, onRetryMarkSeen, noConnection)

    private fun renderAway(controls: AwayControls, onOpen: (String) -> Unit = {}) {
        composeRule.setContent {
            KnowScrollTheme { Column(Modifier.verticalScroll(rememberScrollState())) { AwaySection(controls, onOpen) } }
        }
    }

    private fun shown(text: String) = composeRule.onAllNodesWithText(text).assertCountEquals(1)
    private fun absent(text: String) = composeRule.onAllNodesWithText(text).assertCountEquals(0)

    // ---- "While you were away" ----

    @Test
    fun inquiryOutcomesAreEachOnePlainLineFromTheirFields() {
        renderAway(controls(away(foundItem, refusedItem, nothingItem)))
        composeRule.onNodeWithContentDescription("While you were away").assertExists()
        shown("While you were away")
        shown("Found a connection: The Sun and Gravity.")
        shown("Looked for a connection between The Sun and Gravity; it did not hold up: one side had no source of its own; it named the link without explaining how it works.")
        shown("Looked for a connection between The Sun and Gravity, or Orbit and Tides; the sources offered none.")
    }

    @Test
    fun correctionsAreSaidPlainlyAndAPlaceChangeUsesTheChroniclesOwnLine() {
        renderAway(controls(away(placeItem, revokedItem, supersededItem)))
        shown("Gravity no longer holds up Tides: a source was corrected.")
        shown("A source correction withdrew the connection between The Sun and Gravity.")
        shown("A source correction replaced the connection between The Sun and Gravity.")
    }

    @Test
    fun aFoundConnectionIsA48dpTargetThatOpensItsEvidence() {
        var opened: String? = null
        renderAway(controls(away(foundItem)), onOpen = { opened = it })
        composeRule.onNodeWithText("Found a connection: The Sun and Gravity.").assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(bridgeId, opened)
    }

    private fun assertNoSection(state: AwayState) {
        renderAway(controls(state))
        composeRule.onAllNodesWithContentDescription("While you were away").assertCountEquals(0)
        absent("While you were away")
        absent("Connection interrupted. Please retry.")
    }

    @Test
    fun theSectionIsAbsentWhenNothingIsUnacknowledged() = assertNoSection(away())

    @Test
    fun theSectionIsAbsentWhileLoading() = assertNoSection(AwayState.Loading)

    @Test
    fun aFailedReadAddsNoNoiseToTheMap() = assertNoSection(AwayState.Unavailable("Connection interrupted. Please retry."))

    @Test
    fun markAsSeenIsAReachableTarget() {
        var marked = false
        renderAway(controls(away(foundItem), onMarkSeen = { marked = true }))
        composeRule.onNodeWithContentDescription("Mark what changed while you were away as seen").assertHeightIsAtLeast(48.dp).performClick()
        assertTrue(marked)
        shown("Mark as seen")
    }

    @Test
    fun whileRecordingIsPausedMarkAsSeenIsReplacedByWhyItStays() {
        renderAway(controls(away(foundItem, paused = true)))
        composeRule.onAllNodesWithContentDescription("Mark what changed while you were away as seen").assertCountEquals(0)
        shown("Recording is paused, so this stays until you resume.")
    }

    @Test
    fun whileMarkingItWaits() {
        renderAway(controls(away(foundItem), acknowledge = ReturnActionState.Working))
        composeRule.onNodeWithContentDescription("Mark what changed while you were away as seen").assertIsNotEnabled()
        shown("Working…")
    }

    @Test
    fun anUnconfirmedMarkOffersRetryOfTheSameRequest() {
        var retried = false
        renderAway(controls(away(foundItem), acknowledge = ReturnActionState.Failed("This is unconfirmed. Retry sends the same request; nothing is repeated.", canRetry = true),
            onRetryMarkSeen = { retried = true }))
        shown("This is unconfirmed. Retry sends the same request; nothing is repeated.")
        composeRule.onNodeWithContentDescription("Retry marking what changed while you were away as seen").assertHeightIsAtLeast(48.dp).performClick()
        assertTrue(retried)
    }

    @Test
    fun aRefusedMarkIsExplainedButNotRetried() {
        renderAway(controls(away(foundItem), acknowledge = ReturnActionState.Failed("KnowScroll could not apply that.", canRetry = false)))
        shown("KnowScroll could not apply that.")
        composeRule.onAllNodesWithContentDescription("Retry marking what changed while you were away as seen").assertCountEquals(0)
    }

    @Test
    fun atMostThreeLinesUntilTheReaderAsksForTheRest() {
        renderAway(controls(away(foundItem, refusedItem, nothingItem, placeItem, revokedItem)))
        absent("Gravity no longer holds up Tides: a source was corrected.")
        shown("and 2 more")
        composeRule.onNodeWithContentDescription("Show everything that changed while you were away").assertHeightIsAtLeast(48.dp).performClick()
        shown("Gravity no longer holds up Tides: a source was corrected.")
        shown("A source correction withdrew the connection between The Sun and Gravity.")
        composeRule.onNodeWithContentDescription("Show fewer of the changes while you were away").performScrollTo().performClick()
        absent("Gravity no longer holds up Tides: a source was corrected.")
    }

    @Test
    fun olderItemsTheServerCountedButDidNotSendAreCountedToo() {
        val ten = List(10) { i -> AwayItem.NothingFound(at(59 - i), inquiryId, listOf(InquiryPair(sun, gravity))) }
        renderAway(controls(away(*ten.toTypedArray(), more = 7)))
        shown("and 14 more")
        composeRule.onNodeWithContentDescription("Show everything that changed while you were away").performClick()
        composeRule.onNodeWithText("And 7 earlier, not listed here.").assertExists()
    }

    // ---- A found connection's sheet ----

    private val connectionActions = mutableListOf<String>()
    private fun recording() = ConnectionActions(
        onKeep = { connectionActions += "keep:$it" }, onRetryKeep = { connectionActions += "retry-keep:$it" },
        onSeemsWrong = { connectionActions += "wrong:$it" }, onRetrySeemsWrong = { connectionActions += "retry-wrong:$it" },
    )

    private fun renderFound(found: InquiryFound = found(), state: ConnectionState = ConnectionState(), onClose: () -> Unit = {}) {
        composeRule.setContent { KnowScrollTheme { ReturnSheet(onDismiss = onClose) { FoundConnectionSheet(found, state, recording(), onClose) } } }
    }

    @Test
    fun theSheetShowsTheSentenceAndItsSourcesAndOffersKeepAndSeemsWrong() {
        renderFound()
        shown("The Sun and Gravity")
        shown("The Sun keeps every planet on a closed path because its gravity bends each one toward it.")
        shown("The Sun's gravity holds Earth in its orbit.")
        shown("NASA · Our Sun: Facts")
        shown("NASA · What Is Gravity?")
        composeRule.onNodeWithContentDescription("Keep this connection").performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        composeRule.onNodeWithContentDescription("This connection seems wrong").performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(listOf("keep:$bridgeId", "wrong:$bridgeId"), connectionActions)
    }

    @Test
    fun aKeptConnectionSaysSoAndCanStillBeMarkedWrong() {
        renderFound(state = ConnectionState(kept = true))
        shown("Kept in your Relics")
        composeRule.onAllNodesWithContentDescription("Keep this connection").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("This connection seems wrong").performScrollTo().assertExists()
    }

    @Test
    fun aConnectionMarkedWrongIsNeitherKeptNorMarkedAgain() {
        renderFound(state = ConnectionState(kept = true, markedWrong = true))
        shown("Kept in your Relics")
        shown("You marked this as seeming wrong")
        composeRule.onAllNodesWithContentDescription("Keep this connection").assertCountEquals(0)
        composeRule.onAllNodesWithContentDescription("This connection seems wrong").assertCountEquals(0)
    }

    @Test
    fun aWithdrawnConnectionIsShownNotOffered() {
        renderFound(found = found("revoked"))
        shown("A later source correction withdrew this connection.")
        composeRule.onAllNodesWithContentDescription("Keep this connection").assertCountEquals(0)
        composeRule.onAllNodesWithContentDescription("This connection seems wrong").assertCountEquals(0)
    }

    @Test
    fun anUnconfirmedKeepOffersOnlyTheRetryOfTheSameRequest() {
        renderFound(state = ConnectionState(keep = ReturnActionState.Failed("This is unconfirmed. Retry sends the same request; nothing is repeated.", canRetry = true)))
        composeRule.onAllNodesWithContentDescription("Keep this connection").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Retry keeping this connection").performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(listOf("retry-keep:$bridgeId"), connectionActions)
    }

    @Test
    fun aRefusedSeemsWrongIsExplainedAndTheChoiceStays() {
        renderFound(state = ConnectionState(seemsWrong = ReturnActionState.Failed("KnowScroll could not apply that.", canRetry = false)))
        shown("KnowScroll could not apply that.")
        composeRule.onAllNodesWithContentDescription("Retry marking this connection as seeming wrong").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("This connection seems wrong").performScrollTo().assertExists()
    }

    @Test
    fun whileKeepingTheButtonWaits() {
        renderFound(state = ConnectionState(keep = ReturnActionState.Working))
        composeRule.onNodeWithContentDescription("Keep this connection").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun theSheetClosesFromItsBackPill() {
        var closed = 0
        renderFound(onClose = { closed += 1 })
        composeRule.onNodeWithContentDescription("Close this connection").assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(1, closed)
    }

    // ---- Keep's Relics ----

    private fun relic(state: String, id: String = relicId) = Relic(
        relicId = id, keptAt = "2026-09-24T10:10:00.000Z", state = state,
        connection = found(if (state == "corrected") "revoked" else "admitted"),
        provenance = RelicProvenance(inquiryId, "bridge-validator-v1", listOf("clm.gravity.sun_holds_earth")),
    )

    private val universe = UniverseState.Loaded(Universe(
        "u1", 1, 4, listOf(Trace("e1", "a1", "The pull you can't see", "2026-09-23T10:00:00.000Z")), Capabilities.AllFalse,
    ))

    private val letGo = mutableListOf<String>()

    private fun renderKeep(state: RelicsState, releases: Map<String, ReturnActionState> = emptyMap(), onRetryLoad: () -> Unit = {}) {
        composeRule.setContent {
            KnowScrollTheme {
                KeepScreen(
                    state = universe, onOpenTrace = {}, onSelectAtlas = {}, onSelectCable = {},
                    relics = RelicControls(state, releases, onLetGo = { letGo += "let-go:$it" }, onRetryLetGo = { letGo += "retry:$it" }, onRetryLoad = onRetryLoad),
                )
            }
        }
    }

    private fun relics(vararg relics: Relic) = RelicsState.Loaded(RelicsResponse(4, relics.toList()))

    @Test
    fun keepListsRelicsAboveTracesEachWithItsState() {
        renderKeep(relics(
            relic("current"),
            relic("corrected", id = "77777777-7777-4777-8777-777777777777"),
            relic("doubted", id = "88888888-8888-4888-8888-888888888888"),
        ))
        shown("Relics")
        shown("Traces")
        composeRule.onAllNodesWithContentDescription("Relic: The Sun and Gravity").assertCountEquals(3)
        shown("Current")
        shown("Corrected — a source changed after you kept it")
        shown("You marked this as seeming wrong")
        composeRule.onAllNodes(hasStateDescription("Corrected — a source changed after you kept it")).assertCountEquals(1)
        shown("The pull you can't see")
        val relicsTop = composeRule.onNodeWithText("Relics").getUnclippedBoundsInRoot().top
        val tracesTop = composeRule.onNodeWithText("The pull you can't see").getUnclippedBoundsInRoot().top
        assertTrue("Relics come above Traces", relicsTop < tracesTop)
    }

    @Test
    fun withoutRelicsKeepIsUnchanged() {
        renderKeep(relics())
        absent("Relics")
        absent("Traces")
        shown("The pull you can't see")
    }

    @Test
    fun whileRelicsLoadNothingIsSaid() {
        renderKeep(RelicsState.Loading)
        absent("Relics")
        absent("Traces")
        shown("The pull you can't see")
    }

    @Test
    fun aFailedRelicsLoadSaysSoAndOffersRetry() {
        var retried = false
        renderKeep(RelicsState.Unavailable("Connection interrupted. Please retry."), onRetryLoad = { retried = true })
        shown("Connection interrupted. Please retry.")
        composeRule.onNodeWithContentDescription("Retry loading your Relics").assertHeightIsAtLeast(48.dp).performClick()
        assertTrue(retried)
    }

    @Test
    fun aRelicOpensItsKeptFormWithLetGo() {
        renderKeep(relics(relic("corrected")))
        composeRule.onNodeWithContentDescription("Relic: The Sun and Gravity").assertHeightIsAtLeast(48.dp).performClick()
        composeRule.onNodeWithText("The Sun keeps every planet on a closed path because its gravity bends each one toward it.").assertExists()
        composeRule.onNodeWithText("A later source correction withdrew this connection.").assertExists()
        composeRule.onNodeWithText("NASA · Our Sun: Facts").assertExists()
        composeRule.onNodeWithContentDescription("Let go of this Relic").performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(listOf("let-go:$relicId"), letGo)
    }

    @Test
    fun anUnconfirmedLetGoOffersOnlyTheRetry() {
        renderKeep(relics(relic("current")), releases = mapOf(relicId to ReturnActionState.Failed("This is unconfirmed. Retry sends the same request; nothing is repeated.", canRetry = true)))
        composeRule.onNodeWithContentDescription("Relic: The Sun and Gravity").performClick()
        composeRule.onAllNodesWithContentDescription("Let go of this Relic").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Retry letting go of this Relic").performScrollTo().performClick()
        assertEquals(listOf("retry:$relicId"), letGo)
    }
}
