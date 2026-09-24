package com.knowscroll.mobile

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.data.InquiriesResponse
import com.knowscroll.mobile.data.InquiryConcept
import com.knowscroll.mobile.data.InquiryPair
import com.knowscroll.mobile.ui.account.inquiryStatusLine
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * #132 (ADR-0038) — background bridge inquiries on a real device, against the disposable stack that
 * `scripts/android-semantic-journey.py`'s `inquiry` mode seeds (`scripts/inquiries/seed-journey.ts`):
 * one background inquiry route with the labelled FIXTURE transport and a short coalescing delay (the
 * worker runs with KS_INQUIRY_TRANSPORT=fixture; no provider is called), The Sun placed from a
 * SUPPLIED account before consent (so it mails nothing), and one day-old keep of "One force, many
 * jobs" (`scripts/atlas/seed-day-old-history.ts`).
 *
 * The reader opens Privacy & account: nothing has been looked for. They turn on "Look for
 * connections between my places" (one explicit consent request). Then they READ their way to
 * Gravity exactly as in [PlacesJourneyTest]: that place_formed, after consent, is what mails the
 * inquiry. The worker opens it once the coalescing delay passes, the fixture proposes a bridge for
 * (The Sun, Gravity), bridge-validator-v1 admits it, and Privacy & account shows it found, with the
 * bridge's sentence and sources. Finally, where Gravity (or The Sun) is read, the Connections sheet
 * offers the new connection. The runner then verifies the lineage in SQL. The receipt this test
 * writes holds ids, counts and statuses only -- no bridge sentence, no claim, no provider text.
 */
@RunWith(AndroidJUnit4::class)
class BackgroundInquiryJourneyTest : AtlasJourneySupport() {
    private val consentSwitch = "Look for connections between my places"

    @Test
    fun consentThenAPlaceFormationFindsASourcedConnectionThatBecomesAContinuation() {
        try { journey() } catch (failure: Throwable) { runCatching { screenshot("inquiry-failure.png") }; throw failure }
    }

    private fun shown(text: String, substring: Boolean = false): Boolean =
        compose.onAllNodes(hasText(text, substring = substring), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun waitDescription(description: String, timeoutMs: Long = 20_000) =
        compose.waitUntil(timeoutMs) { compose.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty() }

    private fun openPrivacy() {
        waitDescription("Open Privacy & account")
        compose.onNodeWithContentDescription("Open Privacy & account").performScrollTo().performClick()
        waitDescription(consentSwitch)
    }

    private fun closePrivacy() {
        compose.onNodeWithContentDescription("Close Privacy & account").performScrollTo().performClick()
        waitDescription("Enter Scroll")
    }

    /** The server's own view, polled at a steady pace (never from inside a Compose wait loop). */
    private fun awaitAtlas(api: ApiClient, what: String, until: (AtlasResponse) -> Boolean): AtlasResponse = runBlocking {
        var atlas = api.getAtlas()
        repeat(80) { if (!until(atlas)) { delay(250); atlas = api.getAtlas() } }
        assertTrue(what, until(atlas))
        atlas
    }

    private fun awaitInquiries(api: ApiClient, seen: MutableList<String>, what: String, until: (InquiriesResponse) -> Boolean): InquiriesResponse = runBlocking {
        var list = api.getInquiries()
        repeat(120) {
            list.inquiries.firstOrNull()?.status?.let { if (seen.lastOrNull() != it) seen += it }
            if (!until(list)) { delay(500); list = api.getInquiries() }
        }
        list.inquiries.firstOrNull()?.status?.let { if (seen.lastOrNull() != it) seen += it }
        assertTrue("$what (statuses seen: $seen)", until(list))
        list
    }

    private fun journey() {
        check(com.knowscroll.mobile.JourneyBuild.isJourney(instrumentation.targetContext.packageName)) { "The inquiry journey requires the separate journey app" }
        val api = ApiClient()

        // 1. Before consent: a route is available, nothing was looked for, and the supplied Sun is a place.
        val before = runBlocking { api.getInquiries() }
        assertFalse("consent starts off", before.consent.enabled)
        assertTrue("the runner installed an enabled route", before.consent.available)
        assertTrue("nothing is looked for without consent", before.inquiries.isEmpty())
        val sun = runBlocking { api.getAtlas() }.places.single { it.anchor.code == "astro.sun" && it.kind != "sighting" }

        waitDescription("Enter Scroll")
        openPrivacy()
        compose.onNodeWithContentDescription(consentSwitch).performScrollTo().assertIsOff()
        compose.onNodeWithText("Nothing yet. KnowScroll looks only after a new place forms while this is on.").performScrollTo()
        assertFalse(shown("This deployment has no background route enabled; nothing will run."))
        screenshot("inquiry-consent-off.png")

        // 2. Turn it on: one explicit request from this live session.
        compose.onNodeWithContentDescription(consentSwitch).performScrollTo().performClick()
        waitDescription("Raise the daily limit", 15_000)
        compose.onNodeWithContentDescription(consentSwitch).assertIsOn()
        compose.onNodeWithText("Up to 3 a day · 0 used today").performScrollTo()
        val on = runBlocking { api.getInquiries() }
        assertTrue(on.consent.enabled)
        assertEquals(3, on.consent.dailyLimit)
        assertTrue("turning it on never backfills the place formed before it", on.inquiries.isEmpty())
        assertNull("a confirmed change keeps no retry envelope", store().readPendingInquiryConsent())
        screenshot("inquiry-consent-on.png")
        closePrivacy()

        // 3. Read to Gravity: a real place_formed, after consent.
        openReader()
        keepWhenOffered("The pull you can't see", "A rhythm the ocean keeps")
        val atlas = awaitAtlas(api, "Gravity forms from this reading") { a -> a.places.any { it.anchor.code == "physics.gravity" && it.kind != "sighting" } }
        val gravity = atlas.places.single { it.anchor.code == "physics.gravity" && it.kind != "sighting" }
        val formed = atlas.chronicle.first { it.kind == "place_formed" && it.placeId == gravity.placeId }

        // 4. The inquiry that formation mailed: waiting (coalescing), looking, then its outcome. The fixture
        // run insists on "found"; a live run (-e inquiryExpect any) accepts any validated outcome, since a
        // real model may honestly find nothing or propose what the validator refuses -- the path is the
        // same, and the screen must say which.
        val expectAny = InstrumentationRegistry.getArguments().getString("inquiryExpect") == "any"
        val terminal = setOf("found", "nothing_found", "did_not_hold_up", "nothing_to_ask", "failed", "withdrawn")
        val statuses = mutableListOf<String>()
        val list = if (expectAny) awaitInquiries(api, statuses, "the inquiry reaches an outcome") { l -> l.inquiries.any { it.status in terminal } }
            else awaitInquiries(api, statuses, "the inquiry is found") { l -> l.inquiries.any { it.status == "found" } }
        val inquiry = list.inquiries.first { it.status in terminal }
        if (inquiry.status != "found") {
            compose.onNodeWithContentDescription("Return to the universe").performClick()
            openPrivacy()
            compose.onNodeWithContentDescription("Refresh what KnowScroll looked for").performScrollTo().performClick()
            val line = inquiryStatusLine(inquiry, list.consent, instrumentation.targetContext)
            compose.waitUntil(20_000) { shown(line) }
            compose.onAllNodesWithText(line).onFirst().performScrollTo().assertExists()
            screenshot("inquiry-outcome.png")
            File(instrumentation.targetContext.filesDir, "inquiry-journey.json").writeText(
                JSONObject().apply {
                    put("inquiryId", inquiry.inquiryId); put("status", inquiry.status); put("reasons", JSONArray(inquiry.reasons))
                    put("bridgeId", JSONObject.NULL); put("statusesSeen", JSONArray(statuses))
                    put("consent", JSONObject().apply {
                        put("enabled", list.consent.enabled); put("dailyLimit", list.consent.dailyLimit); put("usedToday", list.consent.usedToday)
                    })
                    put("sunPlaceId", sun.placeId); put("gravityPlaceId", gravity.placeId)
                    put("deltaIds", JSONObject().apply { put("gravityFormed", formed.deltaId) })
                }.toString(2)
            )
            return
        }
        // (The Sun, Gravity) is the pair this seed leaves open (tests/inquiry-journey-editorial.test.ts);
        // should the reading also have formed another place, the pair list may be longer.
        assertTrue("${inquiry.pairs}", InquiryPair(InquiryConcept("astro.sun", "The Sun"), InquiryConcept("physics.gravity", "Gravity")) in inquiry.pairs)
        val found = inquiry.found!!
        assertEquals("admitted", found.bridgeStatus)
        assertTrue("the bridge joins an offered pair", inquiry.pairs.any { setOf(it.a.code, it.b.code) == setOf(found.fromConcept.code, found.toConcept.code) })
        assertEquals(1, list.consent.usedToday)

        // 5. Privacy & account says so: the pair, "found", the bridge's sentence and its sources.
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        openPrivacy()
        compose.onNodeWithContentDescription("Refresh what KnowScroll looked for").performScrollTo().performClick()
        compose.waitUntil(20_000) { shown("Found a connection.") }
        compose.onAllNodesWithText("Found a connection.").onFirst().performScrollTo()
        compose.onAllNodesWithText("The Sun and Gravity", substring = true).onFirst().performScrollTo().assertExists()
        compose.onAllNodesWithText(found.sentence).onFirst().performScrollTo().assertExists()
        compose.onAllNodesWithText(found.evidence.first().sourceTitle).onFirst().performScrollTo().assertExists()
        compose.onNodeWithText("Up to 3 a day · 1 used today").performScrollTo()
        screenshot("inquiry-found.png")
        closePrivacy()

        // 6. Where either side is read, the admitted bridge is a live continuation. The last Scroll was
        // kept, so entering serves a new one; wait for it, not the stored session it replaces.
        val previous = store().read()?.item?.assetId
        compose.waitUntil(20_000) { compose.onAllNodes(hasContentDescription("Enter Scroll") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        compose.waitUntil(20_000) {
            store().read()?.let { s -> s.exposureId.isNotEmpty() && (s.item.assetId != previous || s.keepJobId.isEmpty()) } == true
        }
        waitReading()
        var tries = 0
        var branches = runBlocking { api.getBranches(store().read()!!.item.assetId) }
        while (branches.branches.none { it.bridgeId == found.bridgeId } && tries < 24) {
            val current = store().read()!!.item.assetId
            compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasContentDescription("Get the next Scroll"))
            compose.onNodeWithContentDescription("Get the next Scroll").performClick()
            compose.waitUntil(20_000) { store().read()?.item?.assetId != current }
            waitReading()
            branches = runBlocking { api.getBranches(store().read()!!.item.assetId) }
            tries++
        }
        val origin = store().read()!!
        val continuation = branches.branches.firstOrNull { it.bridgeId == found.bridgeId }
        assertNotNull("no Scroll where Gravity or The Sun is read offered the new connection", continuation)
        compose.waitUntil(20_000) { shown("Why these connections?") }
        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText("Why these connections?"))
        compose.onNodeWithText("Why these connections?").performClick()
        compose.waitUntil(10_000) { shown("How these connect") }
        compose.onAllNodesWithText(found.sentence).onFirst().performScrollTo().assertExists()
        screenshot("inquiry-continuation.png")

        File(instrumentation.targetContext.filesDir, "inquiry-journey.json").writeText(
            JSONObject().apply {
                put("inquiryId", inquiry.inquiryId)
                put("status", inquiry.status)
                put("bridgeId", found.bridgeId)
                put("relationType", found.relationType)
                put("pairs", JSONArray(inquiry.pairs.map { JSONArray().put(it.a.code).put(it.b.code) }))
                put("bridgeConcepts", JSONArray().put(found.fromConcept.code).put(found.toConcept.code))
                put("evidenceCount", found.evidence.size)
                put("statusesSeen", JSONArray(statuses))
                put("inquiriesListed", list.inquiries.size)
                put("consent", JSONObject().apply {
                    put("enabled", list.consent.enabled); put("dailyLimit", list.consent.dailyLimit); put("usedToday", list.consent.usedToday)
                })
                put("sunPlaceId", sun.placeId)
                put("gravityPlaceId", gravity.placeId)
                put("deltaIds", JSONObject().apply { put("gravityFormed", formed.deltaId) })
                put("continuation", JSONObject().apply {
                    put("originAssetId", origin.item.assetId); put("targetAssetId", continuation!!.targetAssetId)
                    put("direction", continuation.direction); put("walkedPast", tries)
                })
            }.toString(2)
        )
    }
}
