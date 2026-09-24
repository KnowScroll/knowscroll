package com.knowscroll.mobile.ui

import android.content.Context
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import androidx.test.core.app.ApplicationProvider
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.Capabilities
import com.knowscroll.mobile.data.Trace
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.preview.previewDocument
import com.knowscroll.mobile.ui.scroll.content.ScrollBlocks
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #161: readers never see a source -- not in the app's own words, on the universe, or in the authored preview. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
class HiddenSourcesTest {
    @Test
    fun noStringTheAppShowsPointsAtASource() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val leaks = R.string::class.java.fields
            .map { it.name to context.getString(it.getInt(null)) }
            .filter { (_, text) -> pointsAtASource(text) }
        assertEquals(emptyList<Pair<String, String>>(), leaks)
    }

    @Test
    fun theUniverseNamesNoSource() = runComposeUiTest {
        val traces = listOf(Trace("event-1", "asset-1", "The bitter lesson", "2026-08-20T00:00:00Z"))
        setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = UniverseState.Loaded(Universe("u1", 3, 1, traces, Capabilities.AllFalse)),
                    historyClear = HistoryClearState.Idle, signOut = SignOutState.Idle,
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {},
                )
            }
        }
        onNodeWithText("Your system").assertExists()
        assertNoSourceShown()
    }

    @Test
    fun theAuthoredPreviewCitesNoSource() = runComposeUiTest {
        setContent { KnowScrollTheme { ScrollBlocks(previewDocument(0), imageLoader = { null }) } }
        onNodeWithText("Compare the two illustrations").assertExists()
        assertNoSourceShown("NASA", "science.nasa.gov")
    }
}
