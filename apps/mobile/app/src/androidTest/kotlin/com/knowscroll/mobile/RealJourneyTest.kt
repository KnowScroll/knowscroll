package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ExposureRequest
import com.knowscroll.mobile.data.InteractionRequest
import com.knowscroll.mobile.data.HistoryClearRequest
import com.knowscroll.mobile.data.StateStore
import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import kotlinx.coroutines.delay

/** Real app, real HTTP service, real separate worker and PostgreSQL. No network substitute. */
@RunWith(AndroidJUnit4::class)
class RealJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun waitText(text:String) = compose.waitUntil(15000) {
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    }
    private fun waitDescription(description:String) = compose.waitUntil(15000) {
        compose.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }
    private fun capture(name:String, requireLightSurface:Boolean=false) {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        var bitmap:Bitmap?=null
        for(attempt in 0 until 5) {
            compose.waitForIdle();instrumentation.waitForIdleSync();Thread.sleep(500)
            bitmap=instrumentation.uiAutomation.takeScreenshot()
            if(!requireLightSurface || hasLightSurface(bitmap!!))break
        }
        val captured=bitmap ?: error("Android screenshot was unavailable")
        if(requireLightSurface)assertTrue("Restored Scroll was not visibly drawn",hasLightSurface(captured))
        File(instrumentation.targetContext.filesDir,"$name.png").outputStream().use {
            captured.compress(Bitmap.CompressFormat.PNG,100,it)
        }
    }
    private fun hasLightSurface(bitmap:Bitmap):Boolean {
        var light=0;var sampled=0
        for(y in 0 until bitmap.height step 20)for(x in 0 until bitmap.width step 20){
            val pixel=bitmap.getPixel(x,y);sampled++
            if(android.graphics.Color.red(pixel)+android.graphics.Color.green(pixel)+android.graphics.Color.blue(pixel)>540)light++
        }
        return light>sampled/5
    }
    private fun store() = StateStore(InstrumentationRegistry.getInstrumentation().targetContext)
    private fun writeJson(name:String, json:JSONObject) =
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,name).writeText(json.toString(2))

    private suspend fun keepOneScrollAndReturn(): Pair<com.knowscroll.mobile.data.Universe,com.knowscroll.mobile.data.ScrollSession> {
        val api=ApiClient()
        waitText("Your universe")
        waitDescription("Enter Scroll")
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        compose.waitUntil(15000){store().read()?.exposureId?.isNotEmpty()==true}
        val opened=store().read() ?: error("Scroll retry envelope was not persisted")
        waitText(opened.item.title)
        compose.onNodeWithContentDescription("Keep this Scroll").performClick()
        waitText("Kept")
        val kept=store().read() ?: error("Accepted keep was not persisted")
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        waitText("Your universe")
        var current=api.getUniverse()
        repeat(40){
            if(current.traces.any{it.assetId==kept.item.assetId})return current to kept
            delay(250);current=api.getUniverse()
        }
        error("Worker did not project the kept Scroll")
    }

    private fun openClearConfirmation(){
        waitDescription("Clear Scroll history")
        compose.onNodeWithContentDescription("Clear Scroll history").performScrollTo().performClick()
        waitText("Clear Scroll history?")
    }

    /** Phase one exits normally; the host then force-stops the package, which kills app and test processes. */
    @Test fun processDeathPrepare() = runBlocking {
        val expected=ApiClient().getFeed().items.firstOrNull() ?: error("Need one unkept Scroll")
        waitText("Your universe")
        waitDescription("Enter Scroll")
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        waitText(expected.title)
        compose.waitUntil(10000){store().read()?.exposureId?.isNotEmpty()==true}
        compose.onNodeWithContentDescription("Scroll reading content").performScrollToNode(hasText("SOURCE"))
        compose.waitUntil(10000){(store().read()?.readingPosition ?: 0)>0}
        val session=store().read() ?: error("Scroll retry envelope was not persisted")
        val exposureRetry=ApiClient().postExposure(ExposureRequest(session.decisionId,session.item.assetId,session.clientExposureId))
        assertEquals(session.exposureId,exposureRetry.exposureId)
        assertEquals(session.exposureEventId,exposureRetry.eventId)
        capture("wave1-process-before",requireLightSurface=true)
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
        capture("wave1-process-restored",requireLightSurface=true)
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

    @Test fun clearHistoryConfirmationCancelIsHarmless() = runBlocking {
        val (before,kept)=keepOneScrollAndReturn()
        val cachedBefore=store().read() ?: error("Expected cached Scroll before cancellation")
        openClearConfirmation()
        compose.onNodeWithContentDescription("Cancel clear Scroll history").performClick()
        compose.onNodeWithText("Clear Scroll history?").assertDoesNotExist()
        val after=ApiClient().getUniverse()
        assertEquals(before.privacyEpoch,after.privacyEpoch)
        assertEquals(before.traces.map{it.eventId},after.traces.map{it.eventId})
        assertEquals(kept.clientEventId,store().read()?.clientEventId)
        assertEquals(cachedBefore.decisionId,store().read()?.decisionId)
        assertNull(store().readPendingClear())
    }

    @Test fun clearHistoryClearsNonemptyHistory() = runBlocking {
        val (before,kept)=keepOneScrollAndReturn()
        assertTrue(before.traces.isNotEmpty())
        openClearConfirmation()
        compose.onNodeWithContentDescription("Confirm clear Scroll history").performClick()
        compose.waitUntil(20000){store().readPendingClear()==null && store().read()==null}
        waitText("Your universe")
        val after=ApiClient().getUniverse()
        assertEquals(before.privacyEpoch+1,after.privacyEpoch)
        assertTrue(after.traces.isEmpty())
        assertNull(store().read())
        assertTrue(store().readVisited().isEmpty())
        assertEquals("universe",store().readScreen())
        assertEquals(after.privacyEpoch,store().readObservedPrivacyEpoch())
        assertTrue(ApiClient().getFeed().items.any{it.assetId==kept.item.assetId})
        writeJson("j003-clear-android.json",JSONObject().apply{
            put("beforePrivacyEpoch",before.privacyEpoch);put("privacyEpoch",after.privacyEpoch)
            put("clearedAssetId",kept.item.assetId);put("tracesAfter",after.traces.size)
            put("localSessionCleared",store().read()==null);put("sharedLibraryRetained",true)
        })
    }

    @Test fun pendingClearProcessDeathPrepare() = runBlocking {
        val (before,kept)=keepOneScrollAndReturn()
        openClearConfirmation()
        compose.onNodeWithContentDescription("Confirm clear Scroll history").performClick()
        compose.waitUntil(5000){store().readPendingClear()!=null}
        val pending=store().readPendingClear() ?: error("Clear request was not persisted before dispatch")
        delay(750)
        writeJson("j003-pending-before.json",JSONObject().apply{
            put("requestId",pending.requestId);put("expectedPrivacyEpoch",pending.expectedPrivacyEpoch)
            put("confirmation",pending.confirmation);put("assetId",kept.item.assetId)
            put("decisionId",kept.decisionId);put("exposureId",kept.exposureId)
            put("beforePrivacyEpoch",before.privacyEpoch);put("phase","before-force-stop")
        })
    }

    @Test fun pendingClearProcessDeathRestore() = runBlocking {
        val before=JSONObject(File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,"j003-pending-before.json").readText())
        val pendingAtMethodStart=store().readPendingClear()
        pendingAtMethodStart?.let{
            assertEquals(before.getString("requestId"),it.requestId)
            assertEquals(before.getLong("expectedPrivacyEpoch"),it.expectedPrivacyEpoch)
            assertEquals(before.getString("confirmation"),it.confirmation)
        }
        compose.waitUntil(20000){store().readPendingClear()==null}
        waitText("Your universe")
        val after=ApiClient().getUniverse()
        assertTrue(after.privacyEpoch>before.getLong("expectedPrivacyEpoch"))
        assertTrue(after.traces.isEmpty())
        assertNull(store().read())
        assertTrue(store().readVisited().isEmpty())
        assertEquals("universe",store().readScreen())
        writeJson("j003-pending-after.json",JSONObject().apply{
            put("requestId",before.getString("requestId"));put("expectedPrivacyEpoch",before.getLong("expectedPrivacyEpoch"))
            put("confirmation",before.getString("confirmation"));put("privacyEpoch",after.privacyEpoch)
            put("pendingObservedAtMethodStart",pendingAtMethodStart!=null)
            put("pending",false);put("localSessionCleared",true);put("visitedCleared",true)
        })
    }

    @Test fun higherPrivacyEpochPurgesCachedScrollOnForeground() = runBlocking {
        waitText("Your universe")
        waitDescription("Enter Scroll")
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        compose.waitUntil(15000){store().read()?.exposureId?.isNotEmpty()==true}
        val cached=store().read() ?: error("Expected a cached Scroll")
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        val request=HistoryClearRequest(UUID.randomUUID().toString(),cached.privacyEpoch)
        val receipt=ApiClient().clearScrollHistory(request)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        waitText("Your universe")
        compose.waitUntil(15000){store().read()==null && store().readObservedPrivacyEpoch()>=receipt.privacyEpoch}
        assertNull(store().read())
        assertTrue(store().readVisited().isEmpty())
        assertEquals("universe",store().readScreen())
        compose.onAllNodesWithText(cached.item.title).assertCountEquals(0)
        assertTrue(ApiClient().getUniverse().traces.isEmpty())
    }
}
