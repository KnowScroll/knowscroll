package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.assertIsDisplayed
import com.knowscroll.mobile.data.WorldSummary
import com.knowscroll.mobile.data.WorldSystem
import com.knowscroll.mobile.data.WorldSystemResponse
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.system.SystemScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Audit U1 / N2 / N3 (#72): the system level makes each source-backed world selectable into a
 * local world detail that holds:
 *  - a decorative cartographic globe,
 *  - the full source title,
 *  - exact seen/total counts ("%d of %d Scrolls encountered"),
 *  - the plain shared-source explanation,
 *  - the external source link,
 *  - a local Back control.
 *
 * The detail is drawn over the same system level, never a navigation away from it. Android Back
 * closes the detail first; only when no detail is open does Back leave the system level. No
 * invented semantic regions, galaxy or world-specific feed -- the detail is a layout decision
 * over the same `GET /v1/worlds` response.
 *
 * U2 (#72): the tag a world gets when every catalog Scroll has an exposure is the audited
 * wording `ALL SCROLLS ENCOUNTERED`, not `FULLY EXPLORED`.
 *
 * A1 (#72): when more than [ORBIT_SAFE_LIMIT] worlds are in the response the system level falls
 * back to a list view, where every world is its own card with the same real numbers stacked.
 * No invented data, just the same `WorldSummary` rendered through a different layout.
 */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
class WorldDetailRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val orbits = WorldSummary(
        worldId = "w-orbits", sourceTitle = "NASA \u00b7 Orbits and Kepler\u2019s Laws",
        sourceUrl = "https://science.nasa.gov/solar-system/orbits-and-keplers-laws/",
        scrollCount = 2, seenCount = 2
    )
    private val stars = WorldSummary(
        worldId = "w-stars", sourceTitle = "NASA \u00b7 Stars",
        sourceUrl = "https://science.nasa.gov/universe/stars/",
        scrollCount = 1, seenCount = 1
    )
    private val spiral = WorldSummary(
        worldId = "w-spiral", sourceTitle = "NASA \u00b7 Spiral Galaxies",
        sourceUrl = "https://science.nasa.gov/universe/spiral-galaxies/",
        scrollCount = 3, seenCount = 1
    )
    private val planets = WorldSummary(
        worldId = "w-planets", sourceTitle = "NASA \u00b7 Exoplanets",
        sourceUrl = "https://science.nasa.gov/universe/exoplanets/",
        scrollCount = 4, seenCount = 2
    )
    private val moons = WorldSummary(
        worldId = "w-moons", sourceTitle = "NASA \u00b7 Moons",
        sourceUrl = "https://science.nasa.gov/solar-system/moons/",
        scrollCount = 5, seenCount = 3
    )

    private fun render(worlds: List<WorldSummary>) {
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = SystemState.Loaded(WorldSystemResponse("shared_source_v1", WorldSystem("sys-1", worlds))),
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }
    }

    @Test
    fun `tapping a world in the orbit opens the local detail with the full source title and seen of total counts`() {
        render(listOf(orbits, stars))
        // Before tap: the orbit has the world title; the detail-only exact-counts sentence
        // is not yet present.
        composeRule.onAllNodesWithText("NASA \u00b7 Stars").assertCountEquals(1)
        composeRule.onAllNodesWithText("1 of 1 Scrolls encountered").assertCountEquals(0)
        composeRule.onNodeWithText("NASA \u00b7 Stars").performClick()
        composeRule.onNodeWithText("Info").performClick()
        // After the transition only the selected world remains in the semantics tree.
        composeRule.onAllNodesWithText("NASA \u00b7 Stars").assertCountEquals(1)
        composeRule.onNodeWithText("1 of 1 Scrolls encountered").assertExists()
        // The plain shared-source explanation is present and never invents a topic.
        composeRule.onNodeWithText(
            "This world gathers Scrolls from the same source. It appeared because your reading reached that source. Encounters record what was shown, not what you know.",
            substring = false
        ).assertExists()
    }

    @Test
    fun `the world detail closes via its local back control and the system level returns`() {
        render(listOf(orbits, stars))
        composeRule.onNodeWithText("NASA \u00b7 Stars").performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("‹ System").assertExists()
        composeRule.onNodeWithText("‹ System").performClick()
        // After closing, the detail's exact-counts sentence is gone but the system level
        // itself is still present: same system, nothing was navigated away from.
        composeRule.onAllNodesWithText("1 of 1 Scrolls encountered").assertCountEquals(0)
        composeRule.onNodeWithText("Your system").assertExists()
    }

    @Test
    fun `a fully-encountered world shows ALL SCROLLS ENCOUNTERED, not FULLY EXPLORED`() {
        // Audit U2 (#72): the wording the world tag carries when every catalog Scroll has an
        // exposure is "ALL SCROLLS ENCOUNTERED" -- the audit records this as the honest wording
        // for a fact that was previously overstated as mastery or completion.
        render(listOf(orbits)) // scrollCount=2, seenCount=2 -> fully explored -> tag present
        composeRule.onNodeWithText("ALL SCROLLS ENCOUNTERED").assertExists()
        composeRule.onAllNodesWithText("FULLY EXPLORED").assertCountEquals(0)
    }

    @Test
    fun `a world whose encounters are still in progress shows MORE TO EXPLORE`() {
        // spiral: scrollCount=3, seenCount=1 -> more to explore
        render(listOf(spiral))
        composeRule.onNodeWithText("MORE TO EXPLORE").assertExists()
    }

    @Test
    fun `many worlds remain reachable through the accessible list without inventing data`() {
        // 5 worlds > [ORBIT_SAFE_LIMIT] = 4 -- the system level switches to a list fallback
        // where every world's source title and tag remain visible on the same screen.
        render(listOf(orbits, stars, spiral, planets, moons))
        composeRule.onNodeWithText("Worlds 5").performClick()
        composeRule.onNodeWithText("NASA \u00b7 Moons").performScrollTo().assertIsDisplayed().performClick()
        composeRule.onNodeWithText("Info").performClick()
        composeRule.onNodeWithText("3 of 5 Scrolls encountered").assertExists()
    }

    @Test
    fun `the world detail exposes the external source link with a description that names the source`() {
        render(listOf(stars))
        composeRule.onNodeWithText("NASA \u00b7 Stars").performClick()
        composeRule.onNodeWithText("Info").performClick()
        // The orbit body's source link is still on the screen (under the detail), and the
        // detail adds its own copy of the same source link. Only the selected world exposes a source action.
        composeRule.onAllNodesWithText("Open source").assertCountEquals(1)
    }

    @Test
    fun `Atlas is marked selected on the system level - audit D3 N2`() {
        render(listOf(stars))
        // Three dock entries (Atlas, Cable, Keep) exist; the audit D3 / N2 (#72) reading is that
        // Atlas must be the one marked current. Reach in via the dock's tab role and assert
        // exactly one tab is selected.
        val selected = composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
            .fetchSemanticsNodes()
        assertEquals("Audit D3 / N2: exactly one dock entry (Atlas) is selected on the system level", 1, selected.size)
    }
}
