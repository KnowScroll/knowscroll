package com.knowscroll.mobile.data

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #166: the answer a reader is waiting for survives the process whole, clears once it is final, and
 * is personal state, so every privacy purge (Clear, Reset, sign-out, an observed epoch change) drops it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WatchedAnswerStoreTest {
    private fun freshStore(): StateStore {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        return StateStore(context)
    }

    private val watched = WatchedAnswer("55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", 2, "Why do tides come twice a day?")

    @Test
    fun theWatchedAnswerSurvivesAColdStartWholeAndClears() {
        freshStore().writeWatchedAnswer(watched)
        val cold = StateStore(ApplicationProvider.getApplicationContext())
        assertEquals(watched, cold.readWatchedAnswer())
        cold.clearWatchedAnswer()
        assertNull(cold.readWatchedAnswer())
    }

    @Test
    fun aPrivacyPurgeDropsTheWatchedAnswer() {
        val store = freshStore()
        store.writeWatchedAnswer(watched)
        store.purgePrivateState("u1", 3)
        assertNull(store.readWatchedAnswer())
    }
}
