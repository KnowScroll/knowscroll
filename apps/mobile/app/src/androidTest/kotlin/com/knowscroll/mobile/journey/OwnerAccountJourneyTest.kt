package com.knowscroll.mobile.journey

import android.graphics.Bitmap
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.MainActivity
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #135: the owner's real, sign-in-backed identity and the privacy-lifecycle parity screen, end to
 * end, on an app built WITHOUT a development token (`KS_DEV_TOKEN=` empty for the Gradle build --
 * see `scripts/android-semantic-journey.py`'s `owner` mode). That is the one thing this test
 * proves that no other journey does: the sign-in screen, not a baked-in dev session, is what
 * actually gates this build.
 *
 * In its own package (`com.knowscroll.mobile.journey`, distinct from every other androidTest class
 * here) so it is never accidentally picked up by an ordinary instrumentation run against a journey
 * app that still carries a dev token -- the `owner` runner mode selects it explicitly by class name.
 *
 * The magic link itself never crosses this test's own process or the disposable API's HTTP
 * surface: the host runner polls the API's development sink file on the machine running the
 * emulator and pushes its content into this app's own private files dir
 * (`adb shell run-as <pkg> sh -c 'cat > files/magic-link.txt'`). This test only waits for that
 * pushed file, reads it once and deletes it.
 */
@RunWith(AndroidJUnit4::class)
class OwnerAccountJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    private fun guardJourneyApp() {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey") {
            "The owner account journey requires the separate journey app"
        }
    }

    private fun ownerEmail(): String =
        InstrumentationRegistry.getArguments().getString("ownerEmail")
            ?: error("-e ownerEmail is required for the owner account journey")

    private fun waitText(text: String, timeoutMs: Long = 15_000) = compose.waitUntil(timeoutMs) {
        compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitDescription(description: String, timeoutMs: Long = 15_000) = compose.waitUntil(timeoutMs) {
        compose.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        val bitmap: Bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("Android screenshot was unavailable")
        File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** Content-free by construction: only ids, epochs, booleans and step names -- never an
     * address, a token or a link (docs/AGENTS: receipts this suite writes are reviewed). */
    private fun writeReceipt(name: String, value: JSONObject) =
        File(instrumentation.targetContext.filesDir, name).writeText(value.toString(2))

    /** Polls this app's own files dir for the link the host runner pushed from the API's
     * development sink. This process never touches the sink itself. */
    private fun waitForPushedMagicLink(timeoutMs: Long = 60_000): String {
        val file = File(instrumentation.targetContext.filesDir, "magic-link.txt")
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!file.exists() || file.length() == 0L) {
            check(System.currentTimeMillis() < deadline) {
                "Timed out waiting for the host to push magic-link.txt"
            }
            Thread.sleep(500)
        }
        val content = file.readText().trim()
        file.delete()
        return content
    }

    @Test
    fun ownerSignsInReadsPausesExportsResetsAndDeletesTheirAccount() {
        guardJourneyApp()

        // 1. No dev token on this build: the sign-in screen is what greets the owner, not the
        // reader -- the one thing only this journey mode (KS_DEV_TOKEN empty) can prove.
        waitDescription("Email")
        compose.onAllNodesWithContentDescription("Enter Scroll").assertCountEquals(0)
        screenshot("owner-01-sign-in.png")

        // 2. Request a magic link for the owner's real address.
        compose.onNodeWithContentDescription("Email").performTextInput(ownerEmail())
        compose.onNodeWithContentDescription("Send sign-in link").assertIsEnabled().performClick()
        waitText("Check your email")
        screenshot("owner-02-link-requested.png")

        // 3. Wait for the host to push the real, single-use link; paste and submit it.
        val link = waitForPushedMagicLink()
        compose.onNodeWithContentDescription("Paste your sign-in link").performTextInput(link)
        compose.onNodeWithContentDescription("Sign in with this link").assertIsEnabled().performClick()
        waitDescription("Enter Scroll", timeoutMs = 20_000)
        screenshot("owner-03-signed-in.png")

        // 4. A real Scroll is reading (the ordinary Cable path, exactly like every other journey).
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        compose.waitUntil(15_000) {
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
        }
        screenshot("owner-04-reading.png")
        compose.onNodeWithText("Atlas").performClick() // BottomCompass: back to the universe
        waitDescription("Open Privacy & account")

        // 5. Privacy: pause, then resume.
        compose.onNodeWithContentDescription("Open Privacy & account").performClick()
        waitText("Recording is on")
        screenshot("owner-05-privacy.png")
        compose.onNodeWithContentDescription("Pause recording").performClick()
        waitText("Recording is paused since")
        screenshot("owner-06-paused.png")
        compose.onNodeWithContentDescription("Resume recording").performClick()
        waitText("Recording is on")
        screenshot("owner-07-resumed.png")

        // 6. Export: the journey build writes straight to the app cache instead of driving the
        // system Storage Access Framework picker (a separate process/activity) -- see
        // PrivacyScreen's `isJourneyBuild` gate.
        compose.onNodeWithContentDescription("Export my data").performClick()
        waitDescription("Save the export file", timeoutMs = 20_000)
        compose.onNodeWithContentDescription("Save the export file").performClick()
        compose.waitUntil(15_000) {
            compose.onAllNodesWithContentDescription("Export my data").fetchSemanticsNodes().isNotEmpty()
        }
        val exportFile = File(instrumentation.targetContext.cacheDir, "owner-journey-export.json")
        assertTrue("the export must have been written to the app cache", exportFile.exists() && exportFile.length() > 0)
        val exportRowCounts = runCatching { JSONObject(exportFile.readText()).optJSONObject("rowCounts") }.getOrNull()
        screenshot("owner-08-exported.png")

        // 7. Delete account: its own deliberate confirmation and its own literal (ADR-0035).
        compose.onNodeWithContentDescription("Delete my account").performClick()
        waitText("Delete your account and history?")
        screenshot("owner-09-delete-confirm.png")
        compose.onNodeWithContentDescription("Confirm delete my account").performClick()
        waitDescription("Email", timeoutMs = 20_000)
        waitText("Your account and history were deleted.")
        compose.onAllNodesWithContentDescription("Enter Scroll").assertCountEquals(0)
        screenshot("owner-10-deleted.png")

        writeReceipt(
            "owner-account.json",
            JSONObject()
                .put("scenario", "ownerSignsInReadsPausesExportsResetsAndDeletesTheirAccount")
                .put("signedInViaPastedMagicLink", true)
                .put("readARealScroll", true)
                .put("pausedRecording", true)
                .put("resumedRecording", true)
                .put("exportedToAppCache", exportFile.exists())
                .put("exportHadRowCounts", exportRowCounts != null)
                .put("accountDeleted", true)
                .put("returnedToSignInWithDeletedMessage", true),
        )
    }
}
