package com.knowscroll.mobile.ui.system

import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Presentation coordinates, never semantic distance or a claim of personal growth. */
data class AtlasPoint(val id: String, val x: Float, val y: Float)

data class AtlasCamera(val x: Float = 0f, val y: Float = 0f, val zoom: Float = 1f) {
    fun transform(cx: Float, cy: Float, panX: Float, panY: Float, factor: Float): AtlasCamera {
        if (!listOf(cx, cy, panX, panY, factor).all { it.isFinite() } || factor <= 0f) return this
        val next = (zoom * factor).coerceIn(.35f, 3.2f)
        return AtlasCamera(
            x + cx / zoom - (cx + panX) / next,
            y + cy / zoom - (cy + panY) / next,
            next,
        )
    }

    fun bounded(points: List<AtlasPoint>): AtlasCamera =
        copy(
            x =
                x.coerceIn(
                    (points.minOfOrNull { it.x } ?: 0f) - 180f,
                    (points.maxOfOrNull { it.x } ?: 0f) + 180f,
                ),
            y =
                y.coerceIn(
                    (points.minOfOrNull { it.y } ?: 0f) - 180f,
                    (points.maxOfOrNull { it.y } ?: 0f) + 180f,
                ),
            zoom = zoom.coerceIn(.35f, 3.2f),
        )
}

fun atlasLayout(ids: List<String>): List<AtlasPoint> =
    ids.sorted().mapIndexed { index, id ->
        if (ids.size == 1) AtlasPoint(id, 0f, 0f)
        else {
            val radius = 106f * sqrt(index + 1f)
            val angle = index * 2.3999632f - .6f
            AtlasPoint(id, cos(angle) * radius, sin(angle) * radius)
        }
    }
