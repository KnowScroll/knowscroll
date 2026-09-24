package com.knowscroll.mobile

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.ui.system.holdsUpLine
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * #131/#134 — foundation Stars (ADR-0037) on a real device, against the disposable stack that
 * `scripts/android-semantic-journey.py`'s `foundation` mode seeds. Tides, Orbits and Star formation
 * are already places, formed from supplied accounts because the library cannot anchor Orbits or
 * Star formation from reading (`scripts/atlas/seed-held-up-places.ts`), and there is one day-old
 * keep of "One force, many jobs".
 *
 * The reader keeps "The pull you can't see" and "A rhythm the ocean keeps", exactly as in
 * [PlacesJourneyTest]. The refresh that forms Gravity from that reading also recognises it as a
 * foundation, because it explains all three places. The reader sees that on the map and in the
 * list, opens Gravity's sheet (what it holds up and the claims that say so), opens the
 * recognition's evidence, then sets Tides aside. With two connections left, Gravity is no longer a
 * foundation, and the chronicle says so as the reader's own correction.
 */
@RunWith(AndroidJUnit4::class)
class FoundationJourneyTest : AtlasJourneySupport() {
    @Test
    fun aPlaceThatHoldsOthersUpIsRecognisedInspectedAndWithdrawnWhenOneIsSetAside() {
        try { journey() } catch (failure: Throwable) { runCatching { screenshot("foundation-failure.png") }; throw failure }
    }

    private fun openList() {
        compose.waitUntil(10_000) { compose.onAllNodesWithText("List").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("List").performClick()
    }

    /** The server's own atlas, polled at a steady pace (never from inside a Compose wait loop). */
    private fun awaitAtlas(api: ApiClient, what: String, until: (AtlasResponse) -> Boolean): AtlasResponse = runBlocking {
        var atlas = api.getAtlas()
        repeat(80) { if (!until(atlas)) { delay(250); atlas = api.getAtlas() } }
        assertTrue(what, until(atlas))
        atlas
    }

    private fun closePlace() {
        compose.onNodeWithContentDescription("Close place detail and return to the system").performScrollTo().performClick()
    }

    private fun journey() {
        openReader()
        keepWhenOffered("The pull you can't see", "A rhythm the ocean keeps")
        openSystem()

        val api = ApiClient()
        val recognisedAtlas = awaitAtlas(api, "Gravity forms and is recognised as a foundation") { atlas ->
            atlas.places.any { it.anchor.code == "physics.gravity" && it.foundation != null }
        }
        val gravity = recognisedAtlas.places.single { it.anchor.code == "physics.gravity" }
        val heldUp = gravity.foundation!!.holdsUp.map { id -> recognisedAtlas.places.single { it.placeId == id } }
        assertEquals(setOf("earth.tides", "astro.orbit", "astro.star.birth"), heldUp.map { it.anchor.code }.toSet())
        assertTrue("every connection is sourced", gravity.foundation!!.relations.all { it.claim != null || it.bridge != null })
        val recognised = recognisedAtlas.chronicle.single { it.kind == "foundation_recognised" && it.placeId == gravity.placeId }
        assertEquals("substrate_neighbourhood", recognised.causalClass)
        val formed = recognisedAtlas.chronicle.single { it.kind == "place_formed" && it.placeId == gravity.placeId }
        val tides = heldUp.single { it.anchor.code == "earth.tides" }
        val tidesName = tides.anchor.name

        // The system overview (a marker may sit under another by the layout's collision policy;
        // the list below always has every place).
        compose.waitUntil(20_000) { compose.onAllNodesWithText("List").fetchSemanticsNodes().isNotEmpty() }
        screenshot("foundation-system.png")

        // The list always shows it, and opens its sheet.
        openList()
        compose.onNode(hasText("Gravity") and hasClickAction()).assertExists()
        compose.onNodeWithText("${gravity.scrolls.seen} of ${gravity.scrolls.total} Scrolls read · Foundation").assertExists()
        compose.onNode(hasText("Gravity") and hasClickAction()).performScrollTo().performClick()
        val holdsUp = holdsUpLine(gravity, recognisedAtlas.places)!!
        compose.waitUntil(10_000) { compose.onAllNodesWithText(holdsUp).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(holdsUp).performScrollTo()
        val tidesRelation = gravity.foundation!!.relations.first { it.to == tidesName }
        val support = tidesRelation.claim?.let { "\"${it.text}\" — ${it.sourceTitle}" } ?: tidesRelation.bridge!!.mechanism
        compose.onAllNodesWithText(support).onFirst().performScrollTo().assertExists()
        screenshot("foundation-sheet.png")

        compose.onNodeWithText(recognised.line).performScrollTo().performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Recognised from 3 sourced connections to 3 of your places.").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Recognised from 3 sourced connections to 3 of your places.").performScrollTo()
        screenshot("foundation-evidence.png")

        // Back on the map with Gravity selected: drawn with its glow, and it says so.
        closePlace()
        val selectedFoundation = hasContentDescription("Enter continents on Gravity") and hasStateDescription("Foundation")
        compose.waitUntil(15_000) { compose.onAllNodes(selectedFoundation).fetchSemanticsNodes().isNotEmpty() }
        screenshot("foundation-marker.png")

        // Set Tides aside: Gravity now explains only two of the reader's places.
        openList()
        compose.onNode(hasText(tidesName) and hasClickAction()).performScrollTo().performClick()
        compose.onNodeWithContentDescription("Set $tidesName aside").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Confirm setting $tidesName aside").performScrollTo().performClick()
        val afterReject = awaitAtlas(api, "$tidesName is set aside") { atlas -> atlas.places.none { it.placeId == tides.placeId } }
        // Back on the system, with the list available again once the sheet has closed.
        compose.waitUntil(15_000) { compose.onAllNodesWithText("List").fetchSemanticsNodes().isNotEmpty() }
        assertNull("no longer a foundation", afterReject.places.single { it.anchor.code == "physics.gravity" }.foundation)
        val withdrawn = afterReject.chronicle.single { it.kind == "foundation_withdrawn" && it.placeId == gravity.placeId }
        assertEquals("reader_correction", withdrawn.causalClass)
        assertEquals("Gravity no longer holds up the places around it.", withdrawn.line)
        val tidesRejected = afterReject.chronicle.single { it.kind == "place_rejected" && it.placeId == tides.placeId }

        openList()
        compose.onNodeWithText("${gravity.scrolls.seen} of ${gravity.scrolls.total} Scrolls read · Foundation").assertDoesNotExist()
        compose.onNodeWithText(withdrawn.line).performScrollTo().performClick()
        val withdrawnEvidence = "After you set a place aside, it no longer has enough sourced connections to your places."
        compose.waitUntil(10_000) { compose.onAllNodesWithText(withdrawnEvidence).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(withdrawnEvidence).performScrollTo()
        screenshot("foundation-withdrawn.png")

        File(instrumentation.targetContext.filesDir, "foundation-journey.json").writeText(
            JSONObject().apply {
                put("gravityPlaceId", gravity.placeId)
                put("heldUpPlaceIds", org.json.JSONArray(gravity.foundation!!.holdsUp))
                put("tidesPlaceId", tides.placeId)
                put("deltaIds", JSONObject().apply {
                    put("gravityFormed", formed.deltaId); put("recognised", recognised.deltaId)
                    put("tidesRejected", tidesRejected.deltaId); put("withdrawn", withdrawn.deltaId)
                })
                put("connections", gravity.foundation!!.relations.size)
            }.toString(2)
        )
    }
}
