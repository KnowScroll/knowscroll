package com.knowscroll.mobile.ui.common

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.knowscroll.mobile.ui.theme.Cosmos

@Composable
fun CosmosBackground(modifier: Modifier = Modifier, pointCount: Int = 90, seed: Long = 7317L) {
    val stars =
        remember(seed, pointCount) {
            val rng = java.util.Random(seed)
            List(pointCount * 2) {
                floatArrayOf(
                    rng.nextFloat(),
                    rng.nextFloat(),
                    .3f + rng.nextFloat(),
                    .18f + rng.nextFloat() * .52f,
                )
            }
        }
    val glow = remember {
        Brush.radialGradient(
            listOf(Color(0xFF0B303C), Color.Transparent),
            Offset(350f, 800f),
            1000f,
        )
    }
    Box(modifier = modifier.fillMaxSize().background(Color(0xFF03131D))) {
        Canvas(Modifier.fillMaxSize()) {
            drawRect(glow)
            stars.forEach { star ->
                drawCircle(
                    Cosmos.Cream,
                    star[2] * density,
                    Offset(star[0] * size.width, star[1] * size.height),
                    alpha = star[3],
                )
            }
        }
    }
}
