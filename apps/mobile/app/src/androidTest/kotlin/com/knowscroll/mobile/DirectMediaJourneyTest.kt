package com.knowscroll.mobile

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.*
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Actual guarded MP4 playback and epoch fences, without committing personal frames. */
class DirectMediaJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun waitText(s: String) =
        compose.waitUntil(25000) {
            compose.onAllNodesWithText(s).fetchSemanticsNodes().isNotEmpty()
        }

    private fun waitNode(s: String) =
        compose.waitUntil(25000) {
            compose.onAllNodesWithContentDescription(s).fetchSemanticsNodes().isNotEmpty()
        }

    private fun back() {
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
    }

    @Test
    fun mediaOriginAndPrivacy() =
        runBlocking<Unit> {
            check(
                InstrumentationRegistry.getInstrumentation()
                    .targetContext
                    .packageName
                    .endsWith(".journey")
            )
            waitText("Authored Atlas")
            compose.onNodeWithText("Authored Atlas").performClick()
            waitNode("Enter authored system")
            compose.onNodeWithContentDescription("Enter authored system").performClick()
            waitNode("Explore world: Supplied demos")
            compose.onNodeWithContentDescription("Explore world: Supplied demos").performClick()
            waitNode("Enter continents on Supplied demos")
            compose
                .onNodeWithContentDescription("Enter continents on Supplied demos")
                .performClick()
            waitNode("Explore authored region: North coast")
            compose
                .onNodeWithContentDescription("Explore authored region: North coast")
                .performClick()
            val topic =
                SemanticsMatcher("supplied topic") {
                    it.config
                        .getOrElse(SemanticsProperties.ContentDescription) { emptyList() }
                        .any { s -> s.startsWith("Topic: ") }
                }
            compose.waitUntil(25000) {
                compose.onAllNodes(topic).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onAllNodes(topic)[0].performClick()
            waitText("Open")
            val origin =
                compose
                    .onNodeWithContentDescription("Spatial atlas")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription]
            compose.onNodeWithText("Open").performClick()
            waitNode("Reel video")
            compose.waitUntil(25000) {
                compose
                    .onNodeWithContentDescription("Reel video")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription] == "Playing"
            }
            compose.onNodeWithText("Pause").performClick()
            compose.onNodeWithText("Play").assertExists()
            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            waitNode("Reel video")
            waitText("Play")
            back()
            waitText("Open")
            assertEquals(
                origin,
                compose
                    .onNodeWithContentDescription("Spatial atlas")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription],
            )
            compose.onNodeWithText("Open").performClick()
            waitNode("Reel video")
            waitText("Play")
            // Clear only this runner's disposable universe while hidden, then reject all old state.
            val api = ApiClient()
            val before = api.getUniverse()
            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            api.clearScrollHistory(
                HistoryClearRequest(
                    requestId = UUID.randomUUID().toString(),
                    expectedPrivacyEpoch = before.privacyEpoch,
                    universeId = before.universeId,
                )
            )
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            waitText("Authored Atlas")
            compose.onAllNodesWithContentDescription("Reel video").assertCountEquals(0)
            compose.activityRule.scenario.recreate()
            waitText("Authored Atlas")
            compose.onNodeWithText("Authored Atlas").performClick()
            waitNode("Enter authored system")
            compose.onAllNodesWithText("Open").assertCountEquals(0)
        }
}
