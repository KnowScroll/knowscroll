package com.knowscroll.mobile

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.ui.system.*
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Hundred illustrative markers, large text, real pinch, rapid reversal and restoration. */
class NativeAtlasStressTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun manyMarkersRemainAccessible() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "com.knowscroll.mobile.journey")
        var selected: String? = null
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.45f)) {
                KnowScrollTheme {
                    SpatialAtlas(
                        (1..100).map {
                            AtlasMarker(
                                "world-$it",
                                "Illustrative world $it with a long source title",
                            )
                        },
                        null,
                        { selected = it },
                        Modifier.fillMaxSize(),
                    )
                }
            }
        }
        compose.onNodeWithText("Worlds 100").performClick()
        compose
            .onNodeWithText("Illustrative world 100 with a long source title")
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        assertEquals("world-100", selected)
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription("Spatial atlas").performTouchInput {
            val delta = androidx.compose.ui.geometry.Offset(50f, 0f)
            down(0, center - delta)
            down(1, center + delta)
            moveTo(0, center - delta * 2f)
            moveTo(1, center + delta * 2f)
            up(0)
            up(1)
        }
        val pinched =
            compose
                .onNodeWithContentDescription("Spatial atlas")
                .fetchSemanticsNode()
                .config[SemanticsProperties.StateDescription]
        assertFalse("Pinch must change scale", pinched.startsWith("Zoom 100 percent"))
        repeat(6) {
            compose.onNodeWithContentDescription("Zoom in").performClick()
            compose.onNodeWithContentDescription("Zoom out").performClick()
        }
        compose.onNodeWithText("Recenter").performClick()
        compose.waitUntil(10_000) {
            compose
                .onNodeWithContentDescription("Spatial atlas")
                .fetchSemanticsNode()
                .config[SemanticsProperties.StateDescription] == "Zoom 100 percent; camera 0, 0"
        }
        File(context.filesDir, "atlas-stress.json")
            .writeText(
                """{"result":"passed","markers":100,"fontScale":1.45,"pinch":true,"rapidReversal":true,"accessibleOffscreenSelection":true,"recenter":true,"previewOnly":true}"""
            )
    }
}
