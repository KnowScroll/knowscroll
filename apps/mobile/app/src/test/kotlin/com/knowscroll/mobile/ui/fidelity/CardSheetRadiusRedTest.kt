package com.knowscroll.mobile.ui.fidelity

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * docs/product/ui-system.md section 3: "Cards and sheets: radius 22px". Two current call sites
 * are checked:
 *
 * 1. The Trace card in UniverseScreen.kt's `LoadedBlock` uses `MaterialTheme.shapes.medium`, which
 *    `KnowScrollTheme` never overrides -- so it is Material3's own default `Shapes()` value.
 * 2. The reading sheet in ScrollScreen.kt's `ReadingSheet` does not use the theme's shapes at all;
 *    it hardcodes `RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)` as a literal. That literal
 *    is read from source rather than measured, because Compose exposes a composable's *layout*
 *    bounds through test APIs but not the `Shape` object a `Surface` clips to -- there is no
 *    semantics-tree or measured-size way to ask "what corner radius did this Surface use?" without
 *    rasterizing and inspecting curvature pixel-by-pixel, which section 7's own fidelity method
 *    (screenshots beside the reference) is the right place for, not a unit test asserting one
 *    literal.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CardSheetRadiusRedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun `theme's default card shape is 22dp, not Material3's own default`() {
        var shapes by mutableStateOf<Shapes?>(null)
        composeRule.setContent {
            KnowScrollTheme {
                shapes = MaterialTheme.shapes
            }
        }
        composeRule.waitForIdle()
        val medium = requireNotNull(shapes).medium
        assertEquals(
            "docs/product/ui-system.md section 3: cards and sheets are 22dp radius. " +
                "UniverseScreen.kt's Trace card uses MaterialTheme.shapes.medium, which " +
                "KnowScrollTheme (Theme.kt) never sets -- so it is Material3's own default " +
                "(currently $medium), not the Cosmos card radius.",
            RoundedCornerShape(22.dp),
            medium
        )
    }

    @Test
    fun `the reading sheet's hardcoded corner literal is 22dp, not 24dp`() {
        val source = findMobileModuleFile("app/src/main/kotlin/com/knowscroll/mobile/ui/scroll/ScrollScreen.kt")
            .readText()
        val sheetBlock = source.substringAfter("private fun ReadingSheet")
        assertTrue(
            "ScrollScreen.kt's ReadingSheet no longer contains a RoundedCornerShape literal to " +
                "check -- update this test alongside whatever replaced it.",
            sheetBlock.contains("RoundedCornerShape(")
        )
        assertTrue(
            "docs/product/ui-system.md section 3: cards and sheets are 22dp radius. " +
                "ScrollScreen.kt's ReadingSheet hardcodes RoundedCornerShape(topStart = 24.dp, " +
                "topEnd = 24.dp) -- 24dp, not the spec's 22dp, and a literal rather than a shared " +
                "theme token either way.",
            sheetBlock.contains("22.dp")
        )
    }
}
