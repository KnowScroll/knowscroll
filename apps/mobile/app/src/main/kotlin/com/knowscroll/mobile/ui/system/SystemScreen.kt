package com.knowscroll.mobile.ui.system

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos

/**
 * Source-backed worlds use the existing ADR-0028 response. Detail is local navigation, decorative
 * cartography carries no inferred regions, and Back returns to the same system.
 */
@Composable
fun SystemScreen(
    state: SystemState,
    onReturn: () -> Unit,
    onRetry: () -> Unit,
    onEnterScroll: () -> Unit,
    onOpenKeep: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var selectedWorldId by rememberSaveable { mutableStateOf<String?>(null) }
    val worlds = (state as? SystemState.Loaded)?.response?.system?.worlds.orEmpty()
    val selected = worlds.firstOrNull { it.worldId == selectedWorldId }
    BackHandler(enabled = selected != null) { selectedWorldId = null }
    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(Modifier.fillMaxSize()) {
            SystemHeadBand(onReturn)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (state is SystemState.Loaded) {
                    val loadedWorlds = state.response.system?.worlds.orEmpty()
                    if (loadedWorlds.isEmpty()) EmptySystem(onEnterScroll)
                    else {
                        Column(Modifier.fillMaxSize()) {
                            Text(
                                "Your system",
                                style = MaterialTheme.typography.titleLarge,
                                color = Cosmos.Cream,
                                modifier = Modifier.padding(horizontal = 20.dp),
                            )
                            Text(
                                systemSubtitle(loadedWorlds),
                                style = MaterialTheme.typography.labelSmall,
                                color = Cosmos.MutedOnDark,
                                modifier = Modifier.padding(horizontal = 20.dp),
                            )
                            SpatialAtlas(
                                loadedWorlds.map { world ->
                                    AtlasMarker(
                                        world.worldId,
                                        world.sourceTitle,
                                        "${world.scrollCount} ${if(world.scrollCount==1) "SCROLL" else "SCROLLS"} · ${world.seenCount} SEEN",
                                        if (isWorldFullyExplored(world)) "ALL SCROLLS ENCOUNTERED"
                                        else "MORE TO EXPLORE",
                                    )
                                },
                                selectedWorldId,
                                { selectedWorldId = it },
                                Modifier.weight(1f).fillMaxWidth(),
                            )
                        }
                        if (selected != null)
                            Surface(
                                modifier =
                                    Modifier.align(Alignment.BottomCenter)
                                        .fillMaxWidth()
                                        .heightIn(max = 340.dp),
                                color = Cosmos.Deep,
                                shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
                            ) {
                                WorldDetail(
                                    selected,
                                    onClose = { selectedWorldId = null },
                                    onDiscover = onEnterScroll,
                                )
                            }
                    }
                } else
                    when (state) {
                        // Never animate private world content out while authority is being
                        // rechecked.
                        is SystemState.Idle,
                        is SystemState.Loading ->
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    CircularProgressIndicator(
                                        color = Cosmos.Teal,
                                        strokeWidth = 2.dp,
                                        modifier = Modifier.size(18.dp),
                                    )
                                    Text(
                                        stringResource(R.string.system_loading),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = Cosmos.MutedOnDark,
                                    )
                                }
                            }
                        is SystemState.Unavailable -> SystemUnavailable(state.message, onRetry)
                        is SystemState.Loaded -> Unit
                    }
            }

            BottomCompass(CompassTab.Atlas, onReturn, onEnterScroll, onOpenKeep)
        }
    }
}

@Composable
private fun SystemHeadBand(onReturn: () -> Unit) {
    val backDescription = stringResource(R.string.system_back_description)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Surface(
            color = Cosmos.Cream.copy(alpha = 0.94f),
            contentColor = Cosmos.InkOnCream,
            shape = RoundedCornerShape(percent = 50),
            modifier =
                Modifier.heightIn(min = 48.dp)
                    .clickable(onClickLabel = backDescription, onClick = onReturn)
                    .semantics { contentDescription = backDescription },
        ) {
            Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                Text(
                    "‹ Universe",
                    fontWeight = FontWeight(800),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        Text(
            stringResource(R.string.system_head_origin),
            style = MaterialTheme.typography.bodyMedium,
            color = Cosmos.Teal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.weight(1f),
        )
        Text(
            stringResource(R.string.system_kind_label),
            style = MaterialTheme.typography.labelMedium,
            color = Cosmos.MutedOnDark,
        )
    }
}

@Composable
private fun SystemUnavailable(message: String, onRetry: () -> Unit) {
    val retryDescription = stringResource(R.string.system_retry_description)
    Column(
        Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            stringResource(R.string.system_unavailable_title),
            style = MaterialTheme.typography.titleLarge,
            color = Cosmos.Coral,
            modifier = Modifier.semantics { heading() },
        )
        Text(message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
        OutlinedButton(
            onClick = onRetry,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
            modifier =
                Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
        ) {
            Text(stringResource(R.string.action_retry))
        }
    }
}

@Composable
private fun EmptySystem(onEnterScroll: () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            stringResource(R.string.system_empty_eyebrow),
            style = MaterialTheme.typography.labelMedium,
            color = Cosmos.MutedOnDark,
        )
        Text(
            stringResource(R.string.system_empty_title),
            style = MaterialTheme.typography.headlineMedium,
            color = Cosmos.InkOnDark,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.system_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            color = Cosmos.MutedOnDark,
        )
        OutlinedButton(onClick = onEnterScroll) { Text("Show me something ↗") }
    }
}

/**
 * `${worlds.size} WORLD(S) · ${totalScrolls} SCROLL(S) RECORDED · ${totalSeen} SEEN` -- every
 * number is a straight sum of the real per-world counts the API returned, never derived from
 * anything this client computed on its own. Mirrors the web lane's own `source counts.
 */
internal fun systemSubtitle(worlds: List<WorldSummary>): String {
    val totalScrolls = worlds.sumOf { it.scrollCount }
    val totalSeen = worlds.sumOf { it.seenCount }
    val worldWord = if (worlds.size == 1) "WORLD" else "WORLDS"
    val scrollWord = if (totalScrolls == 1) "SCROLL" else "SCROLLS"
    return "${worlds.size} $worldWord · $totalScrolls $scrollWord RECORDED · $totalSeen SEEN"
}

/**
 * ADR-0028's `seen_count >= 1` guard means `GET /v1/worlds` only ever returns a world this universe
 * has encountered at least once, so "fully vs partially reached" (never "seen vs not") is the one
 * honest, database-verified distinction available to draw. Pure and unit-tested
 * (`SystemGeometryTest`) separately from the Compose tree that reads it.
 */
internal fun isWorldFullyExplored(world: WorldSummary): Boolean =
    world.scrollCount > 0 && world.seenCount >= world.scrollCount

/** All source actions live in the selected world, leaving the system quiet and scannable. */
@Composable
private fun WorldDetail(world: WorldSummary, onClose: () -> Unit, onDiscover: () -> Unit) {
    val backDescription = stringResource(R.string.world_detail_back_description)
    val openDescription =
        stringResource(R.string.world_detail_open_source_description, world.sourceTitle)
    val countsText =
        stringResource(R.string.world_detail_counts, world.seenCount, world.scrollCount)
    val context = LocalContext.current
    var browserUnavailable by remember(world.worldId) { mutableStateOf(false) }
    Surface(
        color = androidx.compose.ui.graphics.Color.Transparent,
        contentColor = Cosmos.InkOnDark,
        shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            Modifier.fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Surface(
                    color = Cosmos.Cream.copy(alpha = 0.94f),
                    contentColor = Cosmos.InkOnCream,
                    shape = RoundedCornerShape(percent = 50),
                    modifier =
                        Modifier.heightIn(min = 48.dp)
                            .clickable(onClickLabel = backDescription, onClick = onClose)
                            .semantics { contentDescription = backDescription },
                ) {
                    Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                        Text(
                            "‹ System",
                            fontWeight = FontWeight(800),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                Text(
                    stringResource(R.string.world_detail_title),
                    style = MaterialTheme.typography.labelLarge,
                    color = Cosmos.MutedOnDark,
                    modifier = Modifier.weight(1f),
                )
            }

            Text(
                world.sourceTitle,
                style = MaterialTheme.typography.headlineLarge,
                color = Cosmos.InkOnDark,
                modifier = Modifier.fillMaxWidth().semantics { heading() },
            )
            Text(
                countsText,
                style = MaterialTheme.typography.labelLarge,
                color = Cosmos.MutedOnDark,
            )
            OutlinedButton(onClick = onDiscover, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Open discovery")
            }
            Text(
                "Explore the library, then return to this world.",
                style = MaterialTheme.typography.bodySmall,
                color = Cosmos.MutedOnDark,
            )
            Text(
                stringResource(R.string.world_detail_explanation),
                style = MaterialTheme.typography.bodyMedium,
                color = Cosmos.MutedOnDark,
            )
            Button(
                onClick = {
                    browserUnavailable =
                        runCatching {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW, Uri.parse(world.sourceUrl))
                                )
                            }
                            .isFailure
                },
                colors =
                    ButtonDefaults.buttonColors(
                        containerColor = Cosmos.Teal,
                        contentColor = Cosmos.Dark,
                    ),
                modifier =
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics {
                        contentDescription = openDescription
                    },
            ) {
                Text(
                    stringResource(R.string.action_open_source),
                    fontWeight = FontWeight(800),
                    style = MaterialTheme.typography.labelLarge,
                )
            }
            if (browserUnavailable)
                Text(
                    stringResource(R.string.reader_browser_unavailable),
                    style = MaterialTheme.typography.labelMedium,
                    color = Cosmos.Coral,
                )
        }
    }
}
