package com.knowscroll.mobile.ui.scroll

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #97 review: after process death (or "Don't keep activities") a new ViewModel starts with
 * `Loading` before the first composition, so the restored screen first composes without a Scroll
 * and only then receives the same Scroll again. The sheet the reader had open must survive that
 * too: the Scroll it belongs to is itself saved state, not a plain `remember`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h640dp-xhdpi")
class ReaderSheetProcessRestoreTest {
    @get:Rule val rule = createComposeRule()

    private val body = (1..10).joinToString("\n\n") { "Paragraph $it of a Scroll long enough to render." }
    private fun reading(id: String) = ScrollState.Reading(
        ScrollItem(id, 1, "Scroll", "A Scroll", "Summary", body, "Source", "https://example.invalid", "documented", "reason text"),
        "e1", "ev1", KeepState.Idle, 0, DiscoveryState.Idle, ReaderOrigin.Discovery,
    )

    @Test
    fun anOpenSheetSurvivesARestoreThatStartsWithoutTheScroll() {
        val tester = StateRestorationTester(rule)
        val backing = mutableStateOf<ScrollState>(reading("asset-1"))
        tester.setContent {
            KnowScrollTheme {
                ScrollScreen(state = backing.value, onKeep = {}, onReturn = {}, onNext = {}, onRetry = {}, onReadingPosition = { _, _ -> }, onOpenKeep = {})
            }
        }
        rule.onNodeWithContentDescription("Why this Scroll appeared").performClick()
        rule.onNodeWithText("Why this appeared").assertIsDisplayed()

        backing.value = ScrollState.Loading
        tester.emulateSavedInstanceStateRestore()
        backing.value = reading("asset-1")
        rule.waitForIdle()

        rule.onNodeWithText("Why this appeared").assertIsDisplayed()
    }
}
