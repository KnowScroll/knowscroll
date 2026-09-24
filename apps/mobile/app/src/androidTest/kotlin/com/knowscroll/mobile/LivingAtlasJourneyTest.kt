package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.StateStore
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The owner-visible system view: the reader's places (#161: never a world or its source), the
 * honest station, pan and pinch, and an exact camera across recreation and Back. */
@RunWith(AndroidJUnit4::class)
class LivingAtlasJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private fun waitFor(label: String) =
        compose.waitUntil(25_000) {
            compose.onAllNodesWithContentDescription(label).fetchSemanticsNodes().isNotEmpty()
        }

    private fun waitText(label: String) =
        compose.waitUntil(15_000) {
            compose.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty()
        }

    private fun pose() =
        compose
            .onNodeWithContentDescription("Spatial atlas")
            .fetchSemanticsNode()
            .config[SemanticsProperties.StateDescription]

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(650)
        compose.waitForIdle()
    }

    private fun back() {
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        settle()
    }

    private fun capture(name: String) {
        settle()
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(instrumentation.targetContext.filesDir, name).outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }

    @Test
    fun continuousHierarchyAndReturnOrigin() {
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName))
        try {
            val store = StateStore(instrumentation.targetContext)
            waitFor("Enter Scroll")
            compose.onNodeWithContentDescription("Enter Scroll").performClick()
            compose.waitUntil(20_000) { store.read()?.exposureId?.isNotBlank() == true }
            val sourceTitle = store.read()!!.item.sourceTitle
            compose.onNodeWithContentDescription("Keep this Scroll").performClick()
            compose.waitUntil(20_000) { store.read()?.keepJobId?.isNotBlank() == true }
            compose.onNodeWithContentDescription("Return to the universe").performClick()
            waitFor("Open the system view")
            compose
                .onNodeWithContentDescription("Open the system view")
                .performScrollTo()
                .performClick()
            waitFor("Spatial atlas")
            waitText("Places form when you come back to a subject on different days.")
            compose.onAllNodesWithText(sourceTitle, substring = true).assertCountEquals(0)
            compose.onAllNodesWithContentDescription("Explore world:", substring = true).assertCountEquals(0)
            capture("living-system.png")
            compose.onNodeWithContentDescription("Station").performClick()
            waitText("A place to pause.")
            capture("living-station.png")
            back()
            val initial = pose()
            compose.onNodeWithContentDescription("Spatial atlas").performTouchInput {
                swipeLeft(startX = centerX, endX = centerX - 50)
            }
            settle()
            assertNotEquals(initial, pose())
            compose.onNodeWithContentDescription("Spatial atlas").performTouchInput {
                pinch(
                    center - androidx.compose.ui.geometry.Offset(25f, 0f),
                    center - androidx.compose.ui.geometry.Offset(65f, 0f),
                    center + androidx.compose.ui.geometry.Offset(25f, 0f),
                    center + androidx.compose.ui.geometry.Offset(65f, 0f),
                )
            }
            settle()
            val origin = pose()
            compose.activityRule.scenario.recreate()
            waitFor("Spatial atlas")
            settle()
            assertEquals(origin, pose())
            compose.onAllNodesWithText(sourceTitle, substring = true).assertCountEquals(0)
            back()
            waitFor("Open the system view")
            File(instrumentation.targetContext.filesDir, "living-atlas.json")
                .writeText(
                    """{"result":"passed","sourceShown":false,"panPinch":true,"exactCameraAcrossRecreation":true,"returnedToUniverse":true,"stationHonest":true}"""
                )
        } catch (failure: Throwable) {
            runCatching { capture("living-failure.png") }
            throw failure
        }
    }
}
