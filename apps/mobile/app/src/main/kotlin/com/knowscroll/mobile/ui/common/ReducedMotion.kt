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
 * Scope, stated plainly: this reads the real platform setting (there is no stand-in). ScrollScreen
 * .kt's `Stage` reads it to make the reading-progress bar's animation instant (duration 0) instead
 * of the usual 300ms tween. ModalBottomSheet's own entrance/exit motion (SourceSheet/ExplainSheet)
 * and the universe canvas's zoom are **not** suspended by it yet -- overriding Material3's sheet
 * animation spec was judged out of scope for this pass, and CosmosBackground draws its stars once
 * and never animates, so there is no drift there to suspend either. Recorded as the same honest,
 * narrower gap ReducedMotionRedTest itself documents, not silently widened by this file's own
 * comment.
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
