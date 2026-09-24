package com.knowscroll.mobile.ui.scroll

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #97 regression: with the reader open and a bottom sheet showing, an Activity recreation
 * (rotation, configuration change) left the sheet closed.
 *
 * Root cause: `AppViewModel.onForeground()` runs `reconcilePrivacy(restoreStoredScroll = true)`
 * on every `Lifecycle.State.STARTED` re-entry -- including the one right after an Activity
 * recreation, since `KnowScrollApp`'s `repeatOnLifecycle(Lifecycle.State.STARTED)` restarts fresh
 * on every `onStart`. `reconcilePrivacy` synchronously sets `scroll` to `ScrollState.Loading`
 * (AppViewModel.kt ~line 803) and, once privacy is reconciled, restores a *fresh*
 * `ScrollState.Reading` for the *same* assetId from the persisted store (`applyUniverse` ->
 * `show(cached)`). That is a second mount of `ReadingSheet` inside the SAME live composition (no
 * new Activity, no `Bundle` involved the second time) -- `ScrollScreen`'s `when (state)` removes
 * `ReadingSheet` (and therefore `sourcesOpen`/`explainOpen`/`connectionsOpen`, which used to live
 * inside it) from composition while `state` isn't `Reading`. Compose's `SaveableStateRegistry`
 * only lets a `Bundle`-restored value be consumed once: the flags' first mount (right after the
 * real Activity recreation) already consumed the restored `true`, so the second mount moments
 * later fell back to the plain `false` default -- with no new Activity/rotation involved at all,
 * which is exactly what this test drives directly, without needing a real Activity recreation.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h640dp-xhdpi")
class ReaderSheetRemountTest {
    private val body = (1..10).joinToString("\n\n") { "Paragraph $it of a Scroll long enough to render." }
    private fun item(id: String) = ScrollItem(
        id, 1, "Scroll", "A Scroll", "Summary", body, "Source",
        "https://example.invalid", "documented", "reason text",
    )
    private fun reading(id: String) =
        ScrollState.Reading(item(id), "e1", "ev1", KeepState.Idle, 0, DiscoveryState.Idle, ReaderOrigin.Discovery)

    @Test
    fun sourcesSheetSurvivesAForegroundReconciliationReload() = runComposeUiTest {
        val backing = mutableStateOf<ScrollState>(reading("asset-1"))
        setContent {
            KnowScrollTheme {
                ScrollScreen(
                    state = backing.value, onKeep = {}, onReturn = {}, onNext = {}, onRetry = {},
                    onReadingPosition = { _, _ -> }, onOpenKeep = {},
                )
            }
        }
        onNodeWithContentDescription("Sources for this Scroll").performClick()
        onNodeWithText("Sources and truth").assertIsDisplayed()

        backing.value = ScrollState.Loading
        waitForIdle()
        backing.value = reading("asset-1")
        waitForIdle()

        onNodeWithText("Sources and truth").assertIsDisplayed()
    }

    @Test
    fun explainSheetSurvivesAForegroundReconciliationReload() = runComposeUiTest {
        val backing = mutableStateOf<ScrollState>(reading("asset-1"))
        setContent {
            KnowScrollTheme {
                ScrollScreen(
                    state = backing.value, onKeep = {}, onReturn = {}, onNext = {}, onRetry = {},
                    onReadingPosition = { _, _ -> }, onOpenKeep = {},
                )
            }
        }
        onNodeWithContentDescription("Why this Scroll appeared").performClick()
        onNodeWithText("Why this appeared").assertIsDisplayed()

        backing.value = ScrollState.Loading
        waitForIdle()
        backing.value = reading("asset-1")
        waitForIdle()

        onNodeWithText("Why this appeared").assertIsDisplayed()
    }

    @Test
    fun sheetsStillCloseWhenTheReaderMovesToADifferentItem() = runComposeUiTest {
        val backing = mutableStateOf<ScrollState>(reading("asset-1"))
        setContent {
            KnowScrollTheme {
                ScrollScreen(
                    state = backing.value, onKeep = {}, onReturn = {}, onNext = {}, onRetry = {},
                    onReadingPosition = { _, _ -> }, onOpenKeep = {},
                )
            }
        }
        onNodeWithContentDescription("Sources for this Scroll").performClick()
        onNodeWithText("Sources and truth").assertIsDisplayed()

        // A genuine item change (e.g. "keep going") must still close a sheet left open on the
        // previous item -- the fix must not make the flags permanently sticky.
        backing.value = ScrollState.Loading
        waitForIdle()
        backing.value = reading("asset-2")
        waitForIdle()

        onNodeWithText("Sources and truth").assertDoesNotExist()
    }

    @Test
    fun anUnavailableReaderInBetweenClosesTheSheets() = runComposeUiTest {
        val backing = mutableStateOf<ScrollState>(reading("asset-1"))
        setContent {
            KnowScrollTheme {
                ScrollScreen(
                    state = backing.value, onKeep = {}, onReturn = {}, onNext = {}, onRetry = {},
                    onReadingPosition = { _, _ -> }, onOpenKeep = {},
                )
            }
        }
        onNodeWithContentDescription("Sources for this Scroll").performClick()
        onNodeWithText("Sources and truth").assertIsDisplayed()

        // Only a reload carries a sheet over; a failed opening in between does not.
        backing.value = ScrollState.Unavailable("Opening this Scroll was interrupted.", true)
        waitForIdle()
        backing.value = reading("asset-1")
        waitForIdle()

        onNodeWithText("Sources and truth").assertDoesNotExist()
    }
}
