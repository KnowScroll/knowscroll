package com.knowscroll.mobile.ui.system

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.knowscroll.mobile.ui.theme.Cosmos
import kotlin.math.*

/** One bounded, lifecycle-owned clock. Only the sky draw reads its ticks. */
@Composable
internal fun rememberSkyClock(paused: Boolean): State<Float> {
    val ticks = remember { mutableFloatStateOf(0f) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, paused) {
        val choreographer = android.view.Choreographer.getInstance()
        var previous = 0L
        var active = false
        val callback =
            object : android.view.Choreographer.FrameCallback {
                override fun doFrame(now: Long) {
                    if (!active) return
                    if (previous != 0L)
                        ticks.floatValue += ((now - previous) / 1e9f).coerceIn(0f, .05f)
                    previous = now
                    choreographer.postFrameCallbackDelayed(this, 32L)
                }
            }
        fun reconcile() {
            val next = !paused && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            if (next != active) {
                active = next
                previous = 0L
                choreographer.removeFrameCallback(callback)
                if (active) choreographer.postFrameCallback(callback)
            }
        }
        val observer = androidx.lifecycle.LifecycleEventObserver { _, _ -> reconcile() }
        lifecycle.addObserver(observer)
        reconcile()
        onDispose {
            active = false
            choreographer.removeFrameCallback(callback)
            lifecycle.removeObserver(observer)
        }
    }
    return ticks
}

private class SkyPaint {
    val ocean =
        Brush.radialGradient(
            listOf(Color(0xFF89EFE6), Color(0xFF208AA1), Color(0xFF07303D)),
            Offset(-.32f, -.38f),
            1.6f,
        )
    val sun =
        Brush.radialGradient(
            listOf(Cosmos.Yellow.copy(alpha = .28f), Color.Transparent),
            Offset.Zero,
            75f,
        )
    val hull =
        Path().apply {
            moveTo(9f, 0f)
            lineTo(-7f, -5f)
            lineTo(-3f, 0f)
            lineTo(-7f, 5f)
            close()
        }
    val land = continentPaths().onEach { it.transform(Matrix().apply { scale(.009f, .009f, 1f) }) }
}

@Composable
internal fun LivingSky(
    markers: List<AtlasMarker>,
    points: List<AtlasPoint>,
    camera: () -> AtlasCamera,
    selectedId: String?,
    paused: Boolean,
    titleStyle: TextStyle,
    modifier: Modifier = Modifier,
    hidden: Boolean = false,
    ship: () -> Offset = { Offset(25f, -20f) },
    travelling: () -> Boolean = { false },
    heading: () -> Float = { -25f },
) {
    val paint = remember { SkyPaint() }
    val clock = rememberSkyClock(paused)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current.density
    val labels =
        remember(markers, density, titleStyle) {
            markers.associate {
                it.id to
                    measurer.measure(
                        AnnotatedString(
                            it.title.removePrefix("NASA - ").substringBefore(" · ").take(22)
                        ),
                        titleStyle.copy(color = Cosmos.Cream),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        constraints = Constraints(maxWidth = (104 * density).toInt()),
                    )
            }
        }
    // ADR-0037: a foundation is drawn brighter -- a soft glow and ring behind the planet.
    val foundations = remember(markers) { markers.filter { it.foundation }.mapTo(HashSet()) { it.id } }
    Canvas(modifier) {
        if (hidden) return@Canvas
        val pose = camera()
        val scale = pose.zoom * density
        val origin = Offset(size.width / 2 - pose.x * scale, size.height / 2 - pose.y * scale)
        val separated = separatedPoints(points, pose.zoom)
        if (selectedId == null || travelling())
            withTransform({
                translate(origin.x, origin.y)
                scale(scale, scale, Offset.Zero)
            }) {
                for (ring in 0..2) {
                    val r = 82f + ring * 46f
                    drawOval(
                        Cosmos.Cream.copy(alpha = .17f),
                        Offset(-r, -r * .72f),
                        Size(r * 2, r * 1.44f),
                        style = Stroke(.6f / pose.zoom),
                    )
                }
                drawCircle(paint.sun, 75f, Offset.Zero)
                drawCircle(Color(0xFFFFF7C7), 13f, Offset.Zero)
                if (stationVisible(separated, pose.zoom)) {
                    val station = Offset(98f, 0f)
                    drawCircle(Cosmos.Teal.copy(alpha = .5f), 12f, station, style = Stroke(.8f))
                    drawRect(Cosmos.Teal, station - Offset(17f, 3f), Size(34f, 6f))
                    drawCircle(Cosmos.Dark, 7f, station)
                    drawCircle(Cosmos.Cream, 5f, station)
                    drawCircle(Cosmos.Coral, 2f, station - Offset(0f, 14f))
                }
            }
        val labelBounds = mutableListOf<Rect>()
        val shown =
            if (selectedId != null && !travelling()) points.filter { it.id == selectedId }
            else separated
        val bodyBounds =
            shown.map { p ->
                val cx = size.width / 2 + (p.x - pose.x) * scale
                val cy = size.height / 2 + (p.y - pose.y) * scale
                Rect(cx - 22 * scale, cy - 22 * scale, cx + 22 * scale, cy + 22 * scale)
            }
        for (point in shown) {
            val p =
                Offset(
                    size.width / 2 + (point.x - pose.x) * scale,
                    size.height / 2 + (point.y - pose.y) * scale,
                )
            val radius =
                (if (point.id == selectedId)
                    14f + 29f * ((pose.zoom - .86f) / 1.74f).coerceIn(0f, 1f)
                else 12f + (point.id.hashCode().toLong().and(3)).toFloat()) * scale
            if (
                p.x + radius < -80 * density ||
                    p.x - radius > size.width + 80 * density ||
                    p.y + radius < -60 * density ||
                    p.y - radius > size.height + 60 * density
            )
                continue
            val phase =
                (point.id.hashCode().toLong().and(0xffff) / 65535f) * 6.283f + clock.value * .5f
            val moon =
                p +
                    Offset(
                        cos(phase) * (radius * 1.4f + 12 * density),
                        sin(phase) * (radius * 1.4f + 12 * density) * .65f,
                    )
            fun drawMoon() {
                drawCircle(
                    Cosmos.CreamDim,
                    (if (point.id == selectedId) 6f else 3f) * density,
                    moon,
                )
                drawCircle(
                    Cosmos.InkOnCream.copy(alpha = .3f),
                    1.2f * density,
                    moon + Offset(density, density),
                )
            }
            if (sin(phase) < 0) drawMoon()
            withTransform({
                translate(p.x, p.y)
                scale(radius, radius, Offset.Zero)
            }) {
                if (point.id in foundations) {
                    drawCircle(Cosmos.Yellow.copy(alpha = .16f), 1.5f, Offset.Zero)
                    drawCircle(Cosmos.Cream.copy(alpha = .6f), 1.3f, Offset.Zero, style = Stroke(.03f))
                }
                drawCircle(paint.ocean, 1f, Offset.Zero)
                paint.land.forEachIndexed { i, path ->
                    drawPath(
                        path,
                        if (i == 0) Cosmos.Green
                        else if (i == 1) Cosmos.Yellow else Color(0xFF79929D),
                    )
                    drawPath(path, Cosmos.Deep, style = Stroke(.045f))
                }
                drawArc(
                    Cosmos.Cream.copy(alpha = .64f),
                    211f,
                    60f,
                    false,
                    Offset(-.84f, -.84f),
                    Size(1.68f, 1.68f),
                    style = Stroke(.075f, cap = StrokeCap.Round),
                )
                drawArc(
                    Cosmos.Teal2.copy(alpha = .45f),
                    46f,
                    50f,
                    false,
                    Offset(-.88f, -.88f),
                    Size(1.76f, 1.76f),
                    style = Stroke(.07f, cap = StrokeCap.Round),
                )
                drawCircle(Cosmos.Teal2.copy(alpha = .65f), 1f, Offset.Zero, style = Stroke(.022f))
                if (point.id == selectedId)
                    drawCircle(Cosmos.Yellow, 1.11f, Offset.Zero, style = Stroke(.025f))
            }
            if (sin(phase) >= 0) drawMoon()
            if (pose.zoom < 2.5f && point.id != selectedId) {
                val text = labels.getValue(point.id)
                val left =
                    (p.x - text.size.width / 2).coerceIn(
                        8 * density,
                        (size.width - text.size.width - 8 * density).coerceAtLeast(8 * density),
                    )
                val top = p.y + radius + 7 * density
                val bounds = Rect(left, top, left + text.size.width, top + text.size.height)
                if (
                    labelBounds.none { it.overlaps(bounds) } &&
                        bodyBounds.withIndex().none { (index, body) ->
                            shown[index].id != point.id && body.overlaps(bounds)
                        }
                ) {
                    drawText(text, topLeft = Offset(left, top))
                    labelBounds.add(bounds)
                }
            }
        }
        val vessel = ship()
        val sp =
            Offset(
                size.width / 2 + (vessel.x - pose.x) * scale,
                size.height / 2 + (vessel.y - pose.y) * scale,
            )
        withTransform({
            translate(sp.x, sp.y)
            scale(density, density, Offset.Zero)
            rotate(heading(), Offset.Zero)
        }) {
            if (travelling())
                drawLine(Cosmos.Yellow, Offset(-9f, 0f), Offset(-23f, 0f), 3f, StrokeCap.Round)
            val hull = paint.hull
            drawPath(hull, Cosmos.Cream)
            drawPath(hull, Cosmos.Deep, style = Stroke(.8f))
            drawCircle(Cosmos.Teal, 1.7f, Offset(2f, 0f))
        }
    }
}
