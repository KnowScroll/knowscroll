package com.knowscroll.mobile.ui.common

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import com.knowscroll.mobile.ui.theme.Cosmos

/** Decorative cartography, shared with Web. These shapes do not represent inferred interests. */
@Composable
fun WorldGlobe(modifier: Modifier = Modifier, variant: Int = 0) {
    Canvas(modifier) {
        val scale = size.minDimension / 200f
        withTransform({
            translate((size.width - size.minDimension) / 2f, (size.height - size.minDimension) / 2f)
            scale(scale, scale, pivot = Offset.Zero)
        }) {
            val center = Offset(100f, 100f)
            val coral = variant % 2 != 0
            drawCircle(Cosmos.Teal2.copy(alpha = .12f), 96f, center, style = Stroke(.8f))
            drawCircle(Brush.radialGradient(
                listOf(if (coral) Color(0xFFD99D7E) else Color(0xFF438A90),
                    if (coral) Color(0xFF735653) else Cosmos.Sea, Cosmos.Dark),
                center = Offset(62f, 55f), radius = 165f
            ), 89f, center)
            val clip = Path().apply { addOval(androidx.compose.ui.geometry.Rect(11f, 11f, 189f, 189f)) }
            clipPath(clip) {
                for (rx in listOf(28f, 55f, 80f)) drawOval(
                    Cosmos.Cream.copy(alpha = .13f), Offset(100f - rx, 11f), Size(rx * 2, 178f), style = Stroke(.65f)
                )
                for (y in listOf(45f, 73f, 101f, 129f, 157f)) {
                    val latitude = Path().apply { moveTo(0f, y); quadraticTo(100f, y + 26f, 200f, y) }
                    drawPath(latitude, Cosmos.Cream.copy(alpha = .13f), style = Stroke(.65f))
                }
                val continents = listOf(
                    listOf(22f,49f,47f,36f,74f,42f,86f,60f,76f,75f,52f,79f,35f,66f),
                    listOf(113f,30f,134f,27f,153f,44f,149f,60f,129f,69f,112f,56f),
                    listOf(104f,92f,132f,82f,157f,102f,147f,130f,157f,148f,141f,177f,110f,166f,99f,145f,108f,123f,94f,108f),
                    listOf(18f,113f,43f,110f,62f,131f,54f,156f,34f,168f,15f,145f),
                    listOf(77f,103f,85f,112f,82f,127f,72f,119f)
                )
                withTransform({ if (coral) rotate(130f, center) }) {
                    continents.forEach { points ->
                        val path = Path().apply {
                            moveTo(points[0], points[1])
                            for (i in 2 until points.size step 2) lineTo(points[i], points[i + 1])
                            close()
                        }
                        drawPath(path, if (coral) Color(0xFFE5BC92) else Color(0xFF83BEB4))
                        drawPath(path, Cosmos.Deep, style = Stroke(3f))
                    }
                }
                drawCircle(Brush.radialGradient(
                    0.35f to Cosmos.Dark.copy(alpha = 0f), 1f to Cosmos.Dark.copy(alpha = .8f),
                    center = Offset(62f, 55f), radius = 165f
                ), 89f, center)
                val clouds = Path().apply {
                    moveTo(20f,85f); quadraticTo(65f,62f,113f,77f)
                    moveTo(99f,153f); quadraticTo(145f,165f,185f,134f)
                }
                drawPath(clouds, Cosmos.Cream.copy(alpha = .12f), style = Stroke(5f))
            }
            drawCircle(Cosmos.Teal2.copy(alpha = .35f), 89f, center, style = Stroke(.8f))
        }
    }
}
