package com.knowscroll.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.data.StateStore
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Only visible drawn encounters earn fixture exposures; fixture setup never posts hidden ones. */
@RunWith(AndroidJUnit4::class)
class OwnerPreviewSetupTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun prepareVisibleWorlds() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName.endsWith(".journey"))
        val store = StateStore(context)
        compose.waitUntil(20_000) {
            compose
                .onAllNodesWithContentDescription("Enter Scroll")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithContentDescription("Enter Scroll").performClick()
        repeat(2) { index ->
            compose.waitUntil(20_000) { store.read()?.exposureId?.isNotEmpty() == true }
            compose.onNodeWithContentDescription("Keep this Scroll").performClick()
            compose.waitUntil(20_000) { store.read()?.keepJobId?.isNotEmpty() == true }
            if (index == 0) {
                val asset = store.read()!!.item.assetId
                compose
                    .onNodeWithContentDescription("Scroll reading content")
                    .performScrollToNode(hasContentDescription("Get the next Scroll"))
                compose.onNodeWithContentDescription("Get the next Scroll").performClick()
                compose.waitUntil(20_000) { store.read()?.item?.assetId != asset }
            }
        }
        compose.onNodeWithContentDescription("Return to the universe").performClick()
        compose.waitUntil(20_000) {
            compose
                .onAllNodesWithContentDescription("Open the system view")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
    }
}
