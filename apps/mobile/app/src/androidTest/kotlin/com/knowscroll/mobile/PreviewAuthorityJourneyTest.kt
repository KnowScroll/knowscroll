package com.knowscroll.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.*
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewAuthorityJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun previewAndBothBanksDisappearAfterEpochChange() = runBlocking<Unit> {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName.endsWith(".journey"))
        compose.waitUntil(20_000) {
            compose
                .onAllNodesWithContentDescription("Enter Scroll")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        compose.waitUntil(20_000) { StateStore(context).read()?.exposureId?.isNotEmpty() == true }
        compose.onNodeWithContentDescription("Cable Reel").performClick()
        compose.waitUntil(20_000) {
            StateStore(context).read()?.item?.kind == "Reel" &&
                StateStore(context).read()?.exposureId?.isNotEmpty() == true
        }
        compose.onNodeWithText("Open authored interaction preview →").performClick()
        compose.waitUntil(20_000) {
            compose
                .onAllNodesWithContentDescription("Preview Scroll reading")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        val api = ApiClient()
        val before = api.getUniverse()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        api.clearScrollHistory(
            HistoryClearRequest(
                requestId = UUID.randomUUID().toString(),
                expectedPrivacyEpoch = before.privacyEpoch,
                universeId = before.universeId,
            )
        )
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(20_000) {
            compose
                .onAllNodesWithContentDescription("Enter Scroll")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onAllNodesWithText("Close preview").assertCountEquals(0)
        assertNull(StateStore(context).readCableSession("Scroll"))
        assertNull(StateStore(context).readCableSession("Reel"))
        compose.activityRule.scenario.recreate()
        compose.waitUntil(20_000) {
            compose
                .onAllNodesWithContentDescription("Enter Scroll")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onAllNodesWithText("Close preview").assertCountEquals(0)
    }
}
