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
import com.knowscroll.mobile.data.AtlasBasis
import com.knowscroll.mobile.data.AtlasChronicleEntry
import com.knowscroll.mobile.data.AtlasClaim
import com.knowscroll.mobile.data.AtlasDelta
import com.knowscroll.mobile.data.AtlasPlace
import com.knowscroll.mobile.data.AtlasRelation
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.data.AtlasScrollCounts
import com.knowscroll.mobile.data.WorldSummary
import com.knowscroll.mobile.data.WorldSystem
import com.knowscroll.mobile.data.WorldSystemResponse
import com.knowscroll.mobile.ui.AtlasEvidenceState
import com.knowscroll.mobile.ui.AtlasState
import com.knowscroll.mobile.ui.PlaceRejectState
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.system.SystemScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #134 — the reader's live places (ADR-0036) as a second System-screen layer. These pin: Places is
 * the default once a planet exists, otherwise Sources with a quiet explanation; a planet/region/
 * sighting render with their real counts and labels; the place sheet shows only what the atlas
 * response actually carries; a chronicle line's evidence and "Set aside" call back to the exact
 * viewmodel entry points the coordinator's journey drives; and the Places layer never shows the
 * "AUTHORED"/"Illustrative geography" wording that Sources still does.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PlacesScreenTest {
    @get:Rule val composeRule = createComposeRule()

    private val world = WorldSummary("w-1", "NASA · Gravity pulls", "https://example.test/gravity", 3, 3)
    private val loadedWorlds = SystemState.Loaded(WorldSystemResponse("shared_source_v1", WorldSystem("sys-1", listOf(world))))

    private val planetId = "11111111-1111-1111-1111-111111111111"
    private val regionId = "44444444-4444-4444-4444-444444444444"
    private val sightingId = "22222222-2222-2222-2222-222222222222"
    private val deltaId = "33333333-3333-3333-3333-333333333333"
    private val otherPlanetId = "55555555-5555-5555-5555-555555555555"

    private fun anchor(name: String) = AtlasAnchor("c.$name", name, "$name description")

    private val planet = AtlasPlace(
        placeId = planetId, kind = "planet", parentPlaceId = null, anchor = anchor("Gravity"),
        basis = null, attention = AtlasAttention("anchored", 3, 2, 2), scrolls = AtlasScrollCounts(3, 2),
        formedAt = "2026-09-23T00:00:00.000Z", formedBy = "place_formed",
    )
    private val region = AtlasPlace(
        placeId = regionId, kind = "region", parentPlaceId = planetId, anchor = anchor("Tides"),
        basis = null, attention = AtlasAttention("seen", 1, 1, 1), scrolls = AtlasScrollCounts(1, 1),
        formedAt = "2026-09-23T00:00:00.000Z", formedBy = "place_formed",
    )
    private val sighting = AtlasPlace(
        placeId = sightingId, kind = "sighting", parentPlaceId = planetId, anchor = anchor("Star formation"),
        basis = AtlasBasis("explains", "Gravity", "Star formation", AtlasClaim("Gravity pulls gas clouds together.", "NASA · Star formation"), null),
        attention = null, scrolls = AtlasScrollCounts(0, 0),
        formedAt = "2026-09-24T00:00:00.000Z", formedBy = "sighting_appeared",
    )
    private val otherPlanet = AtlasPlace(
        placeId = otherPlanetId, kind = "planet", parentPlaceId = null, anchor = anchor("Light"),
        basis = null, attention = AtlasAttention("anchored", 3, 2, 2), scrolls = AtlasScrollCounts(2, 2),
        formedAt = "2026-09-23T00:00:00.000Z", formedBy = "place_formed",
    )
    private val relation = AtlasRelation(planetId, otherPlanetId, "explains", AtlasClaim("Gravity bends light.", "NASA · Lensing"), null)
    private val chronicle = listOf(
        AtlasChronicleEntry(deltaId, planetId, "place_formed", "personal_exploration", "2026-09-23T00:00:00.000Z", "A place formed around Gravity."),
    )
    private val atlas = AtlasResponse("cartographer-v1", listOf(planet, region, sighting, otherPlanet), listOf(relation), chronicle)

    private fun content(atlasState: AtlasState = AtlasState.Loaded(atlas), rejectState: PlaceRejectState = PlaceRejectState.Idle,
                         evidenceState: AtlasEvidenceState = AtlasEvidenceState.Idle, onRequestSetAside: (String) -> Unit = {},
                         onCancelSetAside: () -> Unit = {}, onConfirmSetAside: () -> Unit = {}, onOpenEvidence: (String) -> Unit = {}) {
        // Deterministic, immediate camera/level transitions -- the reduced-motion path
        // (docs/product/ui-system.md sec.4b) never sets `travelling`, so a level change is visible
        // the moment the click that caused it settles, with no animation timing to race against.
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = loadedWorlds, atlasState = atlasState, placeRejectState = rejectState, evidenceState = evidenceState,
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {},
                    onRequestSetAside = onRequestSetAside, onCancelSetAside = onCancelSetAside, onConfirmSetAside = onConfirmSetAside,
                    onOpenEvidence = onOpenEvidence,
                )
            }
        }
    }

    @Test
    fun placesIsTheDefaultOnceAPlanetExists() {
        content()
        composeRule.onNodeWithContentDescription("Explore place: Gravity").assertExists()
        composeRule.onNodeWithContentDescription("Places, selected").assertExists()
        composeRule.onNodeWithContentDescription("Show Sources").assertExists()
    }

    @Test
    fun sourcesIsTheDefaultWithAQuietLineWhenThereAreNoPlanetsYet() {
        content(atlasState = AtlasState.Loaded(AtlasResponse("cartographer-v1", emptyList(), emptyList(), emptyList())))
        composeRule.onNodeWithContentDescription("Explore world: NASA · Gravity pulls").assertExists()
        composeRule.onNodeWithText("Places form when you come back to a subject on different days.").assertExists()
    }

    @Test
    fun aPlanetMarkerCarriesItsRealCounts() {
        content()
        composeRule.onNodeWithText("2 of 3 Scrolls read").assertExists()
    }

    /** Selects the named planet, waits for the camera's own level state to settle on "planet" (its
     * translucent "enter continents" hit area only composes then -- immediate under the
     * reduced-motion path [content] sets, but still a real recomposition to wait out), then enters
     * continents. Mirrors the device journeys' own `compose.waitUntil` idiom. */
    private fun enterContinents(title: String) {
        composeRule.onNodeWithContentDescription("Explore place: $title").performClick()
        composeRule.waitUntil(3_000) {
            composeRule.onAllNodesWithContentDescription("Enter continents on $title").fetchSemanticsNodes().isNotEmpty()
        }
        // The precisely-sized "Zoom in" control (not the huge full-planet hit area, which this
        // small Robolectric window is smaller than, so a raw touch dispatch at its centre can land
        // on the top bar instead) also enters continents at the planet level.
        composeRule.onNodeWithContentDescription("Zoom in").performClick()
        composeRule.waitUntil(3_000) {
            composeRule.onAllNodesWithContentDescription("Enter continents on $title").fetchSemanticsNodes().isEmpty()
        }
    }

    @Test
    fun aSightingIsFaintNextToItsParentAndARegionAppearsAtTheContinentsLevel() {
        content()
        composeRule.onNodeWithContentDescription("Sighting near Gravity: Star formation").assertExists()
        enterContinents("Gravity")
        composeRule.onNodeWithContentDescription("Explore region: Tides").assertExists()
    }

    @Test
    fun theContinentsLevelNeverShowsTheAuthoredWordingInPlaces() {
        content()
        enterContinents("Gravity")
        composeRule.onNodeWithText("Tap a region").assertExists()
        composeRule.onAllNodesWithText("AUTHORED GEOGRAPHY", substring = true).assertCountEquals(0)
        composeRule.onAllNodesWithText("Illustrative geography", substring = true).assertCountEquals(0)
    }

    @Test
    fun aPlanetWithNoRegionsShowsItsOwnAreaAndAQuietLine() {
        content(atlasState = AtlasState.Loaded(atlas.copy(places = listOf(planet), relations = emptyList())))
        enterContinents("Gravity")
        composeRule.onNodeWithText("No regions yet — a region forms when you anchor a narrower subject.").assertExists()
    }

    @Test
    fun thePlaceSheetShowsDescriptionCountsSightingsRelationsAndChronicle() {
        content()
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("Gravity description").assertExists()
        composeRule.onNodeWithText("Read on 2 days · 2 sources").assertExists()
        composeRule.onNodeWithText("2 of 3 Scrolls read").assertExists()
        composeRule.onNodeWithText("Gravity explains Star formation").assertExists()
        composeRule.onNodeWithText("\"Gravity pulls gas clouds together.\" — NASA · Star formation").assertExists()
        composeRule.onNodeWithText("Gravity explains Light").assertExists()
        composeRule.onNodeWithText("A place formed around Gravity.").assertExists()
    }

    @Test
    fun tappingAChronicleLineAsksTheViewModelForItsEvidence() {
        var opened: String? = null
        content(onOpenEvidence = { opened = it })
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("A place formed around Gravity.").performScrollTo().performClick()
        assertEquals(deltaId, opened)
    }

    @Test
    fun loadedEvidenceShowsTheNumbersForAPlaceFormedDelta() {
        val delta = AtlasDelta(
            deltaId, planetId, "place_formed", "personal_exploration", "cartographer-v1", "2026-09-23T00:00:00.000Z",
            "c.Gravity", "Gravity", null, mapOf("kind" to "planet"),
            mapOf("account" to mapOf("episodes" to 3, "daysActive" to 2, "sourceFamilies" to 2)),
        )
        content(evidenceState = AtlasEvidenceState.Loaded(deltaId, delta))
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("Formed from 3 readings across 2 days and 2 source families.").assertExists()
    }

    @Test
    fun setAsideAsksTheViewModelBeforeAnythingIsSent() {
        var requested: String? = null
        content(onRequestSetAside = { requested = it })
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithContentDescription("Set Gravity aside").performScrollTo().performClick()
        assertEquals(planetId, requested)
    }

    @Test
    fun theConfirmationStepShowsTheExactWordingAndConfirmingCallsTheApi() {
        var confirmed = false
        content(rejectState = PlaceRejectState.Confirming(planetId), onConfirmSetAside = { confirmed = true })
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("Set Gravity aside? It won't form again unless you clear your history.").assertExists()
        composeRule.onNodeWithContentDescription("Confirm setting Gravity aside").performScrollTo().performClick()
        assertEquals(true, confirmed)
    }

    @Test
    fun cancellingTheConfirmationNeverCallsTheApi() {
        var confirmed = false
        var cancelled = false
        content(rejectState = PlaceRejectState.Confirming(planetId), onConfirmSetAside = { confirmed = true }, onCancelSetAside = { cancelled = true })
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithContentDescription("Cancel setting aside").performScrollTo().performClick()
        assertEquals(false, confirmed)
        assertEquals(true, cancelled)
    }
}
