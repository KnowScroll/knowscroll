package com.knowscroll.mobile.ui.scroll

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.runComposeUiTest
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.BranchAvailability
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.EncounterBranch
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.branch.BranchPanel
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #131 regression: returning to (or restoring) a Scroll whose continuations have not loaded yet
 * lays the document out shorter than the saved reading position. ScrollState clamps to that
 * shorter maximum, and the clamped value used to be written back as the reading position — the
 * emulator journey observed 1419 → 1083. The reader must end at the saved position once the
 * document can hold it, and must never persist a clamped value in between.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h640dp-xhdpi")
class ReadingRestoreTest {
    private val body = (1..40).joinToString("\n\n") { "Paragraph $it of a long sourced Scroll, long enough to scroll well past the first screen." }
    private fun item(id: String) = ScrollItem(id, 1, "Scroll", "A long Scroll", "Summary", body, "Source", "https://example.invalid", "documented", "")
    private fun reading(id: String, position: Int) = ScrollState.Reading(item(id), "e1", "ev1", KeepState.Idle, position, DiscoveryState.Idle, ReaderOrigin.Discovery)
    private fun ready(id: String) = BranchPanel(
        id, BranchAvailability.Ready(List(4) { EncounterBranch("b$it", id, 1, "t$it", "Continues to idea $it", "A mechanism long enough to wrap.") }),
    )

    @Test
    fun aSavedPositionSurvivesContinuationsArrivingAfterFirstLayout() = runComposeUiTest {
        val written = mutableListOf<Pair<String, Int>>()
        val state = mutableStateOf(reading("first", 0))
        val panel = mutableStateOf(ready("first"))
        setContent {
            KnowScrollTheme {
                ScrollScreen(
                    state = state.value, onKeep = {}, onReturn = {}, onNext = {}, onRetry = {},
                    onReadingPosition = { id, p -> written += id to p }, onOpenKeep = {}, branches = panel.value,
                )
            }
        }
        waitForIdle()
        val content = onNodeWithContentDescription("Scroll reading content")
        val fullMax = content.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].maxValue().toInt()
        assertTrue("the fixture document must scroll", fullMax > 400)
        val saved = fullMax - 10

        // Return to a Scroll saved near its end while its continuations are still loading.
        mainClock.autoAdvance = false
        panel.value = BranchPanel("second", BranchAvailability.Loading)
        state.value = reading("second", saved)
        mainClock.advanceTimeBy(600)
        panel.value = ready("second")
        mainClock.advanceTimeBy(1_200)
        mainClock.autoAdvance = true
        waitForIdle()

        val restored = content.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value().toInt()
        assertEquals("the screen returns to the saved position", saved, restored)
        val persisted = written.filter { it.first == "second" }.map { it.second }
        assertTrue("no clamped position was persisted: $persisted", persisted.all { it == saved })
    }
}
