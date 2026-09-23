package com.knowscroll.mobile.ui.preview

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.data.*
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.system.*
import com.knowscroll.mobile.ui.theme.Cosmos

/** A versioned authored graph, never a projection of the reader's interests. Scope owned by app. */
@Composable
fun AuthoredAtlas(authority: Universe, onClose: () -> Unit, onAuthorityFailure: () -> Unit) {
    var system by rememberSaveable { mutableStateOf(false) }
    var planet by rememberSaveable { mutableStateOf<String?>(null) }
    var content by rememberSaveable { mutableStateOf<String?>(null) }
    var media by remember { mutableStateOf<List<ScrollItem>>(emptyList()) }
    var failure by remember { mutableStateOf(false) }
    val places = rememberSaveableStateHolder()
    LaunchedEffect(authority.universeId, authority.privacyEpoch) {
        try {
            val feed = ApiClient().getFeed("Reel")
            if (
                feed.universeId != authority.universeId ||
                    feed.privacyEpoch != authority.privacyEpoch
            ) {
                onClose()
                onAuthorityFailure()
                return@LaunchedEffect
            }
            media = feed.items.filter { it.media?.simulated == true }.sortedBy { it.assetId }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (com.knowscroll.mobile.ui.invalidatesReader(e)) {
                onClose()
                onAuthorityFailure()
            } else failure = true
        }
    }
    val markers = remember {
        listOf(
            AtlasMarker("authored-orbits-v1", "Orbits"),
            AtlasMarker("authored-models-v1", "Models"),
            AtlasMarker("authored-demos-v1", "Supplied demos"),
        )
    }
    val topics =
        remember(media) {
            buildList {
                for (p in markers.take(2)) for (r in listOf("coast", "inland")) {
                    val area = authoredRegions.first { it.suffix == r }
                    previewTitles.forEachIndexed { i, title ->
                        add(
                            AtlasTopic(
                                "${p.id}:$r:scroll:$i",
                                p.id,
                                r,
                                title,
                                "Scroll",
                                "MODELLED · AUTHORED REVISION 1",
                                "1 source · NASA orbit reference",
                                area.x + listOf(-12f, 6f, 17f)[i],
                                area.y + listOf(5f, -9f, 14f)[i],
                            )
                        )
                    }
                }
                for (r in listOf("coast", "inland")) {
                    val area = authoredRegions.first { it.suffix == r }
                    media.forEachIndexed { i, item ->
                        add(
                            AtlasTopic(
                                "reel:${item.assetId}@${item.revision}:$r",
                                "authored-demos-v1",
                                r,
                                item.title,
                                "Reel",
                                "SIMULATED · SUPPLIED TEST MEDIA",
                                "Authored demo collection · ${item.sourceTitle}",
                                area.x + listOf(-12f, 6f, 17f)[i % 3],
                                area.y + listOf(5f, -9f, 14f)[i % 3],
                            )
                        )
                    }
                }
            }
        }
    BackHandler {
        if (content != null) content = null
        else if (planet != null) planet = null
        else if (system) {
            planet = null
            system = false
        } else onClose()
    }
    if (content != null) {
        val target = content!!
        places.SaveableStateProvider("content:$target") {
            AuthoredPreview(
                authority,
                { content = null },
                onAuthorityFailure,
                initialScroll =
                    if (target.startsWith("reel:")) 0 else target.substringAfterLast(':').toInt(),
                initialReel =
                    if (target.startsWith("reel:"))
                        target.removePrefix("reel:").substringBefore(':')
                    else null,
                atlasOrigin = true,
            )
        }
    } else
        Box(Modifier.fillMaxSize()) {
            CosmosBackground()
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(
                        onClick = {
                            if (system) {
                                planet = null
                                system = false
                            } else onClose()
                        }
                    ) {
                        Text(
                            if (system) "‹ Preview universe" else "‹ Your universe",
                            color = Cosmos.Cream,
                        )
                    }
                    Text(
                        "AUTHORED ATLAS",
                        color = Cosmos.Teal,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                if (!system) {
                    Text(
                        "A small universe to explore",
                        Modifier.padding(20.dp),
                        color = Cosmos.Cream,
                        style = MaterialTheme.typography.headlineMedium,
                    )
                    Text(
                        "Authored places & links · no history recorded",
                        Modifier.padding(horizontal = 20.dp),
                        color = Cosmos.CreamDim,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        MiniSystem(
                            "Orbit laboratory",
                            "3 authored planets",
                            { system = true },
                            Modifier.size(220.dp),
                            "Enter authored system",
                        )
                    }
                } else {
                    Text(
                        "Orbit laboratory",
                        Modifier.padding(horizontal = 20.dp),
                        color = Cosmos.Cream,
                        style = MaterialTheme.typography.titleLarge,
                    )
                    if (failure)
                        Text(
                            "Supplied videos unavailable; authored Scrolls remain ready.",
                            Modifier.padding(16.dp),
                            color = Cosmos.Cream,
                        )
                    places.SaveableStateProvider("atlas") {
                        SpatialAtlas(
                            markers,
                            planet,
                            { planet = it },
                            Modifier.weight(1f).fillMaxWidth(),
                            collectionLabel = "Planets",
                            onDeselect = { planet = null },
                            topics = topics,
                            onOpenTopic = { content = it.id },
                        )
                    }
                }
            }
        }
}

@Composable
fun MiniSystem(
    title: String,
    detail: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    description: String = "Open the system view",
) {
    Column(
        modifier.clickable(onClick = onClick).semantics { contentDescription = description },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Canvas(Modifier.size(140.dp, 90.dp)) {
            val c = center
            listOf(.7f, 1f).forEach { f ->
                drawOval(
                    Cosmos.Cream.copy(alpha = .25f),
                    Offset(c.x - 60.dp.toPx() * f, c.y - 24.dp.toPx() * f),
                    Size(120.dp.toPx() * f, 48.dp.toPx() * f),
                    style = Stroke(1.dp.toPx()),
                )
            }
            drawCircle(Cosmos.Yellow.copy(alpha = .08f), 36.dp.toPx(), c)
            drawCircle(Cosmos.Yellow.copy(alpha = .15f), 23.dp.toPx(), c)
            drawCircle(Cosmos.Cream, 9.dp.toPx(), c)
            drawCircle(Cosmos.Teal, 4.dp.toPx(), c + Offset(47.dp.toPx(), 14.dp.toPx()))
            drawCircle(Cosmos.Pink, 3.dp.toPx(), c - Offset(39.dp.toPx(), 19.dp.toPx()))
        }
        Text(title, color = Cosmos.Cream, style = MaterialTheme.typography.titleMedium)
        Text(detail, color = Cosmos.CreamDim, style = MaterialTheme.typography.labelSmall)
    }
}
