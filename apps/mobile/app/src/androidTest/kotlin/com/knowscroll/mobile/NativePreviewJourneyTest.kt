package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.ui.*
import com.knowscroll.mobile.ui.scroll.content.*
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit test preview. No personal model, no API relationship, no exposures or model output. */
@RunWith(AndroidJUnit4::class)
class NativePreviewJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun richScrollOwnsGesturesAndBranchesReturn() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "com.knowscroll.mobile.journey")
        val frame =
            android.media.MediaMetadataRetriever().let { media ->
                try {
                    media.setDataSource(File(context.filesDir, "native-video.mp4").path)
                    requireNotNull(media.getFrameAtTime(1_000_000))
                } finally {
                    media.release()
                }
            }
        var navigated = 0
        var branch = "origin"
        val document =
            ScrollDocument(
                listOf(
                    ScrollBlock.Heading("When a map changes scale"),
                    ScrollBlock.Prose(
                        "TEST PREVIEW. A map preserves a location while changing what can be seen around it. Dragging the comparison below changes a local illustration; it does not measure what you know."
                    ),
                    ScrollBlock.ComparisonSlider("Compare detail and context", "Context", "Detail"),
                    ScrollBlock.Diagram(
                        "Illustrative scales",
                        listOf(
                            "Planet",
                            "Regions",
                            "Related worlds",
                            "System",
                            "Galaxy",
                            "Universe",
                        ),
                    ),
                    ScrollBlock.Citation(
                        "Source: NASA orbits",
                        "https://science.nasa.gov/solar-system/orbits-and-keplers-laws/",
                    ),
                    ScrollBlock.Image(
                        "https://preview.test/frame.png",
                        "Authorized video frame in native image block",
                        "Test preview image extracted from the supplied video.",
                    ),
                    ScrollBlock.Image(
                        "https://example.invalid/preview-image.png",
                        "An illustrative map at two scales",
                        "Image failure remains readable.",
                    ),
                    ScrollBlock.Unsupported("executable game without sandbox"),
                ) +
                    (1..18).map {
                        ScrollBlock.Prose(
                            "Passage $it. At a wider scale, the same point stays anchored. At a closer scale, detail appears without inventing a relationship. This long document exercises real native scrolling and retains deliberate discovery at its end."
                        )
                    }
            )
        compose.setContent {
            KnowScrollTheme {
                val documents = rememberSaveableStateHolder()
                var selected by rememberSaveable { mutableStateOf("origin") }
                var next by rememberSaveable { mutableIntStateOf(0) }
                BackHandler(selected != "origin") {
                    selected = "origin"
                    branch = "origin"
                }
                documents.SaveableStateProvider(selected) {
                    Column(
                        Modifier.fillMaxSize()
                            .background(com.knowscroll.mobile.ui.theme.Cosmos.Cream)
                            .safeDrawingPadding()
                            .padding(16.dp)
                            .verticalScroll(rememberScrollState())
                            .semantics { contentDescription = "Preview document" }
                    ) {
                        Text("TEST PREVIEW · $selected · next $next")
                        if (selected == "origin")
                            ScrollBlocks(
                                document,
                                imageLoader = { url ->
                                    if (url == "https://preview.test/frame.png") frame else null
                                },
                            )
                        else Text("A linked test continuation. Back returns to its parent.")
                        BranchRail(
                            BranchAvailability.Ready(
                                (1..20).map { index ->
                                    EncounterBranch(
                                        "branch-$index",
                                        "origin",
                                        1,
                                        if (index == 1) "detail" else "perspective-$index",
                                        if (index == 1) "Closer view"
                                        else "Perspective $index with a long branch title",
                                        "Test-authored link",
                                    )
                                }
                            ),
                            onBranch = {
                                selected = it.targetAssetId
                                branch = selected
                            },
                        )
                        Button(
                            onClick = {
                                next++
                                navigated++
                            },
                            modifier =
                                Modifier.semantics {
                                    contentDescription = "Deliberate next discovery"
                                },
                        ) {
                            Text("Next discovery")
                        }
                    }
                }
            }
        }
        compose.onNodeWithContentDescription("Deliberate next discovery").assertIsNotDisplayed()
        compose
            .onNodeWithContentDescription("Preview document")
            .performScrollToNode(
                hasContentDescription("Authorized video frame in native image block")
            )
        compose
            .onNodeWithContentDescription("Authorized video frame in native image block")
            .assertIsDisplayed()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            File(context.filesDir, "rich-image-preview.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        compose
            .onNodeWithContentDescription("Preview document")
            .performScrollToNode(hasContentDescription("Compare detail and context"))
        compose.onNodeWithContentDescription("Compare detail and context").performTouchInput {
            swipeLeft()
        }
        assertEquals("origin", branch)
        assertEquals(0, navigated)
        compose.onNodeWithText("Illustrative scales").performScrollTo()
        compose.onNodeWithText("Planet").performTouchInput { swipeLeft() }
        assertEquals("origin", branch)
        compose
            .onNodeWithContentDescription("Preview document")
            .performScrollToNode(hasText("Closer view"))
        assertEquals(0, navigated)
        compose.onNodeWithText("Closer view").performClick()
        assertEquals("detail", branch)
        compose.waitForIdle()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        assertEquals("origin", branch)
        compose
            .onNodeWithContentDescription("Preview document")
            .performScrollToNode(hasContentDescription("Compare detail and context"))
        val slider =
            compose
                .onNodeWithContentDescription("Compare detail and context")
                .fetchSemanticsNode()
                .config[SemanticsProperties.ProgressBarRangeInfo]
        assertTrue("Slider is interactive", slider.current != .5f)
        compose
            .onNodeWithContentDescription("Preview document")
            .performScrollToNode(hasText("Closer view"))
        compose.onNodeWithText("Closer view").performTouchInput { swipeLeft() }
        assertEquals("detail", branch)
        compose.waitForIdle()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose
            .onNodeWithContentDescription("Preview document")
            .performScrollToNode(hasContentDescription("Deliberate next discovery"))
        compose.onNodeWithContentDescription("Deliberate next discovery").performClick()
        assertEquals(1, navigated)
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            File(context.filesDir, "rich-preview.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        File(context.filesDir, "rich-preview.json")
            .writeText(
                """{"result":"passed","previewOnly":true,"branchCount":20,"sliderOwnsGesture":true,"diagramOwnsGesture":true,"branchReturn":true,"horizontalRail":true,"deliberateNext":true,"liveRichTransport":false}"""
            )
    }
}
