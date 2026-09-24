package com.knowscroll.mobile.data

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #132 (ADR-0038): the consent change's retry envelope is persisted whole -- the client request id
 * together with the exact content and the epoch it was sent with -- and is personal state, so every
 * privacy purge (Clear, Reset, sign-out, an epoch change the reader observes) drops it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InquiryConsentStoreTest {
    private fun freshStore(): StateStore {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        return StateStore(context)
    }

    private val request = InquiryConsentRequest("44444444-4444-4444-8444-444444444444", enabled = true, dailyLimit = 4, expectedPrivacyEpoch = 7)

    @Test
    fun thePendingChangeSurvivesAColdStartWholeAndClears() {
        freshStore().writePendingInquiryConsent(request)
        val cold = StateStore(ApplicationProvider.getApplicationContext())
        assertEquals(request, cold.readPendingInquiryConsent())
        cold.clearPendingInquiryConsent()
        assertNull(cold.readPendingInquiryConsent())
    }

    @Test
    fun aPrivacyPurgeDropsThePendingChange() {
        val store = freshStore()
        store.writePendingInquiryConsent(request)
        store.purgePrivateState("u1", 8)
        assertNull("consent is personal history: a purge leaves no request to replay", store.readPendingInquiryConsent())
    }
}
