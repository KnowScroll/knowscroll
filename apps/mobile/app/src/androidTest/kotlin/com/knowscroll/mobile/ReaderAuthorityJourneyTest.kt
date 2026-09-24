package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.StateStore
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The runner implements the control endpoint by revoking the disposable
 * journey session in PostgreSQL. It never supplies a fabricated feed result.
 */
@RunWith(AndroidJUnit4::class)
class ReaderAuthorityJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)

    private fun guardJourneyApp() {
        check(instrumentation.targetContext.packageName.startsWith("com.knowscroll.mobile.journey")) {
            "Reader authority verification requires the separate journey app"
        }
    }

    private fun waitText(text: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    }

    private fun openReader() {
        guardJourneyApp()
        compose.waitUntil(15_000) {
            compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        compose.waitUntil(15_000) {
            store().read()?.exposureId?.isNotEmpty() == true &&
                compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun reachThreshold() {
        compose.onNodeWithContentDescription("Scroll reading content")
            .performScrollToNode(hasContentDescription("Get the next Scroll"))
        compose.onNodeWithContentDescription("Get the next Scroll").assertIsDisplayed()
    }

    private fun revokeJourneySessions(): Int {
        val connection = URL(BuildConfig.KS_DEBUG_API_BASE + "/__journey/revoke-sessions")
            .openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }
            connection.responseCode.also { check(it in 200..299) { "Journey session revocation control was unavailable: HTTP $it" } }
        } finally {
            connection.disconnect()
        }
    }

    private fun fingerprint(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
        .take(16)

    private fun capture() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        val bitmap: Bitmap = instrumentation.uiAutomation.takeScreenshot()
            ?: error("Android screenshot was unavailable")
        File(instrumentation.targetContext.filesDir, "reader-authority.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    private fun writeReceipt(value: JSONObject) {
        File(instrumentation.targetContext.filesDir, "reader-authority.json").writeText(value.toString(2))
    }

    @Test fun readerNextRevokedSessionFailsClosed() = runBlocking {
        openReader()
        val before = store().read() ?: error("Expected a persisted exposed Scroll")
        reachThreshold()
        val controlStatus = revokeJourneySessions()

        compose.onNodeWithContentDescription("Get the next Scroll").performClick()
        waitText("The universe is unreachable.")
        waitText("This device session is no longer available.")
        compose.waitUntil(15_000) {
            store().read() == null && store().readVisited().isEmpty() &&
                compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isEmpty() &&
                compose.onAllNodesWithContentDescription("Sources for this Scroll").fetchSemanticsNodes().isEmpty()
        }
        compose.onAllNodesWithText(before.item.title).assertCountEquals(0)
        assertEquals("universe", store().readScreen())
        assertNull(store().readPendingClear())
        assertNull(store().read())
        assertTrue(store().readVisited().isEmpty())
        capture()

        writeReceipt(JSONObject().apply {
            put("scenario", "readerNextRevokedSessionFailsClosed")
            put("application", "journey")
            put("controlStatus", controlStatus)
            put("assetFingerprint", fingerprint(before.item.assetId))
            put("universeFingerprint", fingerprint(before.universeId))
            put("privacyEpoch", before.privacyEpoch)
            put("exposureWasVisibleBeforeRevocation", before.exposureId.isNotEmpty())
            put("nextFeed401FailedClosed", true)
            put("readerCachePurged", true)
            put("visitedPurged", true)
            put("sourceControlRemoved", true)
            put("oldPageAbsent", true)
            put("result", "passed")
        })
    }
}
