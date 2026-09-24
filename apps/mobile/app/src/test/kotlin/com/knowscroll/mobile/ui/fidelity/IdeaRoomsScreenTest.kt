package com.knowscroll.mobile.ui.fidelity

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
import com.knowscroll.mobile.data.AtlasRoom
import com.knowscroll.mobile.data.AtlasScrollCounts
import com.knowscroll.mobile.data.AwayResponse
import com.knowscroll.mobile.data.RoomAskEvidence
import com.knowscroll.mobile.data.RoomChronicleEntry
import com.knowscroll.mobile.data.RoomClaim
import com.knowscroll.mobile.data.RoomDetail
import com.knowscroll.mobile.data.RoomEvidence
import com.knowscroll.mobile.data.RoomInhabitant
import com.knowscroll.mobile.data.WorldSummary
import com.knowscroll.mobile.data.WorldSystem
import com.knowscroll.mobile.data.WorldSystemResponse
import com.knowscroll.mobile.ui.AtlasState
import com.knowscroll.mobile.ui.RoomSetAsideState
import com.knowscroll.mobile.ui.RoomState
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.assertNoSourceShown
import com.knowscroll.mobile.ui.keep.AwayState
import com.knowscroll.mobile.ui.keep.KeepControls
import com.knowscroll.mobile.ui.keep.ReturnActionState
import com.knowscroll.mobile.ui.system.AwayControls
import com.knowscroll.mobile.ui.system.RoomControls
import com.knowscroll.mobile.ui.system.SystemScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #163 (ADR-0045) — Idea Rooms on the System screen. These pin: a place that holds a room is marked
 * on the map (a lit door said aloud, no new object); its sheet lists each room under the reader's
 * own question and opens it through the view model; the room sheet shows the question, its state in
 * words, each inhabitant with the sentences it holds and the chronicle with each line's evidence;
 * "Set this room aside" confirms first and is never offered while recording is paused; and nothing
 * shown ever names a source.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
class IdeaRoomsScreenTest {
    @get:Rule val composeRule = createComposeRule()

    private val sources = arrayOf("NASA · What is gravity?", "Journey fixture: another reading of gravity", "https://spaceplace.nasa.gov/what-is-gravity/en/")
    private val planetId = "11111111-1111-1111-1111-111111111111"
    private val roomId = "22222222-2222-4222-8222-222222222222"
    private val question = "So what is gravity, really?"
    private val definition = RoomClaim("clm.gravity.definition", "Gravity draws objects toward a planet's center.", "documented", "supports")
    private val curvature = RoomClaim("clm.journey.gravity_curvature", "Gravity is the curving of space and time around a mass.", "documented", "qualifies")
    private val inhabitants = listOf(RoomInhabitant("reader_of_record", listOf(definition)), RoomInhabitant("doubter", listOf(curvature)))
    private val summary = AtlasRoom(roomId, question, "arguing", inhabitants, "2026-09-25T10:00:00.000Z")
    private val gravity = AtlasPlace(
        placeId = planetId, kind = "planet", parentPlaceId = null, anchor = AtlasAnchor("physics.gravity", "Gravity", "The force that pulls masses together."),
        basis = null, attention = AtlasAttention("anchored", 3, 2, 2), scrolls = AtlasScrollCounts(3, 3),
        formedAt = "2026-09-24T00:00:00.000Z", formedBy = "place_formed", rooms = listOf(summary),
    )
    private val atlas = AtlasResponse("cartographer-v2", listOf(gravity), emptyList(), emptyList())
    private val room = RoomDetail(
        roomId, planetId, "Gravity", question, "arguing", inhabitants, "2026-09-25T10:00:00.000Z",
        listOf(
            RoomChronicleEntry("33333333-3333-4333-8333-333333333333", "inhabitant_seated", "substrate_neighbourhood", "doubter", "2026-09-25T10:00:00.000Z",
                "The doubter took a seat: two readings of Gravity disagree.", RoomEvidence(emptyList(), listOf(curvature), emptyList())),
            RoomChronicleEntry("44444444-4444-4444-8444-444444444444", "room_opened", "personal_exploration", null, "2026-09-25T10:00:00.000Z",
                "A question you keep asking opened a room on Gravity.",
                RoomEvidence(listOf(RoomAskEvidence("55555555-5555-4555-8555-555555555555", "2026-09-24"), RoomAskEvidence("66666666-6666-4666-8666-666666666666", "2026-09-25")), emptyList(), emptyList())),
        ),
    )

    private fun content(
        state: RoomState = RoomState.Closed,
        setAside: RoomSetAsideState = RoomSetAsideState.Idle,
        paused: Boolean = false,
        onOpen: (String) -> Unit = {},
        onRequestSetAside: () -> Unit = {},
        onConfirmSetAside: () -> Unit = {},
    ) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        val world = WorldSummary("w-1", "NASA · What is gravity?", "https://spaceplace.nasa.gov/what-is-gravity/en/", 3, 3)
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = SystemState.Loaded(WorldSystemResponse("shared_source_v1", WorldSystem("sys-1", listOf(world)))),
                    atlasState = AtlasState.Loaded(atlas),
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {},
                    away = AwayControls(
                        state = AwayState.Loaded(AwayResponse(4, null, emptyList(), 0, null, paused)), acknowledge = ReturnActionState.Idle,
                        onMarkSeen = {}, onRetryMarkSeen = {},
                    ),
                    keeps = KeepControls(paused = paused),
                    rooms = RoomControls(
                        state = state, setAside = setAside, onOpen = onOpen, onClose = {},
                        onRequestSetAside = onRequestSetAside, onCancelSetAside = {}, onConfirmSetAside = onConfirmSetAside,
                    ),
                )
            }
        }
    }

    private fun openGravity() {
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
    }

    @Test
    fun aPlaceThatHoldsARoomIsMarkedOnTheMapAndListsItUnderTheReadersQuestion() {
        var opened: String? = null
        content(onOpen = { opened = it })
        // Said aloud with the marker, like a foundation: a property of the place, not a new object.
        composeRule.onNodeWithText("Idea room").assertExists()
        composeRule.onAllNodesWithContentDescription("Idea room", substring = true).assertCountEquals(0)
        openGravity()
        composeRule.onNodeWithText("\"$question\"").performScrollTo().assertExists()
        composeRule.onNodeWithText("Two readings disagree").assertExists()
        composeRule.onNodeWithContentDescription("Open the room: $question").performScrollTo().performClick()
        assertEquals(roomId, opened)
        composeRule.assertNoSourceShown(*sources)
    }

    @Test
    fun theRoomSheetShowsTheQuestionItsStateEachInhabitantsSentencesAndTheChronicleWithEvidence() {
        content(state = RoomState.Loaded(room))
        openGravity()
        composeRule.onNodeWithText("\"$question\"").assertExists()
        composeRule.onNodeWithText("Two readings disagree · Gravity").assertExists()
        composeRule.onNodeWithText("The reader of record").assertExists()
        composeRule.onNodeWithText("\"Gravity draws objects toward a planet's center.\"").assertExists()
        composeRule.onNodeWithText("The doubter").assertExists()
        composeRule.onNodeWithText("\"Gravity is the curving of space and time around a mass.\" (qualified)").assertExists()
        composeRule.onAllNodesWithText("Asked 2 times", substring = true).assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Show evidence: A question you keep asking opened a room on Gravity.").performScrollTo().performClick()
        composeRule.onNodeWithText("Asked 2 times, on 2026-09-24 and 2026-09-25.").performScrollTo().assertExists()
        composeRule.assertNoSourceShown(*sources)
    }

    @Test
    fun settingARoomAsideAsksTheViewModelBeforeAnythingIsSent() {
        var requested = false
        content(state = RoomState.Loaded(room), onRequestSetAside = { requested = true })
        openGravity()
        composeRule.onNodeWithContentDescription("Set this room aside").performScrollTo().performClick()
        assertTrue(requested)
    }

    @Test
    fun theConfirmationStepSaysWhatSettingAsideMeansAndConfirmingCallsTheViewModel() {
        var confirmed = false
        content(state = RoomState.Loaded(room), setAside = RoomSetAsideState.Confirming(roomId), onConfirmSetAside = { confirmed = true })
        openGravity()
        composeRule.onNodeWithText("Set this room aside? The questions it holds won't open a room here again unless you clear your history.").performScrollTo().assertExists()
        composeRule.onNodeWithContentDescription("Confirm setting this room aside").performScrollTo().performClick()
        assertTrue(confirmed)
    }

    @Test
    fun whileRecordingIsPausedNoRoomIsSetAside() {
        content(state = RoomState.Loaded(room), paused = true)
        openGravity()
        composeRule.onNodeWithText("Recording is paused, so this room can't be set aside until you resume.").performScrollTo().assertExists()
        composeRule.onAllNodesWithContentDescription("Set this room aside").assertCountEquals(0)
    }
}
