package com.knowscroll.mobile.ui.system

import com.knowscroll.mobile.data.WorldSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Encounter completion describes library exposure, never subject mastery. */
class SystemGeometryTest {
    private fun world(scrollCount: Int, seenCount: Int) =
        WorldSummary("w1", "Source", "https://example.test/source", scrollCount, seenCount)

    @Test fun `fully explored requires every recorded Scroll to be seen, and at least one to exist`() {
        assertTrue(isWorldFullyExplored(world(scrollCount = 1, seenCount = 1)))
        assertTrue(isWorldFullyExplored(world(scrollCount = 3, seenCount = 3)))
        // seenCount can never legitimately exceed scrollCount, but >= is the guarded contract's
        // own comparison (docs/contracts/bootstrap-http.md), not < -- honour it exactly.
        assertTrue(isWorldFullyExplored(world(scrollCount = 2, seenCount = 5)))
    }

    @Test fun `more to explore when real Scrolls remain unseen`() {
        assertTrue(!isWorldFullyExplored(world(scrollCount = 2, seenCount = 1)))
        assertTrue(!isWorldFullyExplored(world(scrollCount = 5, seenCount = 0)))
    }

    @Test fun `a world with no recorded Scrolls is never claimed fully explored`() {
        // ADR-0028: GET /v1/worlds never actually returns this shape (seen_count >= 1 is guarded),
        // but the pure function must still refuse "0 of 0 is complete" rather than divide-by-zero
        // its way into a false claim.
        assertTrue(!isWorldFullyExplored(world(scrollCount = 0, seenCount = 0)))
    }
}
