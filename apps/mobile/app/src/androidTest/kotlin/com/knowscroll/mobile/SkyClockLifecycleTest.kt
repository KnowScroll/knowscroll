package com.knowscroll.mobile

import androidx.compose.runtime.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.*
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.knowscroll.mobile.ui.system.rememberSkyClock
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class SkyClockLifecycleTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun clockStopsForReducedMotionHiddenAndBackground() {
        val owner =
            object : LifecycleOwner {
                val registry = LifecycleRegistry(this)
                override val lifecycle: Lifecycle = registry
            }
        var paused by mutableStateOf(false)
        lateinit var clock: State<Float>
        compose.runOnUiThread { owner.registry.currentState = Lifecycle.State.RESUMED }
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                clock = rememberSkyClock(paused)
            }
        }
        Thread.sleep(250)
        var before = clock.value
        Thread.sleep(250)
        assertTrue(clock.value > before)
        compose.runOnIdle { paused = true }
        compose.waitForIdle()
        before = clock.value
        Thread.sleep(250)
        assertEquals(before, clock.value)
        compose.runOnIdle {
            paused = false
            owner.registry.currentState = Lifecycle.State.CREATED
        }
        compose.waitForIdle()
        before = clock.value
        Thread.sleep(250)
        assertEquals(before, clock.value)
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        Thread.sleep(250)
        assertTrue(clock.value > before)
    }
}
