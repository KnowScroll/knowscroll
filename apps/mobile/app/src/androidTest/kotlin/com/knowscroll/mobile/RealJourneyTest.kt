package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ExposureRequest
import com.knowscroll.mobile.data.InteractionRequest
import com.knowscroll.mobile.data.StateStore
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
    private fun store() = StateStore(InstrumentationRegistry.getInstrumentation().targetContext)
    private fun writeJson(name:String, json:JSONObject) =
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,name).writeText(json.toString(2))

    /** Phase one exits normally; the host then force-stops the package, which kills app and test processes. */
    @Test fun processDeathPrepare() = runBlocking {
        val expected=ApiClient().getFeed().items.firstOrNull() ?: error("Need one unkept Scroll")
        waitText("Your universe")
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        waitText(expected.title)
        compose.waitUntil(10000){store().read()?.exposureId?.isNotEmpty()==true}
        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText("SOURCE"))
        compose.waitUntil(10000){(store().read()?.readingPosition ?: 0)>0}
        val session=store().read() ?: error("Scroll retry envelope was not persisted")
        val exposureRetry=ApiClient().postExposure(ExposureRequest(session.decisionId,session.item.assetId,session.clientExposureId))
        assertEquals(session.exposureId,exposureRetry.exposureId)
        assertEquals(session.exposureEventId,exposureRetry.eventId)
        capture("wave1-process-before")
        writeJson("wave1-process-before.json",JSONObject().apply {
            put("assetId",session.item.assetId);put("decisionId",session.decisionId)
            put("clientExposureId",session.clientExposureId);put("clientEventId",session.clientEventId)
            put("exposureId",session.exposureId);put("exposureEventId",session.exposureEventId)
            put("readingPosition",session.readingPosition);put("phase","before-force-stop")
        })
    }

    /** Launched by a new instrumentation process after `am force-stop` and an explicit app relaunch. */
    @Test fun processDeathRestoreKeepReturnAndNext() = runBlocking {
        val before=JSONObject(File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,"wave1-process-before.json").readText())
        waitText(before.getString("assetId").let { store().read()?.item?.title ?: error("Session missing after process death") })
        val restored=store().read() ?: error("Retry envelope missing after process death")
        assertEquals(before.getString("assetId"),restored.item.assetId)
        assertEquals(before.getString("decisionId"),restored.decisionId)
        assertEquals(before.getString("clientExposureId"),restored.clientExposureId)
        assertEquals(before.getString("clientEventId"),restored.clientEventId)
        assertEquals(before.getString("exposureId"),restored.exposureId)
        assertEquals(before.getInt("readingPosition"),restored.readingPosition)
        compose.onNodeWithContentDescription("Scroll reading content").assertExists()
        capture("wave1-process-restored")
        compose.onNodeWithContentDescription("Keep this Scroll").performClick()
        waitText("Kept")
        val kept=store().read() ?: error("Accepted keep was not persisted")
        val retry=ApiClient().postInteraction(InteractionRequest(kept.clientEventId,kept.exposureId,kept.item.assetId,"keep"))
        assertEquals(kept.keepEventId,retry.eventId);assertEquals(kept.keepJobId,retry.jobId)
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        waitText("Your universe");waitText(restored.item.title)
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        compose.waitUntil(15000){store().read()?.item?.assetId?.let{it!=restored.item.assetId}==true}
        val next=store().read() ?: error("Next Scroll was not persisted")
        waitText(next.item.title);assertNotEquals(restored.item.assetId,next.item.assetId)
        compose.onNodeWithContentDescription("Return to the universe").performClick();waitText("Your universe")
        capture("wave1-process-return-next")
        writeJson("wave1-process-after.json",JSONObject().apply {
            put("assetId",restored.item.assetId);put("nextAssetId",next.item.assetId)
            put("clientExposureId",restored.clientExposureId);put("clientEventId",restored.clientEventId)
            put("exposureId",restored.exposureId);put("exposureEventId",restored.exposureEventId)
            put("keepEventId",kept.keepEventId);put("keepJobId",kept.keepJobId)
            put("readingPosition",restored.readingPosition);put("screenAfterReturn","universe")
            put("processDeath","passed");put("idempotentRetries","passed")
        })
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
