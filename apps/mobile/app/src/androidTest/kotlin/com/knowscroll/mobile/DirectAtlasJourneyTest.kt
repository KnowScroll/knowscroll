package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DirectAtlasJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private fun text(s: String) = compose.onNodeWithText(s)

    private fun node(s: String) = compose.onNodeWithContentDescription(s)

    private fun waitText(s: String) =
        compose.waitUntil(25000) {
            compose.onAllNodesWithText(s).fetchSemanticsNodes().isNotEmpty()
        }

    private fun waitNode(s: String) =
        compose.waitUntil(25000) {
            compose.onAllNodesWithContentDescription(s).fetchSemanticsNodes().isNotEmpty()
        }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(800)
        compose.waitForIdle()
    }

    private fun pose() =
        node("Spatial atlas").fetchSemanticsNode().config[SemanticsProperties.StateDescription]

    private fun back() {
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        settle()
    }

    private fun shot(name: String) {
        settle()
        instrumentation.uiAutomation.takeScreenshot().let { b ->
            File(instrumentation.targetContext.filesDir, "direct-$name.png").outputStream().use {
                b.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }

    @Test
    fun ownerRouteAndExactReturn() {
        check(instrumentation.targetContext.packageName.endsWith(".journey"))
        try {
            waitText("Authored Atlas")
            shot("universe")
            text("Authored Atlas").performClick()
            waitNode("Enter authored system")
            shot("preview-universe")
            node("Enter authored system").performClick()
            waitText("Planets 3")
            settle()
            shot("system")
            val system = pose()
            node("Explore world: Orbits").performTouchInput { click() }
            settle()
            shot("planet")
            waitNode("Enter continents on Orbits")
            node("Enter continents on Orbits").performTouchInput {
                // The visible rim must be tappable as well as the globe centre.
                click(center + Offset(center.x * .72f, 0f))
            }
            waitText("Continents & coastlines")
            settle()
            shot("continents")
            val continents = pose()
            node("Explore authored region: North coast").performTouchInput { click() }
            waitText("North coast · local detail")
            settle()
            shot("region")
            node("Topic: Why does an orbit keep falling?").performTouchInput { click() }
            waitText("Open")
            shot("topic")
            val origin = pose()
            text("Open").performClick()
            waitNode("Preview Scroll reading")
            shot("scroll")
            node("Preview Scroll reading").performTouchInput { swipeUp() }
            val reading =
                node("Preview Scroll reading")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription]
            text("Change speed →").performClick()
            waitText("What changes when speed changes?")
            back()
            waitText("Why does an orbit keep falling?")
            assertEquals(
                reading,
                node("Preview Scroll reading")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription],
            )
            back()
            waitText("Open")
            assertEquals(origin, pose())
            shot("return")
            compose.activityRule.scenario.recreate()
            waitText("Open")
            settle()
            assertEquals(origin, pose())
            back()
            back()
            assertEquals(continents, pose())
            back()
            waitNode("Enter continents on Orbits")
            // Real two-pointer Compose input, anchored at the selected globe.
            node("Spatial atlas").performTouchInput {
                pinch(
                    center - Offset(25f, 0f),
                    center - Offset(85f, 0f),
                    center + Offset(25f, 0f),
                    center + Offset(85f, 0f),
                )
            }
            waitText("Continents & coastlines")
            // The same gesture must continue beyond the level boundary, without a new down.
            assertTrue(pose().substringAfter("Zoom ").substringBefore(" percent").toInt() > 500)
            back()
            back()
            assertEquals(system, pose())
            if (
                android.provider.Settings.Global.getFloat(
                    instrumentation.targetContext.contentResolver,
                    android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
                    1f,
                ) > 0f
            ) {
                compose.mainClock.autoAdvance = false
                try {
                    node("Explore world: Orbits").performTouchInput { click() }
                    compose.mainClock.advanceTimeBy(96)
                    node("Explore world: Models").performTouchInput { click() }
                } finally {
                    compose.mainClock.autoAdvance = true
                }
                settle()
                waitNode("Enter continents on Models")
                back()
                assertEquals(system, pose())
            }
            // Retarget and interrupt through the accessible equivalent, without awaiting a flight.
            node("Explore world: Models").performClick()
            back()
            waitText("Planets 3")
            node("Explore world: Orbits").performClick()
            settle()
            compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            text("List").performClick()
            waitText("YOUR PLANETS")
            text("Models").performClick()
            settle()
            back()
            assertEquals(system, pose())
            node("Explore world: Orbits").performClick()
            text("List").performClick()
            waitText("YOUR PLANETS")
            text("Models").performClick()
            settle()
            waitNode("Enter continents on Models")
            File(instrumentation.targetContext.filesDir, "direct-atlas.json")
                .writeText(
                    """{"result":"passed","authored":true,"directTaps":true,"twoPointers":true,"exactCameraReturn":true,"readingBranchReturn":true,"recreation":true,"retarget":true}"""
                )
        } catch (t: Throwable) {
            runCatching { shot("failure") }
            throw t
        }
    }
}
