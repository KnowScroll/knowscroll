package com.knowscroll.mobile

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.knowscroll.mobile.data.ApiClient
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
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
 * planet. It opens the System, sees Places is now the default, opens Gravity's sheet, and -- when
 * the walk has left one of Gravity's neighbours unread (a sighting is only ever something not yet
 * met; one read along the way retires on its own and is honestly not there to show) -- reads that
 * sighting's sentence and support; opens the formation delta's evidence, then sets Gravity aside
 * and confirms it and its chronicle line disappear from the live atlas.
 */
@RunWith(AndroidJUnit4::class)
class PlacesJourneyTest : AtlasJourneySupport() {
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
