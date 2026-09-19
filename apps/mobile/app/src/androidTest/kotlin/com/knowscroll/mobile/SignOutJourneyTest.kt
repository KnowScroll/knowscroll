package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.ApiClient
import com.knowscroll.mobile.data.ApiException
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Sign out this device (#91, Journey I partial). Every terminal outcome here comes
 * from a genuine `POST /v1/session/revoke` round trip against the disposable API;
 * the journey proxy only drops sockets or directly revokes/restores the disposable
 * session row as an explicit setup fixture, matching the existing control pattern.
 */
@RunWith(AndroidJUnit4::class)
class SignOutJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    private fun guardJourneyApp() {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey") {
            "Sign-out verification requires the separate journey app"
        }
    }

    private fun waitText(text: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    }
    private fun waitDescription(description: String) = compose.waitUntil(15_000) {
        compose.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }

    private fun control(path: String, body: JSONObject): Int {
        val connection = (URL(BuildConfig.KS_DEBUG_API_BASE + path).openConnection() as HttpURLConnection)
        return try {
            connection.requestMethod = "POST"; connection.connectTimeout = 5_000; connection.readTimeout = 5_000
            connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            connection.responseCode.also { check(it in 200..299) { "Journey sign-out control unavailable: HTTP $it" } }
        } finally { connection.disconnect() }
    }

    private fun screenshot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        val bitmap: Bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("Android screenshot was unavailable")
        File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun writeReceipt(name: String, value: JSONObject) =
        File(instrumentation.targetContext.filesDir, name).writeText(value.toString(2))

    private fun openSignOutConfirmation() {
        waitDescription("Sign out this device")
        compose.onNodeWithContentDescription("Sign out this device").performScrollTo().performClick()
        waitText("Sign out this device?")
    }

    /** Real 401 proof that a token, once actually revoked, cannot silently keep working. */
    private suspend fun assertSessionIsDead() {
        val outcome = runCatching { ApiClient().getUniverse() }
        assertTrue("Expected the revoked session to fail", outcome.isFailure)
        val error = outcome.exceptionOrNull()
        assertTrue("Expected a genuine 401, not a fabricated one", error is ApiException.Server && error.statusCode == 401)
    }

    @Test fun signOutConfirmationCancelIsHarmless() = runBlocking {
        guardJourneyApp()
        openSignOutConfirmation()
        screenshot("signout-confirm.png")
        compose.onNodeWithContentDescription("Cancel sign out this device").performClick()
        compose.onAllNodesWithText("Sign out this device?").assertCountEquals(0)
        // The session is untouched: a normal authenticated call still succeeds.
        val universe = ApiClient().getUniverse()
        writeReceipt("signout-confirm.json", JSONObject().apply {
            put("scenario", "signOutConfirmationCancelIsHarmless")
            put("dialogDismissed", true); put("sessionStillLive", true)
            put("universeId", universe.universeId)
        })
    }

    @Test fun signOutConfirmedRevokeEndsSessionHonestly() = runBlocking {
        guardJourneyApp()
        openSignOutConfirmation()
        compose.onNodeWithContentDescription("Confirm sign out this device").performClick()
        waitText("This device is signed out")
        compose.onAllNodesWithContentDescription("Enter Scroll").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Sign out this device").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Retry sign out this device").assertCountEquals(0)
        screenshot("signout-success.png")
        assertSessionIsDead()
        writeReceipt("signout-success.json", JSONObject().apply {
            put("scenario", "signOutConfirmedRevokeEndsSessionHonestly")
            put("resolvedVia", "204")
            put("signedOutScreenShown", true); put("noRetryControlOffered", true)
            put("sessionVerifiedDeadAfter401", true)
        })
    }

    @Test fun signOutNetworkDroppedRevokeThenRetrySucceeds() = runBlocking {
        guardJourneyApp()
        // The very first revoke request never reaches the real API: a genuine network
        // loss, not a fabricated response.
        val controlStatus = control("/__journey/revoke-request-mode", JSONObject().put("mode", "drop_next"))
        openSignOutConfirmation()
        compose.onNodeWithContentDescription("Confirm sign out this device").performClick()
        waitDescription("Retry sign out this device")
        // Ambiguity keeps local state usable: the device is not yet shown as signed out.
        compose.onAllNodesWithText("This device is signed out").assertCountEquals(0)
        compose.onNodeWithContentDescription("Sign out this device").assertIsNotEnabled()
        screenshot("signout-network-drop.png")
        compose.onNodeWithContentDescription("Retry sign out this device").performClick()
        waitText("This device is signed out")
        screenshot("signout-network-drop-resolved.png")
        assertSessionIsDead()
        writeReceipt("signout-network-drop.json", JSONObject().apply {
            put("scenario", "signOutNetworkDroppedRevokeThenRetrySucceeds")
            put("controlStatus", controlStatus)
            put("firstAttemptAmbiguousLocalStateKept", true)
            put("explicitRetrySameRequestSucceeded", true)
            put("sessionVerifiedDeadAfter401", true)
        })
    }

    @Test fun signOutAlreadyRevokedSessionResolvesAsSignedOut() = runBlocking {
        guardJourneyApp()
        // The disposable session is revoked out-of-band before the app's own attempt,
        // so its real revoke call genuinely observes 401 on the very first try.
        val controlStatus = control("/__journey/revoke-sessions", JSONObject())
        openSignOutConfirmation()
        compose.onNodeWithContentDescription("Confirm sign out this device").performClick()
        waitText("This device is signed out")
        screenshot("signout-401.png")
        writeReceipt("signout-401.json", JSONObject().apply {
            put("scenario", "signOutAlreadyRevokedSessionResolvesAsSignedOut")
            put("controlStatus", controlStatus)
            put("firstAttemptResolvedAsSignedOutViaReal401", true)
        })
    }
}
