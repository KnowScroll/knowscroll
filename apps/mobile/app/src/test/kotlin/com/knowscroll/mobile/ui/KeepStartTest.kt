package com.knowscroll.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * #123: a Keep tapped while this Scroll's exposure is still being recorded used to be dropped as
 * "busy" -- the reader saw nothing happen. It now joins that exposure, but only that exposure: one
 * started before the last navigation or privacy change is never joined, and a second Keep while one
 * has joined is refused. Anything else that is busy still refuses the tap.
 */
class KeepStartTest {
    private fun recording(clientExposureId: String = "client-a", version: Long = 3, epoch: Long = 0, joined: Boolean = false) =
        ExposureInFlight(clientExposureId, version, epoch, "exposure", joined)

    @Test fun aKeepTappedDuringThisScrollsExposureJoinsIt() {
        val inFlight = recording()
        val start = keepStart(busy = true, inFlight = inFlight, clientExposureId = "client-a", version = 3, epoch = 0)
        assertSame(inFlight, (start as KeepStart.Join).exposure)
    }

    @Test fun anythingElseBusyStillRefusesTheTap() {
        assertEquals(KeepStart.Refuse, keepStart<String>(busy = true, inFlight = null, clientExposureId = "client-a", version = 3, epoch = 0))
        assertEquals(KeepStart.Refuse, keepStart(busy = true, inFlight = recording("client-b"), clientExposureId = "client-a", version = 3, epoch = 0))
    }

    @Test fun aSecondKeepWhileOneHasJoinedIsRefused() {
        assertEquals(KeepStart.Refuse, keepStart(busy = true, inFlight = recording(joined = true), clientExposureId = "client-a", version = 3, epoch = 0))
    }

    @Test fun anExposureFromBeforeTheLastNavigationOrPrivacyChangeIsNeverJoined() {
        assertEquals(KeepStart.Fresh, keepStart(busy = false, inFlight = recording(version = 2), clientExposureId = "client-a", version = 3, epoch = 0))
        assertEquals(KeepStart.Fresh, keepStart(busy = false, inFlight = recording(epoch = 1), clientExposureId = "client-a", version = 3, epoch = 2))
        assertEquals(KeepStart.Refuse, keepStart(busy = true, inFlight = recording(version = 2), clientExposureId = "client-a", version = 3, epoch = 0))
    }

    @Test fun anIdleReaderStartsItsOwnExposure() {
        assertEquals(KeepStart.Fresh, keepStart<String>(busy = false, inFlight = null, clientExposureId = "client-a", version = 3, epoch = 0))
    }
}
