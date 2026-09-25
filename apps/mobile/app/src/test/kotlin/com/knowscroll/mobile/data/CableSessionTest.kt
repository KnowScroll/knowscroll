package com.knowscroll.mobile.data

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CableSessionTest {
    private fun session(kind: String) =
        ScrollSession(
            "decision-$kind",
            ScrollItem(
                "asset-$kind",
                1,
                kind,
                "Title",
                "Summary",
                "Body",
                "Source",
                "https://example.test",
                "documented",
                "",
                if (kind == "Reel") ReelMedia("/v1/media/" + "a".repeat(64), 30.0, "16:9", true)
                else null,
            ),
            4,
            "universe-a",
            readingPosition = if (kind == "Reel") 15000 else 670,
        )

    @Test
    fun coldModeReturnRetainsPositionAndWholeRetryEnvelope() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        val store = StateStore(context)
        val scroll = session("Scroll")
        val reel = session("Reel")
        store.write(scroll)
        store.writeCableMode("Reel")
        store.write(reel)
        val cold = StateStore(context)
        assertEquals("Reel", cold.readCableMode())
        assertEquals(scroll, cold.readCableSession("Scroll"))
        assertEquals(reel, cold.readCableSession("Reel"))
        cold.writeReadingPosition(reel.item.assetId, 17200)
        assertEquals(17200, cold.readCableSession("Reel")!!.readingPosition)
        assertEquals(scroll.clientExposureId, cold.readCableSession("Scroll")!!.clientExposureId)
    }

    /** #183 (ADR-0043 §5): Reel mode survives a continuation. The continuation (always a Scroll) is
     * kept in the Reel bank it was followed in, so a cold start reopens it in Reel mode, and the
     * reader's own Scroll-mode place is left alone. */
    @Test
    fun aContinuationFollowedFromAReelStaysInReelMode() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        val store = StateStore(context)
        val scroll = session("Scroll")
        val reel = session("Reel")
        val continuation = session("Scroll").copy(
            item = session("Scroll").item.copy(assetId = "asset-continued"),
            branchFrom = BranchFrom(reel.item.assetId, reel.item.title, "Tides are explained by Gravity", "bridge-1", recorded = true),
        )
        store.write(scroll)
        store.writeCableMode("Reel")
        store.write(reel)
        store.writeCableMode(cableModeFor(continuation, store.readCableMode()))
        store.write(continuation)
        val cold = StateStore(context)
        assertEquals("Reel", cold.readCableMode())
        assertEquals(continuation, cold.readSelectedCableSession())
        assertEquals("the Scroll-mode place is not replaced by the continuation", scroll, cold.readCableSession("Scroll"))
        assertEquals("a discovery is read in its own kind's mode", "Scroll", cableModeFor(scroll, "Reel"))
    }

    @Test
    fun privacyErasesBothBanksAndTheirRetryIdentities() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = StateStore(context)
        store.write(session("Scroll"))
        store.write(session("Reel"))
        store.purgePrivateState("universe-a", 5)
        assertNull(store.read())
        assertNull(store.readCableSession("Scroll"))
        assertNull(store.readCableSession("Reel"))
        assertEquals(5L, store.readObservedPrivacyEpoch())
    }

    @Test
    fun failedFirstLoadDoesNotRestoreTheOtherMode() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("ks_session_v1", 0).edit().clear().commit()
        val store = StateStore(context)
        store.write(session("Scroll"))
        store.writeCableMode("Reel") // The Reel GET fails before any envelope is written.
        val cold = StateStore(context)
        assertEquals("Reel", cold.readCableMode())
        assertNull(cold.readSelectedCableSession())
        assertNotNull(cold.readCableSession("Scroll"))
    }
}
