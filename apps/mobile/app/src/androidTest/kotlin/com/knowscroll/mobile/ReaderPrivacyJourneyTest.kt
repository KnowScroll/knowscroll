package com.knowscroll.mobile

import android.graphics.Bitmap
import android.content.Context
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.HistoryClearRequest
import com.knowscroll.mobile.data.StateStore
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs only against the disposable .journey application and its real API.
 * It proves that a foreground privacy reconciliation removes a source sheet
 * and its private reader envelope before stale content can reappear.
 */
@RunWith(AndroidJUnit4::class)
class ReaderPrivacyJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun store() = StateStore(InstrumentationRegistry.getInstrumentation().targetContext)

    private fun waitText(text: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitDescription(description: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitTruthState(truthState: String) = compose.waitUntil(15_000) {
        compose.onAllNodes(hasText(truthState, substring = true, ignoreCase = true))
            .fetchSemanticsNodes().isNotEmpty()
    }

    private fun fingerprint(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
        .take(16)

    private fun captureSourceSheet() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.waitForIdleSync()
        val bitmap: Bitmap = instrumentation.uiAutomation.takeScreenshot()
            ?: error("Android screenshot was unavailable")
        File(instrumentation.targetContext.filesDir, "reader-privacy.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    private fun writeReceipt(receipt: JSONObject) {
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "reader-privacy.json")
            .writeText(receipt.toString(2))
    }

    @Test fun sourceSheetClearOnForeground() = runBlocking {
        assumeTrue("This journey requires the disposable .journey application", BuildConfig.APPLICATION_ID.endsWith(".journey"))

        val api = ApiClient()
        waitText("Your universe")
        waitDescription("Enter Scroll")
        compose.onAllNodesWithContentDescription("Enter Scroll").onFirst().performClick()
        compose.waitUntil(15_000) {
            store().read()?.exposureId?.isNotEmpty() == true
        }
        val opened = store().read() ?: error("Scroll retry envelope was not persisted")
        waitText(opened.item.title)

        compose.onAllNodesWithContentDescription("Sources for this Scroll").onFirst().performClick()
        waitText(opened.item.sourceTitle)
        waitTruthState(opened.item.truthState)
        val sheetEnvelope = store().read() ?: error("Source sheet changed the reader envelope")
        assertEquals(opened.item.assetId, sheetEnvelope.item.assetId)
        assertEquals(opened.clientExposureId, sheetEnvelope.clientExposureId)
        assertEquals(opened.clientEventId, sheetEnvelope.clientEventId)
        assertEquals(opened.exposureId, sheetEnvelope.exposureId)
        assertEquals(opened.readingPosition, sheetEnvelope.readingPosition)
        captureSourceSheet()

        compose.pressBack()
        waitDescription("Scroll reading content")
        waitDescription("Sources for this Scroll")
        compose.onAllNodesWithContentDescription("Sources for this Scroll").onFirst().performClick()
        waitText(opened.item.sourceTitle)
        waitTruthState(opened.item.truthState)

        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        val clearRequest = HistoryClearRequest(
            requestId = UUID.randomUUID().toString(),
            expectedPrivacyEpoch = opened.privacyEpoch,
            universeId = opened.universeId,
        )
        val clearReceipt = api.clearScrollHistory(clearRequest)
        assertTrue("Clear did not advance privacy epoch", clearReceipt.privacyEpoch > opened.privacyEpoch)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)

        waitText("Your universe")
        compose.waitUntil(15_000) {
            store().read() == null && store().readVisited().isEmpty() &&
                store().readObservedUniverseId() == opened.universeId &&
                store().readObservedPrivacyEpoch() >= clearReceipt.privacyEpoch
        }
        compose.onAllNodesWithText(opened.item.title).assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Sources for this Scroll").assertCountEquals(0)
        assertEquals("universe", store().readScreen())
        assertNull(store().readPendingClear())
        assertNull(store().read())
        assertTrue(store().readVisited().isEmpty())
        val current = api.getUniverse()
        assertEquals(clearReceipt.privacyEpoch, current.privacyEpoch)
        assertFalse(current.traces.any { it.assetId == opened.item.assetId })

        writeReceipt(JSONObject().apply {
            put("journey", "reader-privacy")
            put("application", "journey")
            put("assetFingerprint", fingerprint(opened.item.assetId))
            put("universeFingerprint", fingerprint(opened.universeId))
            put("sourceShown", true)
            put("truthState", opened.item.truthState)
            put("retryEnvelopePreservedBeforeClear", true)
            put("privacyEpochBefore", opened.privacyEpoch)
            put("privacyEpochAfter", clearReceipt.privacyEpoch)
            put("foregroundPurgedReader", true)
            put("sourceSheetRemoved", true)
            put("visitedRemoved", true)
            put("result", "passed")
        })
    }
}
