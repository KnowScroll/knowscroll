package com.knowscroll.mobile.ui.system

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.*
import com.knowscroll.mobile.ui.theme.Cosmos

/**
 * Display-only, versioned parent-local geography. Never a learned domain or a private inference.
 */
data class AuthoredRegion(
    val suffix: String,
    val name: String,
    val x: Float,
    val y: Float,
    val known: Boolean,
)

internal val authoredRegions =
    listOf(
        AuthoredRegion("coast", "North coast", -42f, -28f, true),
        AuthoredRegion("inland", "Inland", 46f, 38f, true),
        AuthoredRegion("unknown", "Uncharted", 58f, -52f, false),
    )

internal fun authoredRegionId(worldId: String, region: AuthoredRegion) =
    "$worldId:authored-v1:${region.suffix}"

/** Cached paths in the selected world's coordinate space. Camera is read only in draw phase. */
@Composable
internal fun AuthoredGeography(
    camera: () -> AtlasCamera,
    center: AtlasPoint,
    selectedRegion: String?,
    modifier: Modifier = Modifier,
) {
    val coasts = remember {
        listOf(
            Path().apply {
                moveTo(-93f, -25f)
                lineTo(-76f, -46f)
                lineTo(-58f, -44f)
                lineTo(-46f, -62f)
                lineTo(-21f, -51f)
                lineTo(-4f, -31f)
                lineTo(-12f, -15f)
                lineTo(-7f, 13f)
                lineTo(-29f, 24f)
                lineTo(-43f, 9f)
                lineTo(-68f, 20f)
                lineTo(-80f, 1f)
                close()
            },
            Path().apply {
                moveTo(4f, 44f)
                lineTo(13f, 18f)
                lineTo(36f, 12f)
                lineTo(45f, 27f)
                lineTo(67f, 22f)
                lineTo(78f, 46f)
                lineTo(63f, 57f)
                lineTo(56f, 80f)
                lineTo(29f, 88f)
                lineTo(11f, 69f)
                close()
            },
            Path().apply {
                moveTo(23f, -71f)
                lineTo(52f, -89f)
                lineTo(65f, -72f)
                lineTo(85f, -66f)
                lineTo(96f, -41f)
                lineTo(78f, -22f)
                lineTo(46f, -25f)
                lineTo(26f, -43f)
                close()
            },
        )
    }
    val ocean = remember {
        Brush.radialGradient(listOf(Color(0xFF227E93), Color(0xFF0D465D)), Offset(0f, 0f), 300f)
    }
    val current = remember {
        Path().apply {
            moveTo(-120f, 80f)
            cubicTo(-50f, 58f, 35f, 124f, 110f, 82f)
        }
    }
    val cloudXs = remember { floatArrayOf(-91f, -20f, 68f, 94f, -54f, 8f) }
    val cloudYs = remember { floatArrayOf(-88f, -76f, -11f, 81f, 72f, 105f) }
    Canvas(modifier) {
        val pose = camera()
        val scale = pose.zoom * density
        val origin =
            Offset(
                size.width / 2 + (center.x - pose.x) * scale,
                size.height / 2 + (center.y - pose.y) * scale,
            )
        drawRect(Color(0xFF125870))
        withTransform({
            translate(origin.x, origin.y)
            scale(scale, scale, Offset.Zero)
        }) {
            drawRect(ocean, Offset(-400f, -400f), androidx.compose.ui.geometry.Size(800f, 800f))
            for (i in -10..10) {
                drawLine(
                    Cosmos.Cream.copy(alpha = .07f),
                    Offset(i * 32f, -400f),
                    Offset(i * 32f, 400f),
                    .25f,
                )
                drawLine(
                    Cosmos.Cream.copy(alpha = .07f),
                    Offset(-400f, i * 32f),
                    Offset(400f, i * 32f),
                    .25f,
                )
            }
            coasts.forEachIndexed { index, coast ->
                drawPath(coast, Color(0xFF48949F).copy(alpha = .25f), style = Stroke(10f))
                withTransform({ translate(0f, 3f) }) {
                    drawPath(coast, Color(0xFF0A3440))
                    drawPath(coast, Cosmos.Cream.copy(alpha = .14f), style = Stroke(2f))
                }
                drawPath(
                    coast,
                    if (index == 2) Color(0xFF79929D)
                    else if (index == 0) Color(0xFF65D07D) else Color(0xFFFFD45F),
                )
                drawPath(coast, Color(0xFF183C40), style = Stroke(.9f))
            }
            drawPath(
                current,
                Cosmos.Teal2.copy(alpha = .4f),
                style = Stroke(.5f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3f, 6f))),
            )
            if (pose.zoom > 5f) {
                // A new level of detail: paths and local islets resolve within the chosen coast.
                val region =
                    authoredRegions.firstOrNull { it.suffix == selectedRegion }
                        ?: authoredRegions[0]
                if (region.known) {
                    val a = Offset(region.x - 12f, region.y + 5f)
                    val b = Offset(region.x + 6f, region.y - 9f)
                    val c = Offset(region.x + 17f, region.y + 14f)
                    drawLine(Cosmos.InkOnCream.copy(alpha = .45f), a, b, .7f)
                    drawLine(Cosmos.InkOnCream.copy(alpha = .45f), b, c, .7f)
                    for (point in listOf(a, b, c)) {
                        drawCircle(Cosmos.Cream, 4f, point)
                        drawCircle(Cosmos.InkOnCream, 4f, point, style = Stroke(.6f))
                        drawCircle(Cosmos.Coral, 1.2f, point)
                    }
                }
            }
            for (i in cloudXs.indices) {
                // Unknown is deliberately cloudy; clouds carry no hidden personal information.
                val cx = cloudXs[i]
                val cy = cloudYs[i]
                for (lobe in 0..4) {
                    val p = Offset(cx + lobe * 7f, cy + if (lobe % 2 == 0) 2f else -1f)
                    drawCircle(Color(0xFF9CC7D8), 7f, p + Offset(0f, 2f))
                }
                for (lobe in 0..4) drawCircle(
                    Color(0xFFF1FBFF),
                    7f,
                    Offset(cx + lobe * 7f, cy + if (lobe % 2 == 0) 2f else -1f),
                )
            }
        }
    }
}
