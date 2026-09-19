package com.knowscroll.mobile.ui

import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.TraceRevisit
import com.knowscroll.mobile.data.TraceRevisitSession
import com.knowscroll.mobile.data.FeedResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TraceRevisitStateTest {
    private val requested=TraceRevisitSession("event-a","asset-a",4,"universe-a",readingPosition=19)
    private fun receipt(
        eventId:String=requested.eventId,assetId:String=requested.assetId,
        universeId:String=requested.universeId,epoch:Long=requested.privacyEpoch,revision:Int=2
    )=TraceRevisit(
        eventId,universeId,epoch,"exposure-a","2026-09-17T00:00:00.000Z",
        ScrollItem(assetId,revision,"Scroll","Title","Summary","Body","Source","https://example.test","documented","")
    )

    @Test fun acceptedReceiptRetainsOnlyIdentityRevisionAndPosition() {
        assertEquals(requested.copy(revision=2),acceptTraceRevisit(receipt(),requested,"universe-a",4))
    }

    @Test fun mismatchedTraceScopeAssetOrPriorRevisionCannotRender() {
        assertNull(acceptTraceRevisit(receipt(eventId="other"),requested,"universe-a",4))
        assertNull(acceptTraceRevisit(receipt(assetId="other"),requested,"universe-a",4))
        assertNull(acceptTraceRevisit(receipt(universeId="other"),requested,"universe-a",4))
        assertNull(acceptTraceRevisit(receipt(epoch=3),requested,"universe-a",4))
        assertNull(acceptTraceRevisit(receipt(revision=3),requested.copy(revision=2),"universe-a",4))
    }

    @Test fun reconciliationPurgesAuthorityAndMalformedResponsesButKeepsTransportRetryIdentity() {
        assertTrue(reconciliationFailurePurgesPrivateState(ApiException.Server(401,"rejected")))
        assertTrue(reconciliationFailurePurgesPrivateState(ApiException.Server(422,"malformed")))
        assertTrue(reconciliationFailurePurgesPrivateState(ApiException.MissingToken))
        assertFalse(reconciliationFailurePurgesPrivateState(ApiException.Network("offline")))
        assertFalse(reconciliationFailurePurgesPrivateState(ApiException.Server(503,"temporary")))
    }

    @Test fun nextDiscoveryExcludesTheCurrentlyReopenedTrace() {
        val trace=receipt().scroll
        val next=trace.copy(assetId="fresh")
        val feed=FeedResponse("decision","universe-a",0,4,listOf(trace,next))
        assertEquals(DiscoverySelection.Item(next),selectDiscovery(feed,"universe-a",4,emptySet(),trace.assetId))
    }
}
