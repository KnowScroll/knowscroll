package com.knowscroll.mobile.ui.common

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import com.knowscroll.mobile.ui.theme.Cosmos

@Composable
fun CosmosBackground(modifier: Modifier = Modifier, pointCount: Int = 90, seed: Long = 7317L) {
    Box(modifier = modifier.fillMaxSize().background(Cosmos.Dark)) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val rng = java.util.Random(seed)
            val w = size.width; val h = size.height
            val palette = listOf(Color(0xFFB7C3CC), Color(0xFF8FA3B0), Color(0xFFE9E3CE), Color(0xFF33C4B4))
            repeat(pointCount) {
                val x = rng.nextFloat() * w
                val y = rng.nextFloat() * h
                val r = when (rng.nextInt(10)) { in 0..6 -> 0.6f + rng.nextFloat() * 0.4f
                    in 7..8 -> 1.0f + rng.nextFloat() * 0.6f
                    else -> 1.4f + rng.nextFloat() * 0.8f }
                drawCircle(
                    color = palette[rng.nextInt(palette.size)],
                    radius = r,
                    center = Offset(x, y),
                    alpha = if (r > 1.4f) 0.95f else 0.7f
                )
            }
        }
    }
}

