package com.knowscroll.mobile.ui

import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.FeedResponse
import com.knowscroll.mobile.data.ScrollItem
import org.junit.Assert.*
import org.junit.Test

class ReaderDiscoveryTest {
    private fun item(id: String) = ScrollItem(id, 1, "Scroll", "Title", "Summary", "Body", "Source", "https://example.test", "documented", "Editorial selection")
    private fun feed(universe: String = "owner", epoch: Long = 4, items: List<ScrollItem> = emptyList()) =
        FeedResponse("decision", universe, 0, epoch, items)

    @Test fun emptyForeignOrObsoleteFeedCannotBecomeFiniteRest() {
        assertEquals(DiscoverySelection.InvalidScope, selectDiscovery(feed("foreign"), "owner", 4, emptySet(), null))
        assertEquals(DiscoverySelection.InvalidScope, selectDiscovery(feed(epoch = 3), "owner", 4, emptySet(), null))
        assertEquals(DiscoverySelection.InvalidScope, selectDiscovery(feed(epoch = 5), "owner", 4, emptySet(), null))
    }

    @Test fun retrySkipsCurrentPageWithoutMutatingVisitedHistory() {
        val visited = setOf("visited")
        val next = item("next")
        assertEquals(DiscoverySelection.Item(next), selectDiscovery(feed(items = listOf(item("current"), item("visited"), next)), "owner", 4, visited, "current"))
        assertEquals(setOf("visited"), visited)
    }

    @Test fun authorizedEmptyOrAlreadySeenFeedIsFiniteExhaustion() {
        assertEquals(DiscoverySelection.Exhausted, selectDiscovery(feed(), "owner", 4, emptySet(), null))
        assertEquals(DiscoverySelection.Exhausted, selectDiscovery(feed(items = listOf(item("current"))), "owner", 4, emptySet(), "current"))
    }

    @Test fun duplicateDiscoveryAndAmbiguousKeepCannotStartNewPage() {
        assertFalse(canRequestDiscovery(KeepState.Idle, DiscoveryState.Loading))
        assertFalse(canRequestDiscovery(KeepState.Saving, DiscoveryState.Idle))
        assertFalse(canRequestDiscovery(KeepState.Failed("uncertain"), DiscoveryState.Failed))
        assertFalse(canRequestDiscovery(KeepState.Conflict("conflict"), DiscoveryState.Exhausted))
        assertTrue(canRequestDiscovery(KeepState.Idle, DiscoveryState.Failed))
        assertTrue(canRequestDiscovery(KeepState.Kept("job"), DiscoveryState.Exhausted))
    }

    @Test fun authorityFailureMustPurgeWhereNetworkFailureCanRetainCurrentPage() {
        assertTrue(invalidatesReader(ApiException.MissingToken))
        for (status in listOf(401, 409, 422)) assertTrue(invalidatesReader(ApiException.Server(status, "safe error")))
        assertFalse(invalidatesReader(ApiException.Network("offline")))
        assertFalse(invalidatesReader(ApiException.Server(503, "unavailable")))
    }
}
