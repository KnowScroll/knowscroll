package com.knowscroll.mobile.ui.system

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.WorldSummary
import com.knowscroll.mobile.data.WorldSystemResponse
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/**
 * The system level (#116, ADR-0028/#113): the same depth the web lane draws
 * (`claude/116-system-view`'s `SystemScreen.tsx`), read from the same `GET /v1/worlds` contract
 * (docs/product/ui-system.md sec.5b/5c; `packages/db/src/worlds.ts`'s `readWorldSystem`). A body
 * per real `world` the API actually returned -- a centre, an orbit, a name and a mono status line
 * -- but nothing here is invented. Every name, count and link comes straight from the response;
 * a body's position on the ring is decorative (no ranking signal exists to place it honestly), and
 * that is the only thing about a body that is decoration -- its identity and its numbers never are.
 *
 * Section 4b: no desktop head band, no 1050/700px breakpoints. The head band's *job* survives as a
 * single leading row above the stage instead of a 66px fixed bar: back, where this came from
 * ("Derived from recorded sources, never inferred" -- methodology, not a data value), the kind
 * label. Bottom compass stays present; System has no dock entry of its own (sec.4b/5b name exactly
 * three: Atlas/Cable/Keep), so it marks Atlas -- the level System is reached from and returns to --
 * tapping Atlas here returns to Universe rather than being a no-op, since System is not Atlas itself.
 */
@Composable
fun SystemScreen(
    state: SystemState,
    onReturn: () -> Unit,
    onRetry: () -> Unit,
    onEnterScroll: () -> Unit,
    onOpenKeep: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(modifier = Modifier.fillMaxSize()) {
            SystemHeadBand(onReturn)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (state) {
                    is SystemState.Idle, is SystemState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.system_loading), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                        }
                    }
                    is SystemState.Unavailable -> SystemUnavailable(state.message, onRetry)
                    is SystemState.Loaded -> SystemBody(state.response)
                }
            }
            BottomCompass(
                selected = CompassTab.Atlas,
                onSelectAtlas = onReturn,
                onSelectCable = onEnterScroll,
                onSelectKeep = onOpenKeep
            )
        }
    }
}

@Composable
private fun SystemHeadBand(onReturn: () -> Unit) {
    val backDescription = stringResource(R.string.system_back_description)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Surface(
            color = Cosmos.Cream.copy(alpha = 0.94f), contentColor = Cosmos.InkOnCream,
            shape = RoundedCornerShape(percent = 50),
            modifier = Modifier.heightIn(min = 48.dp)
                .clickable(onClickLabel = backDescription, onClick = onReturn)
                .semantics { contentDescription = backDescription }
        ) {
            Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                Text("‹ Universe", fontWeight = FontWeight(800), style = MaterialTheme.typography.bodyMedium)
            }
        }
        Text(
            stringResource(R.string.system_head_origin),
            style = MaterialTheme.typography.bodyMedium, color = Cosmos.Teal,
            maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.weight(1f)
        )
        Text(
            stringResource(R.string.system_kind_label),
            style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark
        )
    }
}

@Composable
private fun SystemUnavailable(message: String, onRetry: () -> Unit) {
    val retryDescription = stringResource(R.string.system_retry_description)
    Column(
        Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            stringResource(R.string.system_unavailable_title),
            style = MaterialTheme.typography.titleLarge, color = Cosmos.Coral,
            modifier = Modifier.semantics { heading() }
        )
        Text(message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
        OutlinedButton(
            onClick = onRetry,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription }
        ) { Text(stringResource(R.string.action_retry)) }
    }
}

@Composable
private fun SystemBody(response: WorldSystemResponse) {
    val system = response.system
    if (system == null) {
        // The empty system (ADR-0028: `system` is `null` until this universe's own exposures have
        // actually reached at least one world's evidence) is a designed state that says nothing
        // has been encountered yet -- never an error, and never drawn as one.
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(stringResource(R.string.system_empty_eyebrow), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Text(
                stringResource(R.string.system_empty_title),
                style = MaterialTheme.typography.headlineMedium, color = Cosmos.InkOnDark,
                modifier = Modifier.semantics { heading() }
            )
            Text(stringResource(R.string.system_empty_body), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
        }
        return
    }
    val worlds = system.worlds
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(stringResource(R.string.system_eyebrow), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
        Text(
            stringResource(R.string.system_title),
            style = MaterialTheme.typography.displayLarge, color = Cosmos.InkOnDark,
            modifier = Modifier.semantics { heading() }
        )
        Text(systemSubtitle(worlds), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
        SystemOrbit(worlds)
    }
}

/** `${worlds.size} WORLD(S) · ${totalScrolls} SCROLL(S) RECORDED · ${totalSeen} SEEN` -- every
 * number is a straight sum of the real per-world counts the API returned, never derived from
 * anything this client computed on its own. Mirrors the web lane's own `systemSubtitle()`. */
private fun systemSubtitle(worlds: List<WorldSummary>): String {
    val totalScrolls = worlds.sumOf { it.scrollCount }
    val totalSeen = worlds.sumOf { it.seenCount }
    val worldWord = if (worlds.size == 1) "WORLD" else "WORLDS"
    val scrollWord = if (totalScrolls == 1) "SCROLL" else "SCROLLS"
    return "${worlds.size} $worldWord · $totalScrolls $scrollWord RECORDED · $totalSeen SEEN"
}

/**
 * The orbit diagram: a centre and one real ring, holding every world the API returned. A world's
 * position on the ring is decorative -- no ranking signal exists to place a world honestly closer
 * or farther, so every body sits on the one real orbit, evenly spaced by the order the API
 * returned them in. Starting the spread at angle 0 (the wide axis), not -π/2 (the top): the web
 * lane (`claude/116-system-view`) hit exactly the bug this avoids -- starting at the top put two
 * worlds directly above and below the centre, running each label column through the sun.
 */
@Composable
private fun SystemOrbit(worlds: List<WorldSummary>) {
    val listDescription = stringResource(R.string.system_worlds_list_description)
    BoxWithConstraints(
        Modifier.fillMaxWidth().aspectRatio(16f / 10f)
            .semantics { contentDescription = listDescription }
    ) {
        val w = maxWidth
        val h = maxHeight
        Canvas(Modifier.fillMaxSize()) {
            val cx = size.width / 2f
            val cy = size.height / 2f
            val rx = size.width * 0.4f
            val ry = size.height * 0.24f
            drawOval(
                color = ringColor,
                topLeft = Offset(cx - rx, cy - ry),
                size = Size(rx * 2, ry * 2),
                style = Stroke(width = 1.5f)
            )
            drawCircle(color = sunColor, radius = size.height * 0.09f, center = Offset(cx, cy))
        }
        worlds.forEachIndexed { index, world ->
            val (leftFraction, topFraction) = worldBodyFraction(index, worlds.size)
            WorldBody(
                world = world,
                modifier = Modifier.width(150.dp)
                    .offset(x = w * leftFraction - 75.dp, y = h * topFraction - 45.dp)
            )
        }
    }
}

private val ringColor = Cosmos.Cream.copy(alpha = 0.22f)
private val sunColor = Cosmos.Yellow

/** Pure geometry, deliberately factored out of the `@Composable` so it is directly unit-testable
 * (`SystemGeometryTest`) without Robolectric/Compose: where the [index]th of [total] world bodies
 * sits on the ring, as a `(leftFraction, topFraction)` pair of the orbit box's own width/height --
 * exactly the web lane's own `left = 50 + cos(angle)*40`, `top = 50 + sin(angle)*30` (as fractions,
 * not percent). Spreading starts at angle 0 (the wide axis), never -π/2 (the top): the web lane
 * (`claude/116-system-view`) hit exactly the bug starting at the top causes -- two bodies land
 * directly above and below the centre, both at the same horizontal fraction, so their label
 * columns run straight through the sun. */
internal fun worldBodyFraction(index: Int, total: Int): Pair<Float, Float> {
    val angle = (index.toFloat() / max(total, 1)) * 2f * PI.toFloat()
    // Found by actually running this on-device (emulator-5554): the web lane's own 0.4/0.3
    // amplitude puts a body's ~150dp-wide label column right at the orbit box's horizontal edge,
    // and on a phone that edge is close to the physical screen edge -- the rightmost world's title
    // and tag clipped off-screen. Pulled in to 0.33/0.28 so the label column has margin to fit
    // beside the point it is centred on; still spans nearly the full ring, still decorative.
    val leftFraction = 0.5f + cos(angle) * 0.33f
    val topFraction = 0.5f + sin(angle) * 0.28f
    return leftFraction to topFraction
}

/** ADR-0028's `seen_count >= 1` guard means `GET /v1/worlds` only ever returns a world this
 * universe has encountered at least once, so "fully vs partially reached" (never "seen vs not") is
 * the one honest, database-verified distinction available to draw. Pure and unit-tested
 * (`SystemGeometryTest`) separately from the Compose tree that reads it. */
internal fun isWorldFullyExplored(world: WorldSummary): Boolean =
    world.scrollCount > 0 && world.seenCount >= world.scrollCount

/** One real body: its name, its two counts and its source link all come straight from [world]. */
@Composable
private fun WorldBody(world: WorldSummary, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var browserUnavailable by remember(world.worldId) { mutableStateOf(false) }
    val fullyExplored = isWorldFullyExplored(world)
    val scrollWord = if (world.scrollCount == 1) "SCROLL" else "SCROLLS"
    val statusLine = "${world.scrollCount} $scrollWord · ${world.seenCount} SEEN"
    val tag = stringResource(if (fullyExplored) R.string.system_fully_explored else R.string.system_more_to_explore)
    val openDescription = stringResource(R.string.system_open_source_description, world.sourceTitle)
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(44.dp)) {
            Canvas(Modifier.fillMaxSize()) {
                val ringRadius = (size.minDimension / 2f) - 2f
                if (fullyExplored) {
                    drawCircle(color = Cosmos.Green, radius = ringRadius, style = Stroke(width = 5f))
                } else {
                    drawCircle(
                        color = Cosmos.Teal2, radius = ringRadius,
                        style = Stroke(width = 3f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 7f)))
                    )
                }
            }
            Box(Modifier.size(34.dp).clip(CircleShape).background(Cosmos.Teal))
        }
        Text(world.sourceTitle, style = MaterialTheme.typography.titleMedium, color = Cosmos.InkOnDark, textAlign = TextAlign.Center)
        Text(statusLine, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
        SystemTag(tag, fullyExplored)
        Surface(
            color = Cosmos.Teal, contentColor = Cosmos.InkOnCream,
            shape = RoundedCornerShape(percent = 50),
            modifier = Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp)
                .clickable(onClickLabel = openDescription) {
                    browserUnavailable = runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(world.sourceUrl)))
                    }.isFailure
                }
                .semantics { contentDescription = openDescription }
        ) {
            Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.action_open_source), fontWeight = FontWeight(800), style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (browserUnavailable) Text(
            stringResource(R.string.reader_browser_unavailable),
            style = MaterialTheme.typography.labelMedium, color = Cosmos.Coral, textAlign = TextAlign.Center
        )
    }
}

@Composable
private fun SystemTag(label: String, fullyExplored: Boolean) {
    Surface(
        color = if (fullyExplored) Cosmos.Green else Cosmos.Dark,
        contentColor = if (fullyExplored) Cosmos.InkOnCream else Cosmos.Teal2,
        shape = RoundedCornerShape(percent = 50),
        border = if (fullyExplored) null else BorderStroke(1.dp, Cosmos.Teal2)
    ) {
        Text(
            label, style = MaterialTheme.typography.labelMedium,
            color = if (fullyExplored) Cosmos.InkOnCream else Cosmos.Teal2,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
        )
    }
}
