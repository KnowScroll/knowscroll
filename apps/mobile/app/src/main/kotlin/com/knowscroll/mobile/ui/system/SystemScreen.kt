package com.knowscroll.mobile.ui.system

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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.knowscroll.mobile.ui.AtlasEvidenceState
import com.knowscroll.mobile.ui.AtlasState
import com.knowscroll.mobile.ui.PlaceRejectState
import com.knowscroll.mobile.ui.SystemState
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.keep.ConnectionState
import com.knowscroll.mobile.ui.keep.FoundConnectionSheet
import com.knowscroll.mobile.ui.keep.ReturnSheet
import com.knowscroll.mobile.ui.theme.Cosmos

/**
 * #134: the reader's own live places (ADR-0036) on the shared spatial engine (`SpatialAtlas`) --
 * their planets, regions and sightings. Detail is local navigation, and Back returns to the same
 * system. The ADR-0028 worlds response only says whether anything has been encountered yet: #161,
 * a world is one source and its only name is that source's, so no world is ever drawn.
 *
 * #134 (ADR-0039 §6): the map opens with a quiet "While you were away" when something changed that
 * the reader did not cause ([AwaySection]); a found connection opens its evidence in a sheet with
 * "Keep" and "Seems wrong". [away] is defaulted so every other call site is unchanged.
 */
@Composable
fun SystemScreen(
    state: SystemState,
    onReturn: () -> Unit,
    onRetry: () -> Unit,
    onEnterScroll: () -> Unit,
    onOpenKeep: () -> Unit,
    modifier: Modifier = Modifier,
    // #134: defaulted so the fixed-state `ui/fidelity` tests of the empty and unavailable system
    // keep compiling unchanged.
    atlasState: AtlasState = AtlasState.Idle,
    placeRejectState: PlaceRejectState = PlaceRejectState.Idle,
    evidenceState: AtlasEvidenceState = AtlasEvidenceState.Idle,
    onRequestSetAside: (String) -> Unit = {},
    onCancelSetAside: () -> Unit = {},
    onConfirmSetAside: () -> Unit = {},
    onOpenEvidence: (String) -> Unit = {},
    onCloseEvidence: () -> Unit = {},
    away: AwayControls? = null,
) {
    val cameraStates = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    var inspection by rememberSaveable { mutableStateOf(false) }
    var selectedPlaceId by rememberSaveable { mutableStateOf<String?>(null) }
    var focusedRegionId by rememberSaveable { mutableStateOf<String?>(null) }
    // #134 review I3: a place opened directly from the Places list (any depth, any kind) takes
    // priority over the camera-driven selection below -- see onOpenPlaceFromList.
    var listOpenedPlaceId by rememberSaveable { mutableStateOf<String?>(null) }
    val atlas = (atlasState as? AtlasState.Loaded)?.response
    val places = atlas?.places.orEmpty()
    val focusedPlaceId = listOpenedPlaceId ?: focusedRegionId ?: selectedPlaceId
    val focusedPlace = focusedPlaceId?.let { id -> places.firstOrNull { it.placeId == id } }
    LaunchedEffect(atlas, focusedPlaceId) {
        if (focusedPlaceId != null && atlas != null && focusedPlace == null) {
            // The place this sheet was showing is gone (e.g. it was just set aside).
            inspection = false; focusedRegionId = null; selectedPlaceId = null; listOpenedPlaceId = null
        }
    }
    // Opens a place's own sheet directly from the Places list, regardless of its depth or kind --
    // never routed through the camera/marker selection, which only ever understands a planet.
    fun openPlaceFromList(placeId: String) {
        listOpenedPlaceId = placeId
        selectedPlaceId = topmostAncestor(places, placeId)
        inspection = true
    }
    // #134: the found connection whose evidence sheet is open, while the list still carries it.
    var openConnectionId by rememberSaveable { mutableStateOf<String?>(null) }
    val openConnection = away?.let { controls -> openConnectionId?.let { awayFound(controls.state, it) } }
    BackHandler { if (selectedPlaceId != null) selectedPlaceId = null else onReturn() }

    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(Modifier.fillMaxSize()) {
            SystemHeadBand(onReturn)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (state is SystemState.Loaded) {
                    if (state.response.system?.worlds.isNullOrEmpty()) EmptySystem(onEnterScroll)
                    else {
                        Column(
                            Modifier.fillMaxSize()
                                .then(
                                    if (inspection || openConnection != null) Modifier.clearAndSetSemantics {} else Modifier
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
                            // "0 PLACES · 0 SIGHTINGS".
                            if (atlas != null)
                                Text(
                                    placesSubtitle(places),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Cosmos.MutedOnDark,
                                    modifier = Modifier.padding(horizontal = 20.dp),
                                )
                            // #134 review M2: the positions are hash-derived and illustrative; only
                            // what is mapped (the places themselves, their sightings, how they
                            // connect) is real. #131: the orbit rings, every planet's moon and all
                            // land art (continents, currents, clouds) are decoration too, and say so.
                            Text(
                                "Positions, orbits, moons and land art are illustrative — what's mapped and how it connects is real.",
                                style = MaterialTheme.typography.labelSmall,
                                color = Cosmos.MutedOnDark,
                                modifier = Modifier.padding(horizontal = 20.dp),
                            )
                            if (atlas != null && places.none { it.kind == "planet" })
                                Text(
                                    "Places form when you come back to a subject on different days.",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Cosmos.MutedOnDark,
                                    modifier = Modifier.padding(horizontal = 20.dp),
                                )
                            // #134 (ADR-0039): under the labels, above the map; absent unless there
                            // is something unacknowledged.
                            if (away != null)
                                AwaySection(
                                    away, onOpenConnection = { openConnectionId = it },
                                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                                )
                            cameraStates.SaveableStateProvider("camera") {
                                if (atlas == null)
                                    // #134 review I4: never mount the map with empty data -- that fires
                                    // SpatialAtlas's own deselect effect and clears a perfectly good
                                    // selection/sheet for nothing. A loading line, or the real error
                                    // with Retry.
                                    PlacesUnavailable(atlasState, onRetry, Modifier.weight(1f).fillMaxWidth())
                                else
                                    SpatialAtlas(
                                        markers = planetMarkersOf(places),
                                        selectedId = selectedPlaceId,
                                        onSelect = { selectedPlaceId = it; listOpenedPlaceId = null },
                                        modifier = Modifier.weight(1f).fillMaxWidth(),
                                        collectionLabel = "Places",
                                        actionLabel = "Explore place: ",
                                        onDeselect = { selectedPlaceId = null; inspection = false; listOpenedPlaceId = null },
                                        onInspect = { listOpenedPlaceId = null; inspection = true },
                                        sightings = sightingMarkersOf(places),
                                        regions = selectedPlaceId?.let { regionAreasOf(places, it) } ?: emptyList(),
                                        regionsEmptyMessage = "No regions yet — a region forms when you anchor a narrower subject.",
                                        regionActionLabel = "Explore region: ",
                                        onFocusedRegionChanged = { focusedRegionId = it },
                                        listSheetContent = { closeSheet ->
                                            PlacesListSheetContent(
                                                atlas = atlas,
                                                evidenceState = evidenceState,
                                                onOpenEvidence = onOpenEvidence,
                                                onOpenPlace = { placeId -> closeSheet(); openPlaceFromList(placeId) },
                                            )
                                        },
                                    )
                            }
                        }
                        if (inspection && atlas != null && focusedPlace != null) {
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
                                        atlas = atlas,
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
                        } else if (openConnection != null && away != null) {
                            ReturnSheet(onDismiss = { openConnectionId = null }) {
                                FoundConnectionSheet(
                                    found = openConnection,
                                    state = away.connections[openConnection.bridgeId] ?: ConnectionState(),
                                    actions = away.connection,
                                    onClose = { openConnectionId = null },
                                    paused = (away.state as? com.knowscroll.mobile.ui.keep.AwayState.Loaded)?.response?.recordingPaused == true,
                                )
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
    // #134: a connection gone from the list (marked as seen, a new epoch) closes its sheet; Back
    // closes an open one first.
    LaunchedEffect(openConnection == null) { if (openConnection == null) openConnectionId = null }
    BackHandler(enabled = openConnection != null) { openConnectionId = null }
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
