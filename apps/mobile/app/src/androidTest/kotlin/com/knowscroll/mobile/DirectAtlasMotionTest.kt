package com.knowscroll.mobile

import android.graphics.Rect
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Test

/** Wall-clock touch route for video review; no Compose test clock accelerates the ship or moons. */
class DirectAtlasMotionTest {
    @Test
    fun visibleArrivalAndContentReturn() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        check(context.packageName.startsWith("com.knowscroll.mobile.journey"))
        val automation = instrumentation.uiAutomation
        fun find(label: String): AccessibilityNodeInfo? {
            fun walk(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
                if (node.text?.toString() == label || node.contentDescription?.toString() == label)
                    return node
                for (i in 0 until node.childCount) node.getChild(i)?.let {
                    walk(it)?.let { found ->
                        return found
                    }
                }
                return null
            }
            automation.clearCache()
            return automation.rootInActiveWindow?.let(::walk)
        }
        fun await(label: String): AccessibilityNodeInfo {
            val until = SystemClock.elapsedRealtime() + 25_000
            do {
                find(label)?.let {
                    return it
                }
                Thread.sleep(50)
            } while (SystemClock.elapsedRealtime() < until)
            error("Missing destination: $label")
        }
        fun tap(label: String) {
            val bounds = Rect()
            await(label).getBoundsInScreen(bounds)
            check(!bounds.isEmpty)
            val now = SystemClock.uptimeMillis()
            val down =
                MotionEvent.obtain(
                    now,
                    now,
                    MotionEvent.ACTION_DOWN,
                    bounds.exactCenterX(),
                    bounds.exactCenterY(),
                    0,
                )
            val up =
                MotionEvent.obtain(
                    now,
                    now + 60,
                    MotionEvent.ACTION_UP,
                    bounds.exactCenterX(),
                    bounds.exactCenterY(),
                    0,
                )
            try {
                instrumentation.sendPointerSync(down)
                instrumentation.sendPointerSync(up)
            } finally {
                down.recycle()
                up.recycle()
            }
            Thread.sleep(1000)
        }
        ActivityScenario.launch(MainActivity::class.java).use {
            if (InstrumentationRegistry.getArguments().getString("restoredOwner") == "true") {
                // Existing owner preview can resume its saved reader rather than Universe.
                tap("Atlas")
            }
            tap("Authored Atlas")
            tap("Enter authored system")
            tap("Explore world: Orbits")
            await("Enter continents on Orbits")
            Thread.sleep(2200) // Record an orbit after the ship has visibly arrived.
            tap("Enter continents on Orbits")
            tap("Explore authored region: North coast")
            tap("Topic: Why does an orbit keep falling?")
            val origin = await("Spatial atlas").stateDescription.toString()
            tap("Open")
            await("Preview Scroll reading")
            Thread.sleep(1500)
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            await("Open")
            check(await("Spatial atlas").stateDescription.toString() == origin)
            Thread.sleep(1000)
            File(context.filesDir, "direct-motion.json")
                .writeText(
                    """{"result":"passed","clock":"wall time; Android MotionEvent; no Compose test clock","shipArrival":true,"moons":true,"topicToScrollReturn":true}"""
                )
        }
    }
}
