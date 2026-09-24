package com.knowscroll.mobile.data

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #135: the pending-privacy-request retry envelope, mirroring `writePendingClear`/
 * `readPendingClear` (see `CableSessionTest` for the equivalent reader-state coverage). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrivacyRequestStoreTest {
    private fun freshStore(): StateStore {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        return StateStore(context)
    }

    @Test
    fun aPendingRequestSurvivesAColdStart() {
        val store = freshStore()
        store.writePendingPrivacyRequest("reset", "req-1", 4)
        val cold = StateStore(ApplicationProvider.getApplicationContext())
        assertEquals(PendingPrivacyRequest("req-1", 4), cold.readPendingPrivacyRequest("reset"))
    }

    @Test
    fun eachIntentHasItsOwnIndependentSlot() {
        val store = freshStore()
        store.writePendingPrivacyRequest("pause", "req-pause", 1)
        store.writePendingPrivacyRequest("delete", "req-delete", 2)
        assertEquals(PendingPrivacyRequest("req-pause", 1), store.readPendingPrivacyRequest("pause"))
        assertEquals(PendingPrivacyRequest("req-delete", 2), store.readPendingPrivacyRequest("delete"))
        assertNull(store.readPendingPrivacyRequest("resume"))
        store.clearPendingPrivacyRequest("pause")
        assertNull(store.readPendingPrivacyRequest("pause"))
        assertEquals(PendingPrivacyRequest("req-delete", 2), store.readPendingPrivacyRequest("delete"))
    }

    @Test
    fun writingAgainReplacesTheSameIntentsSlot() {
        val store = freshStore()
        store.writePendingPrivacyRequest("export", "req-a", 1)
        store.writePendingPrivacyRequest("export", "req-b", 2)
        assertEquals(PendingPrivacyRequest("req-b", 2), store.readPendingPrivacyRequest("export"))
    }
}
