package com.knowscroll.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #136: the owner's preview and the device test app are both journey builds; nothing else is. */
class JourneyBuildTest {
    @Test
    fun thePreviewAndTheTestAppAreJourneyBuilds() {
        assertTrue(JourneyBuild.isJourney("com.knowscroll.mobile.journey"))
        assertTrue(JourneyBuild.isJourney("com.knowscroll.mobile.journeytest"))
    }

    @Test
    fun everyOtherPackageIsNot() {
        for (name in listOf("com.knowscroll.mobile", "com.knowscroll.mobile.journey.test", "com.knowscroll.mobile.journeytest.test", "com.knowscroll.mobile.journeys")) {
            assertFalse(name, JourneyBuild.isJourney(name))
        }
    }
}
