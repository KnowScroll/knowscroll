package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.data.WorldSummary
import com.knowscroll.mobile.data.WorldSystem
import com.knowscroll.mobile.data.WorldSystemResponse
import com.knowscroll.mobile.ui.AtlasState
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.assertNoSourceShown
import com.knowscroll.mobile.ui.system.SystemScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.junit.runner.RunWith

/**
 * The system level (#116, ADR-0028/#113), docs/product/ui-system.md sec.5b/5c: "stand a screen
 * beside the reference and it is recognisably the same thing", and this issue's own honesty rule
 * -- "every name and number on screen comes from the response. Invent nothing." These tests pin
 * that every string the empty and loaded states draw is either literal product copy or a value
 * read straight off a fixture response, never a number this client computed, rounded or derived on
 * its own.
 *
 * `SystemScreen.kt`, `SystemState` and the `WorldSummary`/`WorldSystem`/`WorldSystemResponse`
 * wire types did not exist before this lane -- run directly against the pre-#116 source, the
 * whole module fails to compile, which is the strongest possible red (nothing here could pass by
 * accident). The receipt this test file ships with records that compile-failure verbatim.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SystemScreenRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun `the dock marks Atlas current because the system level is reached from Atlas and returns to it`() {
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = SystemState.Loaded(
                        WorldSystemResponse(
                            "shared_source_v1",
                            WorldSystem(
                                "system-1",
                                listOf(WorldSummary("w-1", "NASA \u00b7 Stars", "https://example.com/stars", 1, 1)),
                            ),
                        ),
                    ),
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }

        // The dock is still drawn and still navigates -- all three destinations are present.
        composeRule.onNodeWithText("Atlas").assertExists()
        composeRule.onNodeWithText("Cable").assertExists()
        composeRule.onNodeWithText("Keep").assertExists()

        // Audit D3 / N2 (#72): Atlas is now marked selected on the system level because the
        // level is reached from Atlas and returns to it. The previous "no selected tab" rule
        // read the opposite of the audit's #121/#122 reading (a screen reader on System heard
        // "no tab current" -- which is exactly the wrong message for a level nested under
        // Atlas). The single atlas tab is now the only one marked `Selected == true`.
        val selected = composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
            .fetchSemanticsNodes()
        assertEquals(
            "audit D3/N2: the system level must mark Atlas current, not nothing",
            1, selected.size
        )
    }

    @Test
    fun `the empty system says nothing has been encountered yet, not an error`() {
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = SystemState.Loaded(WorldSystemResponse("shared_source_v1", system = null)),
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }
        composeRule.onNodeWithText("Nothing has been encountered yet").assertExists()
    }

    /** #161: a world is one source, and its only name is that source's -- so a loaded system never
     * draws one, nor its counts; the reader's own places are the map. */
    @Test
    fun `a loaded system never names a world's source, only the reader's places`() {
        val orbits = WorldSummary(
            worldId = "w-orbits", sourceTitle = "NASA · Orbits and Kepler’s Laws",
            sourceUrl = "https://science.nasa.gov/solar-system/orbits-and-keplers-laws/",
            scrollCount = 2, seenCount = 1
        )
        val stars = WorldSummary(
            worldId = "w-stars", sourceTitle = "NASA · Stars",
            sourceUrl = "https://science.nasa.gov/universe/stars/",
            scrollCount = 1, seenCount = 1
        )
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = SystemState.Loaded(WorldSystemResponse("shared_source_v1", WorldSystem("sys-1", listOf(orbits, stars)))),
                    atlasState = AtlasState.Loaded(AtlasResponse("cartographer-v1", emptyList(), emptyList(), emptyList())),
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }
        composeRule.assertNoSourceShown(orbits.sourceTitle, orbits.sourceUrl, stars.sourceTitle, stars.sourceUrl)
        composeRule.onAllNodesWithContentDescription("Explore world:", substring = true).assertCountEquals(0)
        composeRule.onAllNodesWithText("SEEN", substring = true).assertCountEquals(0)
        composeRule.onAllNodesWithText("WORLD", substring = true).assertCountEquals(0)
        // The reader's own places, counted straight off the atlas response.
        composeRule.onNodeWithText("0 PLACES · 0 SIGHTINGS").assertExists()
        // Methodology copy, not a data value -- present, but never claims a ranking or inference.
        composeRule.onNodeWithText("Your atlas").assertExists()
        // No invented "DAY n" pill, ranking, or progress bar exists anywhere on this level.
        composeRule.onAllNodesWithText("DAY", substring = true).assertCountEquals(0)
    }

    @Test
    fun `the unavailable state shows the real error message and never fabricates a system`() {
        composeRule.setContent {
            KnowScrollTheme {
                SystemScreen(
                    state = SystemState.Unavailable("Connection interrupted. Please retry; your action keeps the same identity."),
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }
        composeRule.onNodeWithText("The system is unavailable").assertExists()
        composeRule.onNodeWithText("Connection interrupted. Please retry; your action keeps the same identity.").assertExists()
    }
}
