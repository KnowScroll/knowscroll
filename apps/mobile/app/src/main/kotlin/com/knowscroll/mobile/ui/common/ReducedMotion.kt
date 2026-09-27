package com.knowscroll.mobile.ui.common

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

/**
 * docs/product/ui-system.md section 4b: "Android's `Settings.Global.ANIMATOR_DURATION_SCALE` of 0
 * is the platform's version of `prefers-reduced-motion: reduce` and must suspend the same things:
 * sheet motion, any canvas drift, every transition. State still changes, instantly."
 *
 * Native camera travel and reading progress observe this setting. The camera also cancels
 * an active spring when a gesture takes ownership. Material sheet motion still needs separate
 * device acceptance; no ambient drift loop is introduced. Device tests distinguish
 * reduced-motion state changes from physical-device animation/performance acceptance.
 */
private fun readAnimatorDurationScale(context: Context): Float =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    var scale by remember(context) { mutableStateOf(readAnimatorDurationScale(context)) }
    DisposableEffect(context) {
        val handler = Handler(Looper.getMainLooper())
        val observer = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                scale = readAnimatorDurationScale(context)
            }
        }
        context.contentResolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            observer
        )
        onDispose { context.contentResolver.unregisterContentObserver(observer) }
    }
    return scale == 0f
}
