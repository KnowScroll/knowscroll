package com.knowscroll.mobile

/**
 * #136: the disposable journey builds. The owner's preview is `…journey` (built by
 * `scripts/android-living-preview.py`); device test runners build `…journeytest` so they never
 * install over it. Both get the debug-only behaviour a journey needs (authored previews, the export
 * written to the app's cache instead of the system picker); release and plain debug builds get none.
 */
object JourneyBuild {
    fun isJourney(packageName: String): Boolean = packageName.endsWith(".journey") || packageName.endsWith(".journeytest")
}
