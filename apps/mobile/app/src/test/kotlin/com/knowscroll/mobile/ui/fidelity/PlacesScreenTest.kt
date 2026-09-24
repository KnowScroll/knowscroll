package com.knowscroll.mobile.ui.fidelity

import android.provider.Settings
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import com.knowscroll.mobile.data.AtlasAnchor
import com.knowscroll.mobile.data.AtlasAttention
import com.knowscroll.mobile.data.AtlasBasis
import com.knowscroll.mobile.data.AtlasBridgeSupport
import com.knowscroll.mobile.data.AtlasChronicleEntry
import com.knowscroll.mobile.data.AtlasClaim
import com.knowscroll.mobile.data.AtlasDelta
import com.knowscroll.mobile.data.AtlasFoundation
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
import org.junit.Assert.assertTrue
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
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
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
        AtlasChronicleEntry(deltaId, planetId, null, "place_formed", "personal_exploration", "2026-09-23T00:00:00.000Z", "A place formed around Gravity."),
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
        // Review M2: the quiet line is additional, never a replacement for PR130's own label.
        composeRule.onNodeWithText("Orbits & moons are illustrative").assertExists()
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
        // Review M7: the label is truthful about what a tap does (opens the parent), and the touch
        // target is >=48dp even though the drawn dot stays small.
        val sightingNode = composeRule.onNodeWithContentDescription("Sighting: Star formation — near Gravity")
        sightingNode.assertExists()
        val bounds = sightingNode.getUnclippedBoundsInRoot()
        assertTrue((bounds.right - bounds.left) >= 48.dp && (bounds.bottom - bounds.top) >= 48.dp)
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

    /** ADR-0037: a foundation's marker says so, and its sheet names what it holds up and each
     * sourced connection behind that, never more than the atlas response carries. */
    @Test
    fun aFoundationsMarkerAndSheetShowWhatItHoldsUpAndTheClaimsThatSaySo() {
        val foundation = planet.copy(
            foundation = AtlasFoundation(
                listOf(otherPlanetId, regionId),
                listOf(
                    AtlasBasis("explains", "Gravity", "Light", AtlasClaim("Gravity bends light.", "NASA · Lensing"), null),
                    AtlasBasis("explains", "Gravity", "Tides", AtlasClaim("The Moon's gravity pulls on the ocean.", "NOAA · Tides"), null),
                ),
            ),
        )
        content(atlasState = AtlasState.Loaded(atlas.copy(places = listOf(foundation, region, sighting, otherPlanet))))
        composeRule.onNodeWithText("Foundation").assertExists()
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        // Selected, the planet still says so (review I3: the device journey checks it this way).
        composeRule.onNode(hasContentDescription("Enter continents on Gravity") and hasStateDescription("Foundation")).assertExists()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("Holds up Light and Tides").performScrollTo().assertExists()
        composeRule.onNodeWithText("Gravity explains Tides").performScrollTo().assertExists()
        composeRule.onNodeWithText("\"The Moon's gravity pulls on the ocean.\" — NOAA · Tides").performScrollTo().assertExists()
        // Gravity → Light is both a foundation connection and a relation between live places: it
        // is listed once, under the foundation, not again under Connections (device run 1).
        composeRule.onAllNodesWithText("Gravity explains Light").assertCountEquals(1)
    }

    @Test
    fun aPlaceThatIsNotAFoundationShowsNoHoldsUpSection() {
        content()
        composeRule.onAllNodesWithText("Foundation").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onAllNodesWithText("Holds up", substring = true).assertCountEquals(0)
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

    @Test
    fun aChronicleLinesTouchTargetIsAtLeast48dp() {
        content()
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        val bounds = composeRule.onNodeWithContentDescription("Show evidence: A place formed around Gravity.").getUnclippedBoundsInRoot()
        assertTrue((bounds.bottom - bounds.top) >= 48.dp)
    }

    @Test
    fun placesSubtitleCountsLivePlacesAndSightingsNotWorldsOrScrolls() {
        content()
        // planet + region + otherPlanet are live places; the one sighting is counted separately.
        composeRule.onNodeWithText("3 PLACES · 1 SIGHTING").assertExists()
        composeRule.onAllNodesWithText("WORLDS", substring = true).assertCountEquals(0)
    }

    @Test
    fun sourcesSubtitleIsUnchangedByThePlacesWork() {
        content(atlasState = AtlasState.Loaded(AtlasResponse("cartographer-v1", emptyList(), emptyList(), emptyList())))
        composeRule.onNodeWithText("1 WORLD · 3 SCROLLS RECORDED · 3 SEEN").assertExists()
    }

    @Test
    fun theOrbitsLabelAlwaysShowsForSourcesEvenWhenPlanetsExist() {
        // The atlas has a planet (Places would default), but the reader chose Sources manually --
        // review M2: PR130's own label is restored unconditionally, never only when there are no places yet.
        content()
        composeRule.onNodeWithContentDescription("Show Sources").performClick()
        composeRule.onNodeWithText("Orbits & moons are illustrative").assertExists()
    }

    @Test
    fun placesShowsItsOwnHonestPositionsLabelNeverTheSourcesWording() {
        content()
        composeRule.onNodeWithText("Positions, moons and land shapes are illustrative — what's mapped and how it connects is real.").assertExists()
        composeRule.onAllNodesWithText("Orbits & moons are illustrative").assertCountEquals(0)
    }

    @Test
    fun theListSheetOpensAPlaceAtAnyNestingDepthAndASightingsSheetHasNoSetAside() {
        val nestedRegion = AtlasPlace(
            placeId = "66666666-6666-6666-6666-666666666666", kind = "region", parentPlaceId = regionId,
            anchor = anchor("Neap tides"), basis = null, attention = AtlasAttention("seen", 1, 1, 1),
            scrolls = AtlasScrollCounts(1, 1), formedAt = "2026-09-23T00:00:00.000Z", formedBy = "place_formed",
        )
        val nestedSighting = AtlasPlace(
            placeId = "77777777-7777-7777-7777-777777777777", kind = "sighting", parentPlaceId = nestedRegion.placeId,
            anchor = anchor("Spin-orbit locking"),
            basis = AtlasBasis("explains", "Neap tides", "Spin-orbit locking", null, AtlasBridgeSupport("Tidal forces synchronise rotation.")),
            attention = null, scrolls = AtlasScrollCounts(0, 0), formedAt = "2026-09-24T00:00:00.000Z", formedBy = "sighting_appeared",
        )
        content(atlasState = AtlasState.Loaded(atlas.copy(places = atlas.places + nestedRegion + nestedSighting)))
        composeRule.onNodeWithText("List").performClick()
        // A region inside a region, and a sighting of it -- invisible to regionAreasOf/the map,
        // but always reachable from the list regardless of nesting depth (review I3).
        composeRule.onNodeWithText("Region: Neap tides").assertExists()
        composeRule.onNodeWithText("Sighting: Spin-orbit locking").assertExists()
        composeRule.onNodeWithText("Sighting: Spin-orbit locking").performClick()
        composeRule.onNodeWithText("Neap tides explains Spin-orbit locking").assertExists()
        composeRule.onNodeWithText("Tidal forces synchronise rotation.").assertExists()
        // The server refuses to set a sighting aside -- its own sheet never offers to.
        composeRule.onAllNodesWithContentDescription("Set Spin-orbit locking aside").assertCountEquals(0)
    }

    @Test
    fun recentChangesListsEveryChronicleLineAndOpensItsEvidence() {
        var opened: String? = null
        content(onOpenEvidence = { opened = it })
        composeRule.onNodeWithText("List").performClick()
        composeRule.onNodeWithText("Recent changes").assertExists()
        composeRule.onNodeWithText("A place formed around Gravity.").performClick()
        assertEquals(deltaId, opened)
    }

    /** Review I4: the exact scenario named -- select a Sources world, leave for the reader (system
     * Back from there returns via a *fresh* mount of `SystemScreen`, same as `KnowScrollApp.kt`'s
     * own `when(screen)` swap), and the selection (and its open sheet) survive the round trip. */
    @Test
    fun sourcesSelectionSurvivesLeavingForTheReaderAndReturning() {
        var showSystem by mutableStateOf(true)
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        composeRule.setContent {
            KnowScrollTheme {
                val holder = rememberSaveableStateHolder()
                if (showSystem) {
                    holder.SaveableStateProvider("system") {
                        SystemScreen(
                            state = loadedWorlds, onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {},
                        )
                    }
                } else Text("Elsewhere (the reader)")
            }
        }
        composeRule.onNodeWithContentDescription("Explore world: NASA · Gravity pulls").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("3 of 3 Scrolls encountered").assertExists()

        showSystem = false
        composeRule.waitForIdle()
        showSystem = true
        composeRule.waitForIdle()

        // No re-selection needed: the world and its open sheet are exactly as they were.
        composeRule.onNodeWithText("3 of 3 Scrolls encountered").assertExists()
    }

    /** Review I4 (AppViewModel's own fix): a same-scope refresh -- e.g. on return from the reader --
     * delivers `Loaded -> Loaded` directly, never a `Loading` in between for data that is already
     * there. This pins that `SystemScreen` handles that correctly: the selection and its open sheet
     * survive, and the sheet reflects the refreshed data, with no re-selection. */
    @Test
    fun aRefreshDeliveringLoadedDirectlyKeepsTheSelectedPlaceAndItsSheet() {
        var atlasState by mutableStateOf<AtlasState>(AtlasState.Loaded(atlas))
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = loadedWorlds, atlasState = atlasState,
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {},
                )
            }
        }
        composeRule.onNodeWithContentDescription("Explore place: Gravity").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("Gravity description").assertExists()
        composeRule.onNodeWithText("2 of 3 Scrolls read").assertExists()

        val refreshedPlanet = planet.copy(scrolls = AtlasScrollCounts(total = 4, seen = 4))
        atlasState = AtlasState.Loaded(atlas.copy(places = listOf(refreshedPlanet, region, sighting, otherPlanet)))
        composeRule.waitForIdle()

        // No re-selection needed, and the sheet already reflects the refreshed data.
        composeRule.onNodeWithText("Gravity description").assertExists()
        composeRule.onNodeWithText("4 of 4 Scrolls read").assertExists()
    }

    /** Review I4: while a first load/refresh is in flight or has failed, the Places map is never
     * mounted with empty data (no false "0 PLACES"), and a failure shows the real error with Retry
     * -- reusing this screen's own [onRetry]. The layer stays Places (cached from the earlier
     * Loaded response), never silently falling back to Sources. */
    @Test
    fun aFailedAtlasFetchShowsTheErrorAndRetryNeverAFalseZeroPlaces() {
        var atlasState by mutableStateOf<AtlasState>(AtlasState.Loaded(atlas))
        var retried = false
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = loadedWorlds, atlasState = atlasState,
                    onReturn = {}, onRetry = { retried = true }, onEnterScroll = {}, onOpenKeep = {},
                )
            }
        }
        composeRule.onNodeWithText("3 PLACES · 1 SIGHTING").assertExists()

        atlasState = AtlasState.Unavailable("Connection interrupted. Please retry; your action keeps the same identity.")
        composeRule.waitForIdle()

        composeRule.onNodeWithText("Connection interrupted. Please retry; your action keeps the same identity.").assertExists()
        composeRule.onAllNodesWithText("PLACES", substring = true).assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Retry loading your places").performClick()
        assertEquals(true, retried)
    }

    @Test
    fun whileLoadingThePlacesMapIsNotMountedAndNoFalseCountShows() {
        var atlasState by mutableStateOf<AtlasState>(AtlasState.Loaded(atlas))
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = loadedWorlds, atlasState = atlasState,
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {},
                )
            }
        }
        composeRule.onNodeWithText("3 PLACES · 1 SIGHTING").assertExists()

        atlasState = AtlasState.Loading
        composeRule.waitForIdle()

        composeRule.onNodeWithText("Loading your places…").assertExists()
        composeRule.onAllNodesWithText("PLACES", substring = true).assertCountEquals(0)
        composeRule.onAllNodesWithContentDescription("Explore place: Gravity", substring = true).assertCountEquals(0)
    }
}
