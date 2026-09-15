package com.knowscroll.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

object Cosmos {
    val Dark = Color(0xFF03101A)
    val Cream = Color(0xFFFFFDF2)
    val CreamDim = Color(0xFFE9E3CE)
    val Teal = Color(0xFF33C4B4)
    val Coral = Color(0xFFFF684C)
    val Yellow = Color(0xFFFFD058)
    val InkOnCream = Color(0xFF03101A)
    val InkOnDark = Color(0xFFFFFDF2)
    val MutedOnDark = Color(0xFFB7C3CC)
    val MutedOnCream = Color(0xFF52606A)
}

private val Scheme = darkColorScheme(
    primary = Cosmos.Teal, onPrimary = Cosmos.Dark,
    secondary = Cosmos.Yellow, onSecondary = Cosmos.Dark,
    tertiary = Cosmos.Coral, onTertiary = Cosmos.Cream,
    background = Cosmos.Dark, onBackground = Cosmos.InkOnDark,
    surface = Cosmos.Dark, onSurface = Cosmos.InkOnDark,
    surfaceVariant = Color(0xFF0A1B26), onSurfaceVariant = Cosmos.MutedOnDark,
    error = Cosmos.Coral, onError = Cosmos.Cream
)

private val Type = Typography(
    displayLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Light, fontSize = 32.sp, lineHeight = 38.sp, letterSpacing = (-0.5).sp),
    headlineMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 22.sp, lineHeight = 28.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 24.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, letterSpacing = 0.6.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 1.2.sp)
)

@Composable
fun KnowScrollTheme(
    @Suppress("UNUSED_PARAMETER") darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    MaterialTheme(colorScheme = Scheme, typography = Type, content = content)
}
