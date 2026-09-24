package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.StateStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * #134 — the reader's live places (ADR-0036), driven end to end on a real device against the
 * disposable stack `scripts/android-semantic-journey.py`'s `places` mode seeds (one day-old,
 * backdated keep of "One force, many jobs" through the real API -- see
 * `scripts/atlas/seed-day-old-history.ts`).
 *
 * The reader reaches, by ordinary bounded discovery, "The pull you can't see" and "A rhythm the
 * ocean keeps" and keeps both (a second day, a second source family, exactly the runner's seeded
 * account's third keep) -- the same anchoring `tests/atlas-places.test.ts` already proves forms a
 * planet. It opens the System, sees Places is now the default, opens Gravity's sheet, reads its
 * sighting's sentence and support, opens the formation delta's evidence, then sets Gravity aside
 * and confirms it and its chronicle line disappear from the live atlas.
 */
@RunWith(AndroidJUnit4::class)
class PlacesJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)

    private fun screenshot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        Thread.sleep(350)
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    private fun waitReading() = compose.waitUntil(20_000) {
        store().read()?.exposureId?.isNotEmpty() == true &&
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
    }

    private fun openReader() {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey") { "Places journey requires the separate journey app" }
        compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        waitReading()
    }

    /** Ordinary deliberate discovery, bounded, exactly like `SemanticBranchJourneyTest`: each target
     * Scroll (by the start of its real title) is kept whenever the feed offers it, in whatever order
     * the Composer chooses -- a trip never re-offers what it has already shown, so walking past one
     * target while looking for another would lose it. Each keep waits for its real job to project. */
    private fun keepWhenOffered(vararg titlePrefixes: String) {
        val remaining = titlePrefixes.toMutableList()
        var tries = 0
        while (remaining.isNotEmpty() && tries < 30) {
            val title = store().read()!!.item.title
            val target = remaining.firstOrNull { title.startsWith(it) }
            if (target != null) {
                keepCurrent(target)
                remaining.remove(target)
                if (remaining.isEmpty()) break
            }
            val current = store().read()!!.item.assetId
            compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasContentDescription("Get the next Scroll"))
            compose.onNodeWithContentDescription("Get the next Scroll").performClick()
            compose.waitUntil(20_000) { store().read()?.item?.assetId != current }
            waitReading()
            tries++
        }
        assertTrue("the feed never offered $remaining within a bounded trip", remaining.isEmpty())
    }

    private fun keepCurrent(titlePrefix: String) {
        // Keep lives in the fixed reader toolbar, outside the scrolling content (as in SemanticWhyJourneyTest).
        compose.onNodeWithContentDescription("Keep this Scroll").performClick()
        compose.waitUntil(15_000) { store().read()?.keepJobId?.isNotEmpty() == true }
        val eventId = store().read()!!.keepEventId
        runBlocking {
            var projected = false
            repeat(40) {
                if (!projected) {
                    projected = ApiClient().getEvent(eventId).projected
                    if (!projected) delay(250)
                }
            }
            assertTrue("keep of \"$titlePrefix\" never projected", projected)
        }
    }

    private fun openSystem() {
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithContentDescription("Open the system view").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Open the system view").performScrollTo().performClick()
    }

    @Test
    fun theReadersOwnPlaceFormsIsInspectedAndCanBeSetAside() {
        try { journey() } catch (failure: Throwable) { runCatching { screenshot("places-failure.png") }; throw failure }
    }

    private fun journey() {
        openReader()
        keepWhenOffered("The pull you can't see", "A rhythm the ocean keeps")
        openSystem()

        // Places is the default the moment a planet exists -- no manual toggle needed.
        compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("Explore place: Gravity").fetchSemanticsNodes().isNotEmpty() }
        screenshot("places-system.png")

        // The Cartographer ranks up to 5 sightings by substrate degree, so the sighting sentence
        // and its support are read from the real atlas rather than assumed -- only the wording the
        // client itself renders from that data (`basisSentence`) is asserted.
        val api = ApiClient()
        val beforeOpen = runBlocking { api.getAtlas() }
        val planet = beforeOpen.places.single { it.anchor.code == "physics.gravity" }
        // A sighting is a neighbour the reader has never been shown, so a trip that already read all
        // of Gravity's neighbours has none: then there is honestly nothing to show (PlacesScreenTest
        // covers the sighting rendering on the JVM).
        val sightingPlace = beforeOpen.places.firstOrNull { it.kind == "sighting" && it.parentPlaceId == planet.placeId }

        compose.onNodeWithContentDescription("Explore place: Gravity").performClick()
        compose.onNodeWithText("Info").performClick()
        if (sightingPlace != null) {
            val basis = sightingPlace.basis!!
            val expectedSentence = com.knowscroll.mobile.ui.system.basisSentence(basis)
            val expectedSupport = basis.claim?.let { "\"${it.text}\" — ${it.sourceTitle}" } ?: basis.bridge?.mechanism
            assertNotNull("a sighting shows what connects it", expectedSupport)
            compose.waitUntil(10_000) { compose.onAllNodesWithText(expectedSentence).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(expectedSupport!!).assertExists()
        } else {
            compose.waitUntil(10_000) { compose.onAllNodesWithText("A place formed around Gravity.").fetchSemanticsNodes().isNotEmpty() }
        }
        screenshot("places-sheet.png")

        val formed = beforeOpen.chronicle.first { it.kind == "place_formed" && it.placeId == planet.placeId }
        val sightingDelta = sightingPlace?.let { s -> beforeOpen.chronicle.first { it.kind == "sighting_appeared" && it.placeId == s.placeId } }

        compose.onNodeWithText("A place formed around Gravity.").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Formed from", substring = true).fetchSemanticsNodes().isNotEmpty() }
        screenshot("places-evidence.png")

        compose.onNodeWithContentDescription("Set Gravity aside").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Set Gravity aside? It won't form again unless you clear your history.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Confirm setting Gravity aside").performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithContentDescription("Explore place: Gravity").fetchSemanticsNodes().isEmpty() }
        screenshot("places-setaside.png")

        val afterReject = runBlocking { api.getAtlas() }
        assertTrue("Gravity no longer forms a live place", afterReject.places.none { it.anchor.code == "physics.gravity" })
        val rejected = afterReject.chronicle.single { it.line == "You set Gravity aside." }
        assertEquals("place_rejected", rejected.kind)

        File(instrumentation.targetContext.filesDir, "places-journey.json").writeText(
            JSONObject().apply {
                put("placeId", planet.placeId)
                put("deltaIds", JSONObject().apply {
                    put("formed", formed.deltaId); put("sightingAppeared", sightingDelta?.deltaId ?: JSONObject.NULL); put("rejected", rejected.deltaId)
                })
                put("counts", JSONObject().apply {
                    put("scrollsTotal", planet.scrolls.total); put("scrollsSeen", planet.scrolls.seen)
                    put("sightings", beforeOpen.places.count { it.kind == "sighting" && it.parentPlaceId == planet.placeId })
                })
            }.toString(2)
        )
    }
}
