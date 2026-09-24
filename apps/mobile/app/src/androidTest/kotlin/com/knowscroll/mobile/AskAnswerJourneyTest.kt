package com.knowscroll.mobile

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.StateStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * #132 — ADR-0033 live journey on a real emulator against a disposable API, worker and
 * PostgreSQL loaded with the editorial substrate (scripts/android-semantic-journey.py).
 *
 * A reader reaches an ordinary Scroll, opens Ask, records a question, and -- as a separate,
 * explicit action -- asks for an answer. It waits for the answer service to settle and checks the
 * result UI honestly reflects what the server returned: either the answer with at least one cited
 * quote, or the "doesn't say" line. The runner then verifies the recorded Ask and its answer in
 * the database from the written receipt (never from the answer text itself, which this test does
 * not persist).
 */
@RunWith(AndroidJUnit4::class)
class AskAnswerJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun store() = StateStore(instrumentation.targetContext)

    private fun screenshot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun textShown(text: String, substring: Boolean = false): Boolean =
        compose.onAllNodes(hasText(text, substring = substring), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun waitReadingExposed() = compose.waitUntil(20_000) {
        val s = store().read()
        s != null && s.exposureId.isNotEmpty() &&
            compose.onAllNodesWithContentDescription("Scroll reading content").fetchSemanticsNodes().isNotEmpty()
    }

    /** The Ask panel's own stage, read from its `stateDescription` (see `askStateDescription` /
     * `Ask.kt`) -- never guessed from the visible copy, and never carrying the answer text. */
    private fun askPanelState(): String? =
        compose.onAllNodesWithContentDescription("Ask panel").fetchSemanticsNodes()
            .firstOrNull()?.config?.getOrElseNullable(SemanticsProperties.StateDescription) { null }

    @Test
    fun asksAQuestionRequestsAnAnswerAndShowsExactlyWhatCameBack() {
        try { journey() } catch (failure: Throwable) { runCatching { screenshot("ask-answer-failure.png") }; throw failure }
    }

    private fun journey() {
        check(instrumentation.targetContext.packageName == "com.knowscroll.mobile.journey") { "The Ask/answer journey requires the separate journey app" }
        compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("Enter Scroll").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Enter Scroll").assertIsEnabled().performClick()
        waitReadingExposed()
        val scroll = store().read()!!

        // "Ask" lives in the fixed reader toolbar below the scrollable content, like "Why" and
        // "Keep" -- no scroll is needed to reach it (see SemanticWhyJourneyTest).
        compose.onNodeWithContentDescription("Ask about this Scroll").performClick()
        compose.waitUntil(10_000) { textShown("Ask about this Scroll") && askPanelState() == "composing" }

        val question = "Does this Scroll say anything about tides?"
        compose.onNodeWithText("Your question").performScrollTo().performTextInput(question)
        compose.onNodeWithContentDescription("Send this question").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(20_000) { askPanelState()?.startsWith("recorded:") == true }
        val askId = askPanelState()!!.substringAfter("recorded:")
        assertTrue("a recorded Ask must carry a real askId", askId.isNotBlank())
        screenshot("ask-recorded.png")

        compose.onNodeWithText("Get an answer").performScrollTo().performClick()
        compose.waitUntil(60_000) {
            val state = askPanelState()
            state != null && (state.startsWith("final:") || state == "timedOut:$askId")
        }
        val settled = askPanelState()!!
        assertTrue("the answer must settle within the bounded wait, not time out: $settled", settled.startsWith("final:"))
        val status = settled.substringAfter(':').substringAfter(':')
        assertTrue(
            "expected an answered or not_in_source result, got $status",
            status == "answered" || status == "not_in_source",
        )
        screenshot("ask-answer.png")

        val basisQuotes = mutableListOf<String>()
        if (status == "answered") {
            compose.waitUntil(10_000) { textShown("FROM THIS SCROLL") }
            compose.onNodeWithText("FROM THIS SCROLL").performScrollTo()
            compose.onNodeWithText("WHERE IT STOPS").performScrollTo()
            compose.onAllNodes(hasText("· ", substring = true), useUnmergedTree = true).fetchSemanticsNodes().forEach { node ->
                node.config.getOrElseNullable(SemanticsProperties.Text) { null }?.firstOrNull()?.text
                    ?.takeIf { it.startsWith("· ") }?.let { basisQuotes += it.removePrefix("· ") }
            }
            assertTrue("an answered result must cite at least one quote", basisQuotes.isNotEmpty())
        } else {
            compose.waitUntil(10_000) { textShown("This Scroll doesn't say.") }
            compose.onNodeWithText("This Scroll doesn't say.").performScrollTo()
        }

        File(instrumentation.targetContext.filesDir, "ask-answer.json").writeText(
            JSONObject().apply {
                put("askId", askId)
                put("status", status)
                put("basisQuotes", JSONArray(basisQuotes))
                put("scrollAssetId", scroll.item.assetId)
            }.toString(2),
        )
    }
}
