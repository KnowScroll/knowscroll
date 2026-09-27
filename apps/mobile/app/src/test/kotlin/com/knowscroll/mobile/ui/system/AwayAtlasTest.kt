package com.knowscroll.mobile.ui.system

import android.provider.Settings
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import com.knowscroll.mobile.data.AtlasAnchor
import com.knowscroll.mobile.data.AtlasAttention
import com.knowscroll.mobile.data.AtlasPlace
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.data.AtlasScrollCounts
import com.knowscroll.mobile.data.AwayItem
import com.knowscroll.mobile.data.AwayResponse
import com.knowscroll.mobile.data.InquiryConcept
import com.knowscroll.mobile.data.InquiryEvidence
import com.knowscroll.mobile.data.InquiryFound
import com.knowscroll.mobile.data.RelicTarget
import com.knowscroll.mobile.data.WorldSummary
import com.knowscroll.mobile.data.WorldSystem
import com.knowscroll.mobile.data.WorldSystemResponse
import com.knowscroll.mobile.ui.AtlasState
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.assertNoSourceShown
import com.knowscroll.mobile.ui.keep.AwayState
import com.knowscroll.mobile.ui.keep.KeepControls
import com.knowscroll.mobile.ui.keep.KeepableState
import com.knowscroll.mobile.ui.keep.ReturnActionState
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #134 (ADR-0039 §6): "While you were away" on the Atlas itself -- above the map, only when
 * something is unacknowledged; a found connection opens its evidence sheet over the map with "Keep"
 * and "Seems wrong" (#161: never a source), and the sheet closes back to the same Atlas.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
class AwayAtlasTest {
    @get:Rule val composeRule = createComposeRule()

    private val world = WorldSummary("w-1", "NASA · Gravity pulls", "https://example.test/gravity", 3, 3)
    private val loadedWorlds = SystemState.Loaded(WorldSystemResponse("shared_source_v1", WorldSystem("sys-1", listOf(world))))
    private val planet = AtlasPlace(
        placeId = "11111111-1111-1111-1111-111111111111", kind = "planet", parentPlaceId = null, anchor = AtlasAnchor("physics.gravity", "Gravity", "Gravity description"),
        basis = null, attention = AtlasAttention("anchored", 3, 2, 2), scrolls = AtlasScrollCounts(3, 2),
        formedAt = "2026-09-23T00:00:00.000Z", formedBy = "place_formed",
    )
    private val bridgeId = "22222222-2222-4222-8222-222222222222"
    private val found = InquiryFound(
        bridgeId = bridgeId, bridgeStatus = "admitted", relationType = "compares_mechanism",
        fromConcept = InquiryConcept("astro.sun", "The Sun"), toConcept = InquiryConcept("physics.gravity", "Gravity"),
        sentence = "The Sun keeps every planet on a closed path because its gravity bends each one toward it.",
        evidence = listOf(InquiryEvidence("clm.gravity.sun_holds_earth", "The Sun's gravity holds Earth in its orbit.", "mechanism", "NASA · Our Sun: Facts", "https://science.nasa.gov/sun/facts/", withdrawn = false)),
    )
    private val foundItem = AwayItem.ConnectionFound("2026-09-24T10:05:00.000Z", "11111111-1111-4111-8111-111111111111", found, seemsWrong = false)
    private val actions = mutableListOf<String>()

    private fun render(places: List<AtlasPlace> = listOf(planet), items: List<AwayItem> = listOf(foundItem), states: Map<RelicTarget, KeepableState> = emptyMap()) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        val away = AwayControls(
            state = AwayState.Loaded(AwayResponse(4, null, items, 0, null, false)), acknowledge = ReturnActionState.Idle,
            onMarkSeen = { actions += "seen" }, onRetryMarkSeen = {},
        )
        val keeps = KeepControls(states, onKeep = { actions += "keep:$it" }, onSeemsWrong = { actions += "wrong:$it" })
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = loadedWorlds, atlasState = AtlasState.Loaded(AtlasResponse("cartographer-v1", places, emptyList(), emptyList())),
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}, away = away, keeps = keeps,
                )
            }
        }
    }

    private val line = "Found a connection: The Sun and Gravity."

    @Test
    fun thePlacesLayerOpensWithWhatChangedWhileAway() {
        render()
        composeRule.onNodeWithText("While you were away").assertExists()
        composeRule.onAllNodesWithText(line).assertCountEquals(1)
        composeRule.onNodeWithContentDescription("Mark what changed while you were away as seen").performClick()
        assertEquals(listOf("seen"), actions)
        // The map and its honest label are still there beneath it.
        composeRule.onAllNodesWithText("Positions, orbits, moons and land art are illustrative — what's mapped and how it connects is real.").assertCountEquals(1)
    }

    @Test
    fun nothingUnacknowledgedLeavesTheAtlasAsItWas() {
        render(items = emptyList())
        composeRule.onAllNodesWithText("While you were away").assertCountEquals(0)
        composeRule.onAllNodesWithText("Positions, orbits, moons and land art are illustrative — what's mapped and how it connects is real.").assertCountEquals(1)
    }

    @Test
    fun anAtlasWithNoPlanetsYetStillSaysWhatChanged() {
        render(places = emptyList())
        composeRule.onAllNodesWithText("Places form when you come back to a subject on different days.").assertCountEquals(1)
        composeRule.onNodeWithText("While you were away").assertExists()
        composeRule.assertNoSourceShown(world.sourceTitle, world.sourceUrl)
    }

    @Test
    fun aFoundConnectionOpensItsEvidenceOverTheMapAndClosesBackToIt() {
        render()
        composeRule.onNodeWithText(line).performClick()
        composeRule.onNodeWithText(found.sentence).assertExists()
        composeRule.onNodeWithText("The Sun's gravity holds Earth in its orbit.").assertExists()
        composeRule.assertNoSourceShown("NASA · Our Sun: Facts", "https://science.nasa.gov/sun/facts/", world.sourceTitle)
        // The Atlas beneath is hidden from TalkBack while the sheet is open.
        composeRule.onAllNodesWithText("While you were away").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Keep this connection").performScrollTo().performClick()
        composeRule.onNodeWithContentDescription("This connection seems wrong").performScrollTo().performClick()
        assertEquals(listOf("keep:${RelicTarget.Connection(bridgeId)}", "wrong:${RelicTarget.Connection(bridgeId)}"), actions)
        composeRule.onNodeWithContentDescription("Close this connection").performClick()
        composeRule.onAllNodesWithText(found.sentence).assertCountEquals(0)
        composeRule.onNodeWithText("While you were away").assertExists()
    }

    @Test
    fun aKeptConnectionSaysSoInItsSheet() {
        render(states = mapOf(RelicTarget.Connection(bridgeId) to KeepableState(kept = true)))
        composeRule.onNodeWithText(line).performClick()
        composeRule.onNodeWithText("Kept in your Relics").performScrollTo().assertExists()
        composeRule.onAllNodesWithContentDescription("Keep this connection").assertCountEquals(0)
    }
}
