package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.runComposeUiTest
import android.graphics.Bitmap
import com.knowscroll.mobile.data.Capabilities
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.data.Trace
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.HistoryClearState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.SignOutState
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.scroll.ScrollScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen
import java.io.File
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * docs/product/ui-system.md section 7's own fidelity method: "render the reference and the build
 * at the same size, put them side by side... on a phone, the comparable sizes are the emulator's
 * own resolution at font scale 1.0 and 840x1680 at font scale 1.3, which are the two the Android
 * journeys already exercise." These files are the "build" half of that comparison, placed beside
 * the two rendered references in docs/journeys/evidence/android-ui/.
 *
 * This keeps and extends e85fdff's JVM-only screenshot capability (Roborazzi + Robolectric native
 * graphics, no emulator) rather than introducing Roborazzi's own Activity-launching Compose API,
 * which this app's test manifest has not been set up for. `onRoot().captureToImage()` against a
 * real `createComposeRule` content host, on a real rasterized bitmap (native graphics mode,
 * verified in e85fdff), is the same mechanism TruthPillRedTest already proves works in this repo.
 */
@OptIn(ExperimentalTestApi::class, ExperimentalComposeUiApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
class ScreenshotEvidenceTest {

    private val sampleTrace = Trace("event-1", "asset-1", "The bitter lesson", "2026-08-20T00:00:00Z")

    private fun emptyUniverse() = UniverseState.Loaded(Universe("u1", 1, 1, emptyList(), Capabilities.AllFalse))
    private fun startedUniverse() = UniverseState.Loaded(Universe("u1", 3, 1, listOf(sampleTrace), Capabilities.AllFalse))

    private fun readingState() = ScrollState.Reading(
        item = ScrollItem(
            assetId = "asset-1", revision = 1, kind = "scroll",
            title = "The bitter lesson", summary = "Search and learning beat cleverness, every decade.",
            body = "General methods that leverage computation are ultimately the most effective, " +
                "and by a large margin. This is a hard lesson, because building in how we think we " +
                "think does not work in the long run.",
            sourceTitle = "Rich Sutton", sourceUrl = "https://example.invalid/bitter-lesson",
            truthState = "documented", reason = "Related to a Scroll you kept."
        ),
        exposureId = "exposure-1", eventId = "event-1", keep = KeepState.Idle, readingPosition = 0,
        discovery = DiscoveryState.Idle, origin = ReaderOrigin.Discovery
    )

    private fun save(bitmap: Bitmap, name: String) {
        val dir = File(evidenceOutputDir(), "").apply { mkdirs() }
        val file = File(dir, name)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun `universe first visit`() = runComposeUiTest {
        setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = emptyUniverse(), historyClear = HistoryClearState.Idle, signOut = SignOutState.Idle,
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {}
                )
            }
        }
        waitForIdle()
        save(onRoot().captureToImage().asAndroidBitmap(), "universe-first-visit.png")
    }

    @Test
    fun `universe with a kept trace`() = runComposeUiTest {
        setContent {
            KnowScrollTheme {
                UniverseScreen(
                    state = startedUniverse(), historyClear = HistoryClearState.Idle, signOut = SignOutState.Idle,
                    onEnterScroll = {}, onOpenTrace = {}, onEnterSystem = {}, onRetry = {},
                    onRequestHistoryClear = {}, onCancelHistoryClear = {}, onConfirmHistoryClear = {}, onRetryHistoryClear = {},
                    onRequestSignOut = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
                    onOpenKeep = {}
                )
            }
        }
        waitForIdle()
        save(onRoot().captureToImage().asAndroidBitmap(), "universe-with-kept-trace.png")
    }

    @Test
    fun `scroll reader`() = runComposeUiTest {
        setContent {
            KnowScrollTheme {
                ScrollScreen(
                    state = readingState(), onKeep = {}, onReturn = {}, onNext = {}, onRetry = {},
                    onReadingPosition = { _, _ -> }, onOpenKeep = {}
                )
            }
        }
        waitForIdle()
        save(onRoot().captureToImage().asAndroidBitmap(), "scroll-reader.png")
    }
}
