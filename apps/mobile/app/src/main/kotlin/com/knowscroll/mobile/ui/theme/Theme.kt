package com.knowscroll.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontVariation
import com.knowscroll.mobile.R
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** docs/product/ui-system.md section 1: the Cosmos palette, verbatim. Tokens are named after the
 * CSS custom properties they extract (`--deep`, `--sea`, `--sea-2`, `--teal-2`, `--green`, and the
 * `--space-2` "raised ground, panels behind content" role named here `SpaceRaised`). `Pink` is
 * carried too even though section 1 marks it "reserved; unused until a surface needs it" — the
 * truth-state tint mapping in `TruthPill.kt` is the surface that needs it, matching the desktop
 * mapping already shipped in apps/web/src/styles.css. */
object Cosmos {
    val Dark = Color(0xFF03101A)
    val Deep = Color(0xFF0B2B33)
    val Sea = Color(0xFF17505F)
    val Sea2 = Color(0xFF0F3644)
    val SpaceRaised = Color(0xFF061A27)
    val Cream = Color(0xFFFFFDF2)
    val CreamDim = Color(0xFFE9E3CE)
    val Teal = Color(0xFF33C4B4)
    val Teal2 = Color(0xFF8FE9E4)
    val Coral = Color(0xFFFF684C)
    val Yellow = Color(0xFFFFD058)
    val Green = Color(0xFF64D47D)
    val Pink = Color(0xFFED87B4)
    val InkOnCream = Color(0xFF03101A)
    val InkOnDark = Color(0xFFFFFDF2)
    val MutedOnDark = Color(0xFFB7C3CC)
    val MutedOnCream = Color(0xFF52606A)
}

private val Scheme = darkColorScheme(
    primary = Cosmos.Teal, onPrimary = Cosmos.Dark,
    secondary = Cosmos.Yellow, onSecondary = Cosmos.Dark,
    secondaryContainer = Cosmos.Cream, onSecondaryContainer = Cosmos.InkOnCream,
    tertiary = Cosmos.Coral, onTertiary = Cosmos.Cream,
    background = Cosmos.Dark, onBackground = Cosmos.InkOnDark,
    surface = Cosmos.Dark, onSurface = Cosmos.InkOnDark,
    surfaceVariant = Cosmos.SpaceRaised, onSurfaceVariant = Cosmos.MutedOnDark,
    error = Cosmos.Coral, onError = Cosmos.Cream
)

private fun family(resource: Int) = FontFamily(
    *listOf(400, 500, 600, 700, 800).map { weight ->
        Font(resource, weight = FontWeight(weight),
            variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
    }.toTypedArray()
)
internal val Heading = family(R.font.bricolage)
private val Body = family(R.font.instrument)
private val Type = Typography(
    displayLarge = TextStyle(fontFamily = Heading, fontWeight = FontWeight(800), fontSize = 34.sp, lineHeight = 40.sp, letterSpacing = (-0.4).sp),
    headlineLarge = TextStyle(fontFamily = Heading, fontWeight = FontWeight(700), fontSize = 26.sp, lineHeight = 32.sp, letterSpacing = (-0.3).sp),
    headlineMedium = TextStyle(fontFamily = Heading, fontWeight = FontWeight(700), fontSize = 22.sp, lineHeight = 28.sp, letterSpacing = (-0.2).sp),
    headlineSmall = TextStyle(fontFamily = Heading, fontWeight = FontWeight(700), fontSize = 18.sp, lineHeight = 24.sp, letterSpacing = (-0.1).sp),
    titleLarge = TextStyle(fontFamily = Heading, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 24.sp),
    titleMedium = TextStyle(fontFamily = Heading, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontFamily = Body, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = Body, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    // docs/product/ui-system.md section 3: "Pills for every control ... weight 800, 13px" — this is
    // what Button/OutlinedButton/TextButton draw their label with (Material3's own labelLarge).
    labelLarge = TextStyle(fontFamily = Heading, fontWeight = FontWeight(800), fontSize = 13.sp, letterSpacing = 0.2.sp),
    labelMedium = TextStyle(fontFamily = FontFamily(Font(R.font.dm_mono, weight = FontWeight.Medium)), fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 1.2.sp)
)

// docs/product/ui-system.md section 3: "Cards and sheets: radius 22px". Only `medium` is
// overridden: it is the shape UniverseScreen.kt's Trace card already asks for
// (MaterialTheme.shapes.medium), so this one token now carries the Cosmos card radius everywhere
// that asks for it, rather than each call site repeating a literal.
private val Shape = Shapes(medium = RoundedCornerShape(22.dp))

@Composable
fun KnowScrollTheme(
    @Suppress("UNUSED_PARAMETER") darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    MaterialTheme(colorScheme = Scheme, typography = Type, shapes = Shape, content = content)
}

/** Hybrid Set poster register for encounters; spatial Cosmos retains its dark ground. */
object Poster {
    val Paper = Color(0xFFFFFBF0)
    val Ink = Color(0xFF111111)
    val Cobalt = Color(0xFF2C46E8)
    val Yellow = Color(0xFFFFE44D)
    val Teal = Color(0xFF14C79B)
    val Muted = Color(0xFF545450)
}
@Composable
fun PosterTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = androidx.compose.material3.lightColorScheme(
            primary = Poster.Cobalt, onPrimary = Poster.Paper,
            secondary = Poster.Ink, onSecondary = Poster.Paper,
            surface = Poster.Paper, onSurface = Poster.Ink,
            background = Poster.Paper, onBackground = Poster.Ink,
            surfaceVariant = Color(0xFFE8E4DA), onSurfaceVariant = Poster.Muted,
            surfaceContainerHigh = Poster.Paper,
        ),
        typography = Type.copy(
            headlineLarge = Type.headlineLarge.copy(fontSize = 36.sp, lineHeight = 38.sp, fontWeight = FontWeight(800), letterSpacing = (-1).sp),
            bodyLarge = Type.bodyLarge.copy(fontFamily = Heading, fontWeight = FontWeight.Medium),
            bodyMedium = Type.bodyMedium.copy(fontFamily = Heading),
        ),
        shapes = Shape.copy(small = RoundedCornerShape(12.dp)), content = content,
    )
}
