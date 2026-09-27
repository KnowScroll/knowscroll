package com.knowscroll.mobile.ui.system

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.positionChanged
import kotlin.math.abs

/** Read transforms before marker clicks. Consume movement only after touch slop; taps remain clicks.
 * A second finger can land on another marker without its down consumption cancelling the camera.
 */
internal suspend fun PointerInputScope.detectAtlasTransforms(onTransform: (Offset, Offset, Float) -> Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var accumulatedPan = Offset.Zero
        var accumulatedZoom = 1f
        var transforming = false
        do {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (event.changes.any { it.isConsumed }) break
            val pan = event.calculatePan()
            val zoom = event.calculateZoom()
            accumulatedPan += pan
            accumulatedZoom *= zoom
            if (!transforming) {
                val zoomMotion = abs(1f - accumulatedZoom) * event.calculateCentroidSize(useCurrent = false)
                transforming = accumulatedPan.getDistance() > viewConfiguration.touchSlop || zoomMotion > viewConfiguration.touchSlop
            }
            if (transforming) {
                onTransform(event.calculateCentroid(useCurrent = false), pan, zoom)
                event.changes.forEach { if (it.positionChanged()) it.consume() }
            }
        } while (event.changes.any { it.pressed })
    }
}
