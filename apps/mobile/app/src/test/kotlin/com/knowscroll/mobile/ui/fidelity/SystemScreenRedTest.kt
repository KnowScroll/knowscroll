package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.knowscroll.mobile.data.WorldSummary
import com.knowscroll.mobile.data.WorldSystem
import com.knowscroll.mobile.data.WorldSystemResponse
import com.knowscroll.mobile.ui.SystemState
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
 * read straight off the fixture `WorldSystemResponse`, never a number this client computed,
 * rounded or derived on its own.
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
    fun `the dock marks no entry current on a level that is not one of its destinations`() {
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

        // But none of them is marked current. System is reached from Atlas and returns to it, and
        // is still not Atlas: `Role.Tab`'s selected state is what a screen reader announces as
        // "selected", so marking Atlas here would tell the reader they are somewhere they are not.
        val selected = composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
            .fetchSemanticsNodes()
        assertEquals("no dock entry may be marked current on the system level", 0, selected.size)
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

    @Test
    fun `a loaded system draws the real source titles, counts and derivation line, never invented ones`() {
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
                    onReturn = {}, onRetry = {}, onEnterScroll = {}, onOpenKeep = {}
                )
            }
        }
        // The real source titles, verbatim -- never a topic this client invented.
        composeRule.onNodeWithText("NASA · Orbits and Kepler’s Laws").assertExists()
        composeRule.onNodeWithText("NASA · Stars").assertExists()
        // The real per-world counts, exactly as the fixture response carries them.
        composeRule.onNodeWithText("2 SCROLLS · 1 SEEN").assertExists()
        composeRule.onNodeWithText("1 SCROLL · 1 SEEN").assertExists()
        // scrollCount(1)==seenCount(1) and >0 -> fully explored; scrollCount(2)>seenCount(1) -> more to explore.
        composeRule.onNodeWithText("FULLY EXPLORED").assertExists()
        composeRule.onNodeWithText("MORE TO EXPLORE").assertExists()
        // The subtitle line is a straight sum of the two real worlds' own counts: 2 worlds,
        // 2+1=3 scrolls recorded, 1+1=2 seen -- never a number this client derived independently.
        composeRule.onNodeWithText("2 WORLDS · 3 SCROLLS RECORDED · 2 SEEN").assertExists()
        // Methodology copy, not a data value -- present, but never claims a ranking or inference.
        composeRule.onNodeWithText("Derived from recorded sources, never inferred").assertExists()
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
