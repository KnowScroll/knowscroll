package com.knowscroll.mobile

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.AwayItem
import com.knowscroll.mobile.data.InquiriesResponse
import com.knowscroll.mobile.data.Relic
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * #134 (ADR-0039) — the return, on a real device, against the disposable stack that
 * `scripts/android-semantic-journey.py`'s `return` mode seeds (the same as `inquiry`: a labelled
 * FIXTURE inquiry route, The Sun placed from a SUPPLIED account before consent, and a day-old keep;
 * and SUPPLIED journey knowledge, Solar wind, on The Sun's horizon, which no reading can meet).
 *
 * The reader turns on "Look for connections between my places" and reads their way to Gravity. Then
 * they LEAVE: the app goes to the background while the worker, on its own, opens the inquiry that
 * formation mailed and bridge-validator-v1 admits the fixture's proposal. They RETURN: the Atlas says
 * "While you were away" and shows the connection found. They open its evidence, keep it as a Relic
 * (Keep shows it "Current"), then decide it seems wrong (the Relic says so) and mark what changed as
 * seen. They LEAVE again, and the runner applies real operator source corrections: one revokes the
 * connection's mechanism source, one the source a sighting on their horizon rests on alone. With no
 * action of theirs, the worker's correction catch-up (ADR-0040) retires that sighting while they are
 * away. On return the Atlas shows the correction and the place change, and Keep shows the Relic
 * "Corrected", its kept form still readable. The runner verifies the lineage in SQL. This receipt
 * holds ids, statuses and times only -- no sentence, claim or provider text.
 */
@RunWith(AndroidJUnit4::class)
class ReturnJourneyTest : AtlasJourneySupport() {
    private val consentSwitch = "Look for connections between my places"

    @Test
    fun workDoneWhileAwayIsShownOnReturnKeptAsARelicDoubtedAndCorrected() {
        try { journey() } catch (failure: Throwable) { runCatching { screenshot("return-failure.png") }; throw failure }
    }

    private fun shown(text: String, substring: Boolean = false): Boolean =
        compose.onAllNodes(hasText(text, substring = substring), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun waitDescription(description: String, timeoutMs: Long = 20_000) =
        compose.waitUntil(timeoutMs) { compose.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty() }

    private fun <T> poll(what: String, read: suspend () -> T, until: (T) -> Boolean): T = runBlocking {
        var value = read()
        repeat(160) { if (!until(value)) { delay(500); value = read() } }
        assertTrue(what, until(value))
        value
    }

    /** Away: the whole app in the background, as when the reader switches to something else. */
    private fun leave() {
        instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        instrumentation.waitForIdleSync()
        Thread.sleep(1_000)
    }

    /** Return: the same task brought back to the front, as a launcher tap would. */
    private fun comeBack() {
        val context = instrumentation.targetContext
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        instrumentation.waitForIdleSync()
        compose.waitForIdle()
    }

    private fun tab(label: String) = hasText(label) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)

    /** The dock's Keep tab (a Role.Tab, never the sheet's "Keep" button). */
    private fun openKeep() {
        compose.waitUntil(15_000) { compose.onAllNodes(tab("Keep")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(tab("Keep")).onFirst().performClick()
        waitText("Relics")
    }

    /** From Keep: the dock's Atlas tab leads to the universe, then the system view. */
    private fun keepToSystem() {
        compose.onAllNodes(tab("Atlas")).onFirst().performClick()
        waitDescription("Open the system view")
        compose.onNodeWithContentDescription("Open the system view").performScrollTo().performClick()
    }

    private fun waitText(text: String, timeoutMs: Long = 15_000) = compose.waitUntil(timeoutMs) { shown(text) }

    /** The Atlas shows at most three changes at once: expand when the one wanted is further down. */
    private fun awaitAwayLine(line: String) {
        compose.waitUntil(20_000) {
            if (!shown(line) && compose.onAllNodesWithContentDescription("Show everything that changed while you were away").fetchSemanticsNodes().isNotEmpty())
                compose.onNodeWithContentDescription("Show everything that changed while you were away").performClick()
            shown(line)
        }
    }

    private fun journey() {
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName)) { "The return journey requires the separate journey app" }
        val api = ApiClient()

        // 1. Consent from this live session, then the reading that forms Gravity after it.
        waitDescription("Enter Scroll")
        compose.onNodeWithContentDescription("Open Privacy & account").performScrollTo().performClick()
        waitDescription(consentSwitch)
        compose.onNodeWithContentDescription(consentSwitch).performScrollTo().performClick()
        waitDescription("Raise the daily limit", 15_000)
        compose.onNodeWithContentDescription("Close Privacy & account").performScrollTo().performClick()
        openReader()
        keepWhenOffered("The pull you can't see", "A rhythm the ocean keeps")
        poll("Gravity forms from this reading", { api.getAtlas() }) { a -> a.places.any { it.anchor.code == "physics.gravity" && it.kind != "sighting" } }
        assertTrue("nothing is waiting yet", runBlocking { api.getAway() }.items.none { it is AwayItem.ConnectionFound })

        // 2. Leave while the inquiry is still open. The worker finds the connection while the app is
        // in the background (the runner's coalescing delay keeps it waiting past this point).
        val statusWhenLeft = runBlocking { api.getInquiries() }.inquiries.firstOrNull()?.status
        assertEquals("the inquiry is still waiting when the reader leaves", "waiting", statusWhenLeft)
        leave()
        val list: InquiriesResponse = poll("the inquiry is found while away", { api.getInquiries() }) { l -> l.inquiries.any { it.status == "found" } }
        val inquiry = list.inquiries.first { it.status == "found" }
        val found = inquiry.found!!

        // 3. Return: the Atlas says what happened while away, and only that.
        comeBack()
        openSystem()
        waitDescription("While you were away")
        val line = "Found a connection: ${found.fromConcept.name} and ${found.toConcept.name}."
        awaitAwayLine(line)
        screenshot("return-away.png")

        // 4. Inspect it: the connection's sentence and the claims it was admitted on -- never their sources (#161).
        compose.onAllNodesWithText(line).onFirst().performClick()
        compose.waitUntil(15_000) { shown(found.sentence) }
        compose.onAllNodesWithText(found.evidence.first().statement).onFirst().performScrollTo().assertExists()
        for (claim in found.evidence) {
            assertFalse(claim.sourceTitle, shown(claim.sourceTitle, substring = true))
            assertFalse(claim.sourceUrl, shown(claim.sourceUrl, substring = true))
        }
        screenshot("return-evidence.png")

        // 5. Keep it as a Relic.
        compose.onNodeWithContentDescription("Keep this connection").performScrollTo().performClick()
        waitText("Kept in your Relics")
        screenshot("return-relic.png")
        val relic: Relic = poll("the Relic is kept", { api.getRelics() }) { r -> r.relics.any { it.connection.bridgeId == found.bridgeId } }
            .relics.single { it.connection.bridgeId == found.bridgeId }
        assertEquals("current", relic.state)
        val statesSeen = mutableListOf(relic.state)
        assertEquals(inquiry.inquiryId, relic.provenance.inquiryId)

        // 6. On reflection it seems wrong: the reader's own doubt, recorded on the Relic too.
        compose.onNodeWithContentDescription("This connection seems wrong").performScrollTo().performClick()
        statesSeen += poll("the doubt is recorded", { api.getRelics() }) { r -> r.relics.any { it.relicId == relic.relicId && it.state == "doubted" } }
            .relics.single { it.relicId == relic.relicId }.state
        waitText("You marked this as seeming wrong")
        compose.onNodeWithContentDescription("Close this connection").performClick()
        compose.waitForIdle()

        // 7. Keep shows the Relic, doubted, with its kept form.
        openKeep()
        waitDescription("Relic: ${found.fromConcept.name} and ${found.toConcept.name}")
        waitText("You marked this as seeming wrong")
        screenshot("return-doubted.png")

        // 8. Mark what changed as seen, then leave again. The runner revokes the mechanism source meanwhile,
        // and the source one of the sightings on the horizon now rests on alone.
        keepToSystem()
        waitDescription("Mark what changed while you were away as seen")
        compose.onNodeWithContentDescription("Mark what changed while you were away as seen").performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithContentDescription("While you were away").fetchSemanticsNodes().isEmpty() }
        val sightings = runBlocking { api.getAtlas() }.places.filter { it.kind == "sighting" }.map { it.placeId }.toSet()
        assertTrue("a sighting is on the horizon before the reader leaves", sightings.isNotEmpty())
        leave()
        // Only now, with the app in the background, may the runner apply the correction: it waits for this.
        File(instrumentation.targetContext.filesDir, "return-left-again.txt").writeText("left")
        val corrected = poll("the runner's source correction reaches the Relic while away (did its correction watcher fire?)", { api.getRelics() }) { r ->
            r.relics.any { it.relicId == relic.relicId && it.state == "corrected" }
        }.relics.single { it.relicId == relic.relicId }
        assertEquals("revoked", corrected.connection.bridgeStatus)
        statesSeen += corrected.state
        assertEquals("the kept form stays readable", found.sentence, corrected.connection.sentence)
        // ADR-0040: no action of the reader's refreshes their places; the worker catches them up while away.
        val placeChange = poll("the worker's catch-up retires a sighting whose source was withdrawn while away", { api.getAway() }) { a ->
            a.items.any { it is AwayItem.PlaceChanged && it.change == "sighting_retired" && it.placeId in sightings }
        }.items.filterIsInstance<AwayItem.PlaceChanged>().first { it.change == "sighting_retired" && it.placeId in sightings }
        assertTrue("the sighting has left the Atlas", runBlocking { api.getAtlas() }.places.none { it.placeId == placeChange.placeId })

        // 9. Return (to the Atlas, where they left): it shows the correction and the place change; Keep
        // shows the Relic corrected.
        comeBack()
        waitDescription("While you were away", 30_000)
        awaitAwayLine("What it was based on changed, so the connection between ${found.fromConcept.name} and ${found.toConcept.name} was withdrawn.")
        awaitAwayLine(placeChange.line)
        screenshot("return-corrected-away.png")
        openKeep()
        waitDescription("Relic: ${found.fromConcept.name} and ${found.toConcept.name}")
        waitText("Corrected — what it was based on changed after you kept it")
        screenshot("return-corrected-relic.png")

        File(instrumentation.targetContext.filesDir, "return-journey.json").writeText(
            JSONObject().apply {
                put("inquiryId", inquiry.inquiryId); put("inquiryStatus", inquiry.status); put("bridgeId", found.bridgeId)
                put("relicId", relic.relicId); put("relicStates", org.json.JSONArray(statesSeen))
                put("statusWhenLeft", statusWhenLeft)
                put("evidenceCount", found.evidence.size)
                put("placeChange", JSONObject().apply {
                    put("deltaId", placeChange.deltaId); put("placeId", placeChange.placeId); put("change", placeChange.change)
                })
            }.toString(2)
        )
    }
}
