package com.knowscroll.mobile

import android.os.Handler
import android.os.HandlerThread
import android.view.FrameMetrics
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Collections
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real-time accessibility input, deliberately without Compose's test animation clock. Same 12
 * world-entry/Back cycles run on the original PR head and its spatial successor.
 */
@android.annotation.TargetApi(33)
@RunWith(AndroidJUnit4::class)
class AtlasProfileTest {
    @Test
    fun profile() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        check(context.packageName == "com.knowscroll.mobile.journey")
        val automation = instrumentation.uiAutomation
        fun find(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
            fun walk(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
                if (predicate(node)) return node
                for (index in 0 until node.childCount) {
                    node.getChild(index)?.let { child ->
                        walk(child)?.let {
                            return it
                        }
                    }
                }
                return null
            }
            automation.clearCache()
            return automation.rootInActiveWindow?.let(::walk)
        }
        fun awaitNode(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
            val until = android.os.SystemClock.elapsedRealtime() + 30_000
            do {
                find(predicate)?.let {
                    return it
                }
                Thread.sleep(50)
            } while (android.os.SystemClock.elapsedRealtime() < until)
            error("Timed out awaiting accessible destination")
        }
        fun click(predicate: (AccessibilityNodeInfo) -> Boolean) {
            var node = awaitNode(predicate)
            node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
            automation.waitForIdle(200, 10_000)
            val bounds = android.graphics.Rect()
            repeat(12) {
                node = awaitNode(predicate)
                node.getBoundsInScreen(bounds)
                if (!node.isVisibleToUser || bounds.isEmpty) {
                    var parent = node.parent
                    while (parent != null && !parent.isScrollable) parent = parent.parent
                    parent?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                    automation.waitForIdle(200, 10_000)
                }
            }
            node = awaitNode(predicate)
            node.getBoundsInScreen(bounds)
            if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
            check(node.isVisibleToUser && !bounds.isEmpty) { "Destination not visible: $node" }
            val now = android.os.SystemClock.uptimeMillis()
            val down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, bounds.exactCenterX(), bounds.exactCenterY(), 0)
            val up = android.view.MotionEvent.obtain(now, now + 50, android.view.MotionEvent.ACTION_UP, bounds.exactCenterX(), bounds.exactCenterY(), 0)
            try { instrumentation.sendPointerSync(down); instrumentation.sendPointerSync(up) }
            finally { down.recycle(); up.recycle() }
        }
        fun isWorld(node: AccessibilityNodeInfo) =
            node.contentDescription?.let { it.startsWith("Explore world: ") && it.contains("Orbits") } == true
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            click { it.contentDescription == "Open the system view" }
            awaitNode(::isWorld)
            automation.waitForIdle(200, 10_000)
            val durations = Collections.synchronizedList(mutableListOf<Long>())
            val phases =
                listOf(
                    "layout" to FrameMetrics.LAYOUT_MEASURE_DURATION,
                    "draw" to FrameMetrics.DRAW_DURATION,
                    "sync" to FrameMetrics.SYNC_DURATION,
                    "gpu" to FrameMetrics.GPU_DURATION,
                    "queue" to FrameMetrics.UNKNOWN_DELAY_DURATION,
                )
            val timings =
                phases.associate { it.first to Collections.synchronizedList(mutableListOf<Long>()) }
            val drops = java.util.concurrent.atomic.AtomicInteger()
            val thread = HandlerThread("frame-profile").apply { start() }
            val listener =
                android.view.Window.OnFrameMetricsAvailableListener { _, metrics, dropped ->
                    durations.add(metrics.getMetric(FrameMetrics.TOTAL_DURATION))
                    phases.forEach { (name, id) ->
                        timings.getValue(name).add(metrics.getMetric(id))
                    }
                    drops.addAndGet(dropped)
                }
            scenario.onActivity {
                it.window.addOnFrameMetricsAvailableListener(listener, Handler(thread.looper))
            }
            try {
                repeat(12) {
                    click(::isWorld)
                    awaitNode {
                        it.contentDescription == "Close world detail and return to the system"
                    }
                    automation.waitForIdle(200, 10_000)
                    instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                    awaitNode(::isWorld)
                    automation.waitForIdle(200, 10_000)
                }
                val memory =
                    android.os.Debug.MemoryInfo().also { android.os.Debug.getMemoryInfo(it) }
                val samples = synchronized(durations) { durations.toList().sorted() }
                check(samples.isNotEmpty())
                File(context.filesDir, "atlas-profile.json")
                    .writeText(
                        JSONObject()
                            .put("totalPssKb", memory.totalPss)
                            .put("nativePssKb", memory.nativePss)
                            .put("dalvikPssKb", memory.dalvikPss)
                            .put(
                                "phaseP95Ms",
                                JSONObject(
                                    timings.mapValues { (_, values) ->
                                        val sorted = synchronized(values) { values.sorted() }
                                        sorted[(sorted.size * .95).toInt()] / 1e6
                                    }
                                ),
                            )
                            .put("iterations", 12)
                            .put("frames", samples.size)
                            .put("p50Ms", samples[samples.size / 2] / 1e6)
                            .put("p95Ms", samples[(samples.size * .95).toInt()] / 1e6)
                            .put("maxMs", samples.last() / 1e6)
                            .put("over16_67ms", samples.count { it > 16_666_667 })
                            .put("droppedMetricReports", drops.get())
                            .put(
                                "clock",
                                "real time; accessibility input; no Compose test animation clock",
                            )
                            .put("device", "API36 emulator debug, 1080x2400, font1.0, motion1.0")
                            .toString(2)
                    )
            } catch (error: Throwable) {
                runCatching { automation.takeScreenshot().let { bitmap -> File(context.filesDir,"profile-failure.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) } } }
                throw error
            } finally {
                scenario.onActivity { it.window.removeOnFrameMetricsAvailableListener(listener) }
                thread.quitSafely()
            }
        }
    }
}
