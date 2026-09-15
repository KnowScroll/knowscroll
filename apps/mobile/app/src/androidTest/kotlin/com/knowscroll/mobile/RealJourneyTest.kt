package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Real app, real HTTP service, real separate worker and PostgreSQL. No network substitute. */
@RunWith(AndroidJUnit4::class)
class RealJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun waitText(text:String) = compose.waitUntil(15000) {
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    }
    private fun capture(name:String) {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val bitmap=instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.filesDir,"$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG,100,it)
        }
    }
    @Test fun unavailableIsHonest() {
        waitText("The universe is unreachable.")
        compose.onNodeWithText("Retry").assertExists()
        compose.onAllNodesWithContentDescription("Enter Scroll").assertCountEquals(0)
        capture("j001-unavailable")
    }
    @Test fun compactLayoutAndRecovery() = runBlocking {
        val expected = ApiClient().getFeed().items.firstOrNull() ?: error("Need one unkept Scroll")
        waitText("Your universe")
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        waitText(expected.title)
        compose.onNodeWithContentDescription("Return to the universe").assertIsDisplayed()
        compose.onNodeWithContentDescription("Keep this Scroll").assertIsDisplayed()
        compose.waitUntil(10000) {
            com.knowscroll.mobile.data.StateStore(InstrumentationRegistry.getInstrumentation().targetContext).read()?.exposureId?.isNotEmpty() == true
        }
        capture("j001-compact")
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        waitText("Your universe")
        capture("j001-recovered")
    }
    @Test fun sourcedScrollKeepAndReturn() = runBlocking {
        if (BuildConfig.APPLICATION_ID.endsWith(".journey")) {
            InstrumentationRegistry.getInstrumentation().targetContext.getSharedPreferences("ks_session_v1", android.content.Context.MODE_PRIVATE).edit().clear().commit()
            compose.activityRule.scenario.recreate()
        }
        val api=ApiClient()
        val before=api.getUniverse()
        val expected=api.getFeed().items.firstOrNull()
            ?: error("Starting library exhausted; use an isolated journey database")
        waitText("Your universe")
        compose.onNodeWithContentDescription("Enter Scroll").assertExists().performClick()
        waitText(expected.title)
        compose.onNodeWithText("SCROLL · DOCUMENTED").assertExists()
        capture("j001-scroll")
        // Recreate the Activity while the Scroll is open: preserve item and origin.
        compose.activityRule.scenario.recreate()
        waitText(expected.title)
        compose.waitUntil(10000) { compose.onAllNodesWithContentDescription("Keep this Scroll").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Keep this Scroll").performClick()
        waitText("Kept")
        capture("j001-kept")
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        waitText("Your universe")
        waitText(expected.title)
        capture("j001-return")
        val after=api.getUniverse()
        val trace=after.traces.first { it.assetId==expected.assetId }
        val event=api.getEvent(trace.eventId)
        assertTrue(event.projected)
        assertNotNull(event.causationId)
        assertNotNull(event.exposureId)
        assertEquals(before.revision+1,after.revision)
        assertTrue(api.getFeed().items.none { it.assetId==expected.assetId })
        val receipt=JSONObject().apply {
            put("journey","J001");put("surface","Android instrumentation + real API/worker/PostgreSQL")
            put("observedAt",java.time.Instant.now().toString());put("assetId",expected.assetId)
            put("eventId",event.eventId);put("causationId",event.causationId)
            put("exposureId",event.exposureId);put("jobId",event.jobId)
            put("projected",event.projected);put("revision",after.revision)
            put("activityRecreation","passed");put("result","passed")
        }
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,"j001-android.json").writeText(receipt.toString(2))
    }
}
