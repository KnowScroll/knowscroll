package com.knowscroll.mobile.ui.fidelity

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * docs/product/ui-system.md section 4b: "Android's `Settings.Global.ANIMATOR_DURATION_SCALE` of 0
 * ... must suspend the same things: sheet motion, any canvas drift, every transition."
 *
 * This is a source-presence check, not a behavioural one, and the gap it proves is narrower than
 * the spec clause -- stated plainly rather than overclaimed:
 *
 * - **Sheet motion**: ModalBottomSheet's entrance/exit animation is a real, running animation
 *   today (ExplainSheet in ScrollScreen.kt). Whether it already happens to respect the
 *   platform's animator duration scale depends on internals of the pinned Compose/Material3
 *   version, not on any code in this app -- nothing here reads or reacts to that setting. Proving
 *   the actual suspended-vs-not behaviour needs either an instrumented/emulator run (a Robolectric
 *   ValueAnimator/Choreographer harness for this was judged out of scope for a capability-plus-red
 *   -tests issue) or a real device journey; this test proves the narrower, still-true fact that no
 *   code path here even looks at the setting.
 * - **Canvas drift**: CosmosBackground.kt draws its stars once and never animates them -- there is
 *   no drift today for anything to suspend. docs/product/ui-system.md section 4b itself marks the
 *   drag-and-pinch universe canvas as not yet drawn, so this half of the clause has no current
 *   implementation to test against at all.
 */
class ReducedMotionRedTest {
    @Test
    fun `no source file reads the platform's reduced-motion signal`() {
        val uiRoot = findMobileModuleFile("app/src/main/kotlin/com/knowscroll/mobile")
        val references = uiRoot.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { it.readText().contains("ANIMATOR_DURATION_SCALE") }
            .map { it.relativeTo(uiRoot).path }
            .toList()
        assertTrue(
            "docs/product/ui-system.md section 4b requires suspending sheet motion and canvas " +
                "drift when Settings.Global.ANIMATOR_DURATION_SCALE is 0. No file under " +
                "app/src/main/kotlin/com/knowscroll/mobile references that constant today " +
                "(checked: nothing found), so nothing in the app can be suspending anything by it.",
            references.isNotEmpty()
        )
    }
}
