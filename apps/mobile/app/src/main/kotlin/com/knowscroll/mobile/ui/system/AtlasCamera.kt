package com.knowscroll.mobile.ui.system

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/** Presentation coordinates, never semantic distance or a claim of personal growth. */
data class AtlasPoint(val id: String, val x: Float, val y: Float)

data class AtlasCamera(val x: Float = 0f, val y: Float = 0f, val zoom: Float = 1f) {
    fun transform(cx: Float, cy: Float, panX: Float, panY: Float, factor: Float): AtlasCamera {
        if (!listOf(cx, cy, panX, panY, factor).all { it.isFinite() } || factor <= 0f) return this
        val next = (zoom * factor).coerceIn(.35f, 12f)
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
            zoom = zoom.coerceIn(.35f, 12f),
        )
}

/** Identity-derived orbital address. No index/count/overlap relaxation can move another ID. */
fun atlasLayout(ids: List<String>): List<AtlasPoint> =
    ids.distinct().sorted().map { id ->
        var hash = 0xcbf29ce484222325UL
        id.toByteArray(Charsets.UTF_8).forEach {
            hash = (hash xor it.toUByte().toULong()) * 0x100000001b3UL
        }
        val ring = ((hash shr 32) % 3u).toInt()
        val angle = (hash and 0xffffffu).toDouble() / 0xffffffu.toDouble() * Math.PI * 2
        val radius = 82f + ring * 46f
        AtlasPoint(id, (cos(angle) * radius).toFloat(), (sin(angle) * radius * .72f).toFloat())
    }

/**
 * Culling changes visibility, never an identity's coordinates. The full list remains accessible.
 */
internal fun separatedPoints(points: List<AtlasPoint>, zoom: Float): List<AtlasPoint> {
    val visible = mutableListOf<AtlasPoint>()
    points
        .sortedBy { it.id }
        .forEach { point ->
            val minimumGap = maxOf(52f, 36f * zoom)
            if (
                visible.none { other ->
                    val dx = (point.x - other.x) * zoom
                    val dy = (point.y - other.y) * zoom
                    abs(dx) < minimumGap && abs(dy) < minimumGap
                }
            )
                visible.add(point)
        }
    return visible
}

/** Worlds take priority over the optional station landmark when hit targets would overlap. */
internal fun stationVisible(visible: List<AtlasPoint>, zoom: Float): Boolean =
    visible.none {
        kotlin.math.abs((it.x - 98f) * zoom) < 52f && kotlin.math.abs(it.y * zoom) < 52f
    }
