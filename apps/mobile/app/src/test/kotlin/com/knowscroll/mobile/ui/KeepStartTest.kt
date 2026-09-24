package com.knowscroll.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #123: a Keep tapped while this Scroll's exposure is still being recorded used to be dropped as
 * "busy" -- the reader saw nothing happen. It now joins that exposure; anything else that is busy
 * still refuses the tap.
 */
class KeepStartTest {
    @Test fun aKeepTappedDuringThisScrollsExposureJoinsIt() {
        assertEquals(KeepStart.Join("exposure-a"), keepStart(busy = true, inFlight = "client-a" to "exposure-a", clientExposureId = "client-a"))
    }

    @Test fun anythingElseBusyStillRefusesTheTap() {
        assertEquals(KeepStart.Refuse, keepStart<String>(busy = true, inFlight = null, clientExposureId = "client-a"))
        assertEquals(KeepStart.Refuse, keepStart(busy = true, inFlight = "client-b" to "exposure-b", clientExposureId = "client-a"))
    }

    @Test fun anIdleReaderStartsItsOwnExposure() {
        assertEquals(KeepStart.Fresh, keepStart<String>(busy = false, inFlight = null, clientExposureId = "client-a"))
    }
}
