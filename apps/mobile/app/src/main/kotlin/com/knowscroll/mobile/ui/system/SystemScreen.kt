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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.data.WorldSummary
import com.knowscroll.mobile.ui.AtlasEvidenceState
import com.knowscroll.mobile.ui.AtlasState
import com.knowscroll.mobile.ui.PlaceRejectState
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos

/**
 * Source-backed worlds use the existing ADR-0028 response. Detail is local navigation, decorative
 * cartography carries no inferred regions, and Back returns to the same system.
 *
 * #134: the reader's own live places (ADR-0036) share this screen as a second, default layer --
 * see [AtlasLayer]. Sources is unchanged; Places reuses the same spatial engine (`SpatialAtlas`)
 * with the reader's planets/regions/sightings in place of the source worlds/authored geography.
 */
@Composable
fun SystemScreen(
    state: SystemState,
    onReturn: () -> Unit,
    onRetry: () -> Unit,
    onEnterScroll: () -> Unit,
    onOpenKeep: () -> Unit,
    modifier: Modifier = Modifier,
    // #134: defaulted so every call site that only knows about Sources (incl. the existing
    // `ui/fidelity` fixed-state screenshot/geometry tests) keeps compiling unchanged.
    atlasState: AtlasState = AtlasState.Idle,
    placeRejectState: PlaceRejectState = PlaceRejectState.Idle,
    evidenceState: AtlasEvidenceState = AtlasEvidenceState.Idle,
    onRequestSetAside: (String) -> Unit = {},
    onCancelSetAside: () -> Unit = {},
    onConfirmSetAside: () -> Unit = {},
    onOpenEvidence: (String) -> Unit = {},
    onCloseEvidence: () -> Unit = {},
) {
    val cameraStates = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    var inspection by rememberSaveable { mutableStateOf(false) }
    var selectedWorldId by rememberSaveable { mutableStateOf<String?>(null) }
    var focusedRegionId by rememberSaveable { mutableStateOf<String?>(null) }
    // #134 review I3: a place opened directly from the Places list (any depth, any kind) takes
    // priority over the camera-driven selection below -- see onOpenPlaceFromList.
    var listOpenedPlaceId by rememberSaveable { mutableStateOf<String?>(null) }
    var manualLayer by rememberSaveable { mutableStateOf<String?>(null) }
    val worlds = (state as? SystemState.Loaded)?.response?.system?.worlds.orEmpty()
    val atlas = (atlasState as? AtlasState.Loaded)?.response
    val places = atlas?.places.orEmpty()
    // #134 review I4: the reactive default only ever moves on real data (a Loaded atlas), never on
    // the transient Loading state every refresh passes through -- otherwise a refresh while already
    // on this screen (e.g. returning to it) would flip Places -> Sources -> Places and reset the
    // selection twice, once for each flip.
    var lastDefaultLayer by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(atlasState) {
        if (atlasState is AtlasState.Loaded)
            lastDefaultLayer = if (defaultAtlasLayer(places) == AtlasLayer.Places) "places" else "sources"
    }
    val layer = manualLayer?.let { if (it == "places") AtlasLayer.Places else AtlasLayer.Sources }
        ?: if (lastDefaultLayer == "places") AtlasLayer.Places else AtlasLayer.Sources
    val layerKey = if (layer == AtlasLayer.Places) "places" else "sources"
    // #134 review I4: reset the selection only when the layer actually *changed* since the last
    // time this ran -- not merely because this composition is a fresh mount (leaving for the reader
    // and returning with system Back, or a rotation, both start a fresh LaunchedEffect history even
    // though rememberedLayer/selectedWorldId themselves survived via rememberSaveable).
    var rememberedLayer by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(layerKey) {
        if (rememberedLayer != null && rememberedLayer != layerKey) {
            selectedWorldId = null; focusedRegionId = null; listOpenedPlaceId = null; inspection = false
        }
        rememberedLayer = layerKey
    }
    val focusedPlaceId = if (layer == AtlasLayer.Places) listOpenedPlaceId ?: focusedRegionId ?: selectedWorldId else null
    val focusedPlace = focusedPlaceId?.let { id -> places.firstOrNull { it.placeId == id } }
    LaunchedEffect(atlas, focusedPlaceId) {
        if (layer == AtlasLayer.Places && focusedPlaceId != null && atlas != null && focusedPlace == null) {
            // The place this sheet was showing is gone (e.g. it was just set aside).
            inspection = false; focusedRegionId = null; selectedWorldId = null; listOpenedPlaceId = null
        }
    }
    // Opens a place's own sheet directly from the Places list, regardless of its depth or kind --
    // never routed through the camera/marker selection, which only ever understands a planet.
    fun openPlaceFromList(placeId: String) {
        listOpenedPlaceId = placeId
        selectedWorldId = topmostAncestor(places, placeId)
        inspection = true
    }
    val selected = worlds.firstOrNull { it.worldId == selectedWorldId }
    BackHandler { if (selectedWorldId != null) selectedWorldId = null else onReturn() }

    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(Modifier.fillMaxSize()) {
            SystemHeadBand(onReturn)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (state is SystemState.Loaded) {
                    val loadedWorlds = state.response.system?.worlds.orEmpty()
                    if (loadedWorlds.isEmpty()) EmptySystem(onEnterScroll)
                    else {
                        Column(
                            Modifier.fillMaxSize()
                                .then(
                                    if (inspection) Modifier.clearAndSetSemantics {} else Modifier
                                )
                        ) {
                            Text(
                                "Your system",
                                style = MaterialTheme.typography.titleLarge,
                                color = Cosmos.Cream,
                                modifier = Modifier.padding(horizontal = 20.dp),
                            )
                            // #134 review I4: never a subtitle derived from an atlas that has not
                            // actually loaded -- while a first load/refresh is in flight or has
                            // failed, `places` is empty and this would otherwise read a false
                            // "0 PLACES · 0 SIGHTINGS". Sources' own subtitle is unaffected.
                            if (layer == AtlasLayer.Sources || atlas != null)
                                Text(
                                    // #134 review M2: Places counts its own live places/sightings, never
                                    // the Sources world/Scroll counts -- the two layers show different data.
                                    if (layer == AtlasLayer.Places) placesSubtitle(places) else systemSubtitle(loadedWorlds),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Cosmos.MutedOnDark,
                                    modifier = Modifier.padding(horizontal = 20.dp),
                                )
                            AtlasLayerToggle(
                                layer = layer,
                                onSelect = { manualLayer = if (it == AtlasLayer.Places) "places" else "sources" },
                                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                            )
                            if (layer == AtlasLayer.Sources) {
                                // #134 review M2: PR130's own label, restored unconditionally --
                                // it is never replaced by the places-forming explanation below.
                                Text(
                                    "Orbits & moons are illustrative",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Cosmos.MutedOnDark,
                                    modifier = Modifier.padding(horizontal = 20.dp),
                                )
                                if (places.none { it.kind == "planet" })
                                    Text(
                                        "Places form when you come back to a subject on different days.",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = Cosmos.MutedOnDark,
                                        modifier = Modifier.padding(horizontal = 20.dp),
                                    )
                            } else
                                // #134 review M2: Places' own honest equivalent -- its positions are
                                // just as hash-derived/illustrative as Sources' orbits; only what is
                                // mapped (the places themselves, their sightings, how they connect) is real.
                                Text(
                                    "Positions are illustrative — what's mapped and how it connects is real.",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Cosmos.MutedOnDark,
                                    modifier = Modifier.padding(horizontal = 20.dp),
                                )
                            cameraStates.SaveableStateProvider("camera:${layer.name}") {
                                if (layer == AtlasLayer.Places && atlas == null)
                                    // #134 review I4: never mount the Places map with empty data --
                                    // that fires SpatialAtlas's own deselect effect and clears a
                                    // perfectly good selection/sheet for nothing. A loading line, or
                                    // the real error with Retry.
                                    PlacesUnavailable(atlasState, onRetry, Modifier.weight(1f).fillMaxWidth())
                                else if (layer == AtlasLayer.Places)
                                    SpatialAtlas(
                                        markers = planetMarkersOf(places),
                                        selectedId = selectedWorldId,
                                        onSelect = { selectedWorldId = it; listOpenedPlaceId = null },
                                        modifier = Modifier.weight(1f).fillMaxWidth(),
                                        collectionLabel = "Places",
                                        actionLabel = "Explore place: ",
                                        onDeselect = { selectedWorldId = null; inspection = false; listOpenedPlaceId = null },
                                        onInspect = { listOpenedPlaceId = null; inspection = true },
                                        sightings = sightingMarkersOf(places),
                                        regions = selectedWorldId?.let { regionAreasOf(places, it) } ?: emptyList(),
                                        regionsEmptyMessage = "No regions yet — a region forms when you anchor a narrower subject.",
                                        regionActionLabel = "Explore region: ",
                                        onFocusedRegionChanged = { focusedRegionId = it },
                                        listSheetContent = { closeSheet ->
                                            PlacesListSheetContent(
                                                atlas = atlas ?: AtlasResponse("", emptyList(), emptyList(), emptyList()),
                                                evidenceState = evidenceState,
                                                onOpenEvidence = onOpenEvidence,
                                                onOpenPlace = { placeId -> closeSheet(); openPlaceFromList(placeId) },
                                            )
                                        },
                                    )
                                else
                                    SpatialAtlas(
                                        loadedWorlds.map { world ->
                                            AtlasMarker(
                                                world.worldId,
                                                world.sourceTitle,
                                                "${world.scrollCount} ${if(world.scrollCount==1) "SCROLL" else "SCROLLS"} · ${world.seenCount} SEEN",
                                                if (isWorldFullyExplored(world))
                                                    "ALL SCROLLS ENCOUNTERED"
                                                else "MORE TO EXPLORE",
                                            )
                                        },
                                        selectedWorldId,
                                        { selectedWorldId = it },
                                        Modifier.weight(1f).fillMaxWidth(),
                                        onDeselect = {
                                            selectedWorldId = null
                                            inspection = false
                                        },
                                        onInspect = { inspection = true },
                                    )
                            }
                        }
                        if (inspection && layer == AtlasLayer.Places && focusedPlace != null) {
                            Box(
                                Modifier.fillMaxSize()
                                    .clickable { inspection = false }
                                    .semantics { contentDescription = "Dismiss place inspection" }
                            )
                            Surface(
                                modifier =
                                    Modifier.align(Alignment.BottomCenter)
                                        .fillMaxWidth()
                                        .heightIn(max = 480.dp),
                                color = Cosmos.Cream,
                                shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
                            ) {
                                com.knowscroll.mobile.ui.theme.PosterTheme {
                                    PlaceDetail(
                                        place = focusedPlace,
                                        atlas = atlas ?: AtlasResponse("", emptyList(), emptyList(), emptyList()),
                                        rejectState = placeRejectState,
                                        evidenceState = evidenceState,
                                        onClose = { inspection = false },
                                        onRequestSetAside = onRequestSetAside,
                                        onCancelSetAside = onCancelSetAside,
                                        onConfirmSetAside = onConfirmSetAside,
                                        onOpenEvidence = onOpenEvidence,
                                        onCloseEvidence = onCloseEvidence,
                                    )
                                }
                            }
                        } else if (selected != null && inspection) {
                            // Consume taps above inspection as a dismissal, never through to the
                            // map.
                            Box(
                                Modifier.fillMaxSize()
                                    .clickable { inspection = false }
                                    .semantics { contentDescription = "Dismiss world inspection" }
                            )
                            Surface(
                                modifier =
                                    Modifier.align(Alignment.BottomCenter)
                                        .fillMaxWidth()
                                        .heightIn(max = 340.dp),
                                color = Cosmos.Cream,
                                shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
                            ) {
                                com.knowscroll.mobile.ui.theme.PosterTheme {
                                    WorldDetail(
                                        selected,
                                        onClose = { inspection = false },
                                        onDiscover = onEnterScroll,
                                    )
                                }
                            }
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
    BackHandler(enabled = inspection) { inspection = false }
}

/** The reader's own choice between the two layers of the same system: places formed from their
 * reading (default once any exist) and the unchanged source worlds. */
@Composable
private fun AtlasLayerToggle(layer: AtlasLayer, onSelect: (AtlasLayer) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AtlasLayer.entries.forEach { option ->
            val label = if (option == AtlasLayer.Places) "Places" else "Sources"
            val selected = option == layer
            Surface(
                color = if (selected) Cosmos.Teal else Cosmos.Cream.copy(alpha = .18f),
                contentColor = if (selected) Cosmos.Dark else Cosmos.Cream,
                shape = RoundedCornerShape(percent = 50),
                modifier =
                    Modifier.heightIn(min = 40.dp)
                        .clickable(onClickLabel = "Show $label") { onSelect(option) }
                        .semantics { contentDescription = if (selected) "$label, selected" else "Show $label" },
            ) {
                Box(Modifier.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                    Text(label, fontWeight = FontWeight(700), style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

/** #134 review I4: shown in place of the Places map itself while the atlas has not (yet, or not
 * currently) loaded -- a loading line, or the real error with a Retry that reuses the same
 * [onRetry] the rest of this screen already offers (re-fetches worlds and the atlas together). */
@Composable
private fun PlacesUnavailable(atlasState: AtlasState, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) {
        if (atlasState is AtlasState.Unavailable) {
            val retryDescription = "Retry loading your places"
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Your places are unavailable", style = MaterialTheme.typography.titleMedium, color = Cosmos.Coral)
                Text(atlasState.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                OutlinedButton(
                    onClick = onRetry,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
                ) { Text("Retry") }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                Text("Loading your places…", style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
            }
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
        contentColor = Cosmos.InkOnCream,
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
                    color = Cosmos.MutedOnCream,
                    modifier = Modifier.weight(1f),
                )
            }

            Text(
                world.sourceTitle,
                style = MaterialTheme.typography.headlineLarge,
                color = Cosmos.InkOnCream,
                modifier = Modifier.fillMaxWidth().semantics { heading() },
            )
            Text(
                countsText,
                style = MaterialTheme.typography.labelLarge,
                color = Cosmos.MutedOnCream,
            )
            Text(
                stringResource(R.string.world_detail_explanation),
                style = MaterialTheme.typography.bodyMedium,
                color = Cosmos.MutedOnCream,
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
