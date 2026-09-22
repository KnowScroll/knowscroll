package com.knowscroll.mobile.ui.system

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.ui.common.rememberReducedMotion
import com.knowscroll.mobile.ui.theme.Cosmos
import com.knowscroll.mobile.ui.theme.PosterTheme
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

data class AtlasMarker(
    val id: String,
    val title: String,
    val detail: String = "",
    val status: String = "",
)

/** One camera owns the entire world-to-screen transform, from orbit to authored local detail. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SpatialAtlas(
    markers: List<AtlasMarker>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    collectionLabel: String = "Worlds",
    actionLabel: String = "Explore world: ",
    onDetailLevelChanged: (Boolean) -> Unit = {},
) {
    val points = remember(markers) { atlasLayout(markers.map { it.id }) }
    val markerById = remember(markers) { markers.associateBy { it.id } }
    var x by rememberSaveable { mutableFloatStateOf(0f) }
    var y by rememberSaveable { mutableFloatStateOf(0f) }
    var zoom by rememberSaveable { mutableFloatStateOf(1f) }
    var homeX by rememberSaveable { mutableFloatStateOf(0f) }
    var homeY by rememberSaveable { mutableFloatStateOf(0f) }
    var homeZoom by rememberSaveable { mutableFloatStateOf(1f) }
    var wasSelected by rememberSaveable { mutableStateOf<String?>(null) }
    var continentX by rememberSaveable { mutableFloatStateOf(0f) }
    var continentY by rememberSaveable { mutableFloatStateOf(0f) }
    var continentZoom by rememberSaveable { mutableFloatStateOf(3.8f) }
    var region by rememberSaveable(selectedId) { mutableStateOf<String?>(null) }
    var listOpen by rememberSaveable { mutableStateOf(false) }
    var regionsOpen by rememberSaveable { mutableStateOf(false) }
    var stationOpen by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var flight by remember { mutableStateOf<Job?>(null) }
    val reduced = rememberReducedMotion()
    val density = LocalDensity.current.density
    val selectedPoint = points.firstOrNull { it.id == selectedId }
    val land by remember(selectedId) { derivedStateOf { selectedId != null && zoom >= 2.8f } }
    val local by remember(selectedId) { derivedStateOf { selectedId != null && zoom >= 6.5f } }
    fun camera() = AtlasCamera(x, y, zoom)
    fun apply(value: AtlasCamera) {
        x = value.x
        y = value.y
        zoom = value.zoom
    }
    fun fly(target: AtlasCamera) {
        flight?.cancel()
        if (reduced) {
            apply(target)
            return
        }
        val start = camera()
        flight = scope.launch {
            Animatable(0f).animateTo(1f, spring(dampingRatio = 1f, stiffness = 420f)) {
                apply(
                    AtlasCamera(
                        start.x + (target.x - start.x) * value,
                        start.y + (target.y - start.y) * value,
                        start.zoom + (target.zoom - start.zoom) * value,
                    )
                )
            }
        }
    }
    fun enterRegion(suffix: String, targetX: Float, targetY: Float) {
        if (!local) {
            continentX = x
            continentY = y
            continentZoom = zoom
        }
        region = suffix
        fly(AtlasCamera(targetX, targetY, 8f))
    }
    fun returnToContinents() {
        region = null
        fly(AtlasCamera(continentX, continentY, continentZoom))
    }
    LaunchedEffect(selectedId) {
        if (selectedId != null && selectedId != wasSelected) {
            if (wasSelected == null) {
                homeX = x
                homeY = y
                homeZoom = zoom
            }
            selectedPoint?.let { fly(AtlasCamera(it.x, it.y + 48f, 2f)) }
        } else if (selectedId == null && wasSelected != null)
            fly(AtlasCamera(homeX, homeY, homeZoom))
        wasSelected = selectedId
    }
    LaunchedEffect(land) { onDetailLevelChanged(land) }
    DisposableEffect(Unit) { onDispose { flight?.cancel() } }
    BackHandler(enabled = land) {
        if (local && selectedPoint != null) {
            returnToContinents()
        } else selectedPoint?.let { fly(AtlasCamera(it.x, it.y + 48f, 2f)) }
    }
    BoxWithConstraints(
        modifier
            .clipToBounds()
            .then(
                if (listOpen || stationOpen || regionsOpen) Modifier.clearAndSetSemantics {}
                else Modifier
            )
    ) {
        val width = maxWidth.value
        val height = maxHeight.value
        Box(
            Modifier.fillMaxSize()
                .semantics {
                    contentDescription = "Spatial atlas"
                    stateDescription =
                        "Zoom ${(zoom*100).roundToInt()} percent; camera ${x.roundToInt()}, ${y.roundToInt()}"
                }
                .pointerInput(points, selectedId, width, height, density) {
                    detectAtlasTransforms { centroid, pan, factor ->
                        flight?.cancel()
                        apply(
                            camera()
                                .transform(
                                    centroid.x / density - width / 2,
                                    centroid.y / density - height / 2,
                                    pan.x / density,
                                    pan.y / density,
                                    factor,
                                )
                                .bounded(points)
                        )
                    }
                }
        ) {
            LivingSky(
                markers,
                points,
                ::camera,
                selectedId,
                reduced || listOpen || stationOpen || regionsOpen || land,
                MaterialTheme.typography.titleMedium,
                Modifier.fillMaxSize(),
                hidden = land,
            )
            if (selectedPoint != null) {
                // Fade in a different native detail layer using the same coordinate ownership.
                Box(
                    Modifier.fillMaxSize().graphicsLayer {
                        alpha = ((zoom - 2.35f) / .45f).coerceIn(0f, 1f)
                    }
                ) {
                    AuthoredGeography(::camera, selectedPoint, region, Modifier.fillMaxSize())
                }
            }
            if (!land && selectedId == null)
                points.forEach { point ->
                    val marker = markerById.getValue(point.id)
                    Box(
                        Modifier.offset {
                                IntOffset(
                                    ((width / 2 + (point.x - x) * zoom - 72) * density)
                                        .roundToInt(),
                                    ((height / 2 + (point.y - y) * zoom - 38) * density)
                                        .roundToInt(),
                                )
                            }
                            .width(144.dp)
                            .height(112.dp)
                            .clickable { onSelect(point.id) }
                            .semantics {
                                contentDescription = "$actionLabel${marker.title}"
                                this[SemanticsProperties.Text] =
                                    listOf(marker.title, marker.detail, marker.status)
                                        .filter { it.isNotBlank() }
                                        .map { androidx.compose.ui.text.AnnotatedString(it) }
                            }
                    )
                }
            else if (land && selectedPoint != null) {
                authoredRegions
                    .filter { !local || region == null || it.suffix == region }
                    .forEach { area ->
                        Surface(
                            color = if (area.known) Cosmos.Cream else Cosmos.Deep,
                            contentColor = if (area.known) Cosmos.InkOnCream else Cosmos.Cream,
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(1.dp, Cosmos.Cream.copy(alpha = .7f)),
                            modifier =
                                Modifier.offset {
                                        val left =
                                            (width / 2 + (selectedPoint.x + area.x - x) * zoom - 66)
                                                .coerceIn(8f, (width - 140).coerceAtLeast(8f))
                                        IntOffset(
                                            (left * density).roundToInt(),
                                            ((height / 2 + (selectedPoint.y + area.y - y) * zoom -
                                                    24) * density)
                                                .roundToInt(),
                                        )
                                    }
                                    .width(132.dp)
                                    .heightIn(min = 48.dp)
                                    .clickable {
                                        enterRegion(
                                            area.suffix,
                                            selectedPoint.x + area.x,
                                            selectedPoint.y + area.y,
                                        )
                                    }
                                    .semantics {
                                        contentDescription = "Explore authored region: ${area.name}"
                                    },
                        ) {
                            Text(
                                area.name,
                                Modifier.padding(10.dp),
                                style = MaterialTheme.typography.labelLarge,
                            )
                        }
                    }
            }
        }
        FlowRow(
            Modifier.align(Alignment.TopStart).padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            FilledTonalButton(onClick = { listOpen = true }) {
                Text("$collectionLabel ${markers.size}")
            }
            if (!land) FilledTonalButton(onClick = { fly(AtlasCamera()) }) { Text("Recenter") }
            else
                FilledTonalButton(
                    onClick = {
                        region = null
                        selectedPoint?.let { fly(AtlasCamera(it.x, it.y + 48f, 2f)) }
                    }
                ) {
                    Text("‹ Orbit")
                }
            if (selectedPoint != null && !land)
                FilledTonalButton(
                    onClick = { fly(AtlasCamera(selectedPoint.x, selectedPoint.y, 3.8f)) }
                ) {
                    Text("Explore continents")
                }
            if (land) FilledTonalButton(onClick = { regionsOpen = true }) { Text("Regions") }
            if (selectedPoint == null)
                FilledTonalButton(onClick = { stationOpen = true }) { Text("Station") }
        }
        if (land)
            Surface(
                color = Cosmos.Cream,
                contentColor = Cosmos.InkOnCream,
                shape = RoundedCornerShape(18.dp),
                modifier =
                    Modifier.align(Alignment.BottomStart)
                        .padding(start = 12.dp, end = 100.dp, bottom = 12.dp)
                        .heightIn(max = 190.dp),
            ) {
                Column(
                    Modifier.verticalScroll(rememberScrollState()).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("AUTHORED GEOGRAPHY PREVIEW", style = MaterialTheme.typography.labelMedium)
                    Text(
                        if (local)
                            "${authoredRegions.firstOrNull { it.suffix==region }?.name ?: "Coast"} · local detail"
                        else "Continents & coastlines",
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Text(
                        if (local)
                            "Illustrative islets and paths. These places are authored, not inferred from your activity."
                        else
                            "Pinch closer or tap a region. Illustrative land; source-backed worlds remain unchanged.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (local)
                        TextButton(
                            onClick = { returnToContinents() },
                            colors =
                                ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                        ) {
                            Text("‹ All continents")
                        }
                }
            }
        ZoomControls(::camera, { fly(it) }, Modifier.align(Alignment.BottomEnd).padding(8.dp))
    }
    BackHandler(enabled = listOpen || stationOpen || regionsOpen) {
        listOpen = false
        stationOpen = false
        regionsOpen = false
    }
    if (listOpen || stationOpen || regionsOpen)
        PosterTheme {
            ModalBottomSheet(
                onDismissRequest = {
                    listOpen = false
                    stationOpen = false
                    regionsOpen = false
                },
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
                containerColor = Cosmos.Cream,
                contentColor = Cosmos.InkOnCream,
                shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            ) {
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = 520.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 22.dp)
                        .padding(bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        if (regionsOpen) "AUTHORED GEOGRAPHY"
                        else if (stationOpen) "THE STATION"
                        else "YOUR $collectionLabel".uppercase(),
                        style = MaterialTheme.typography.labelMedium,
                    )
                    Text(
                        if (regionsOpen) "Choose a region"
                        else if (stationOpen) "A place to pause." else collectionLabel,
                        style = MaterialTheme.typography.headlineLarge,
                    )
                    Text(
                        if (stationOpen)
                            "This station is an illustrative navigation landmark. Friends, rooms and live presence are not connected."
                        else "Choose a place. The map keeps your return position.",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    if (regionsOpen && selectedPoint != null)
                        authoredRegions.forEach { area ->
                            OutlinedButton(
                                onClick = {
                                    regionsOpen = false
                                    enterRegion(
                                        area.suffix,
                                        selectedPoint.x + area.x,
                                        selectedPoint.y + area.y,
                                    )
                                },
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            ) {
                                Text(area.name)
                            }
                        }
                    if (!stationOpen && !regionsOpen)
                        markers.forEach { marker ->
                            Surface(
                                color = Cosmos.Cream,
                                shape = RoundedCornerShape(14.dp),
                                border = BorderStroke(1.dp, Cosmos.InkOnCream),
                                modifier =
                                    Modifier.fillMaxWidth().clickable {
                                        listOpen = false
                                        onSelect(marker.id)
                                    },
                            ) {
                                Column(
                                    Modifier.padding(16.dp),
                                    verticalArrangement = Arrangement.spacedBy(5.dp),
                                ) {
                                    Text(marker.title, style = MaterialTheme.typography.titleLarge)
                                    if (marker.detail.isNotBlank())
                                        Text(
                                            marker.detail,
                                            style = MaterialTheme.typography.labelMedium,
                                        )
                                }
                            }
                        }
                    Button(
                        onClick = {
                            listOpen = false
                            stationOpen = false
                            regionsOpen = false
                        },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) {
                        Text("Close")
                    }
                }
            }
        }
}

@Composable
private fun ZoomControls(
    camera: () -> AtlasCamera,
    onCamera: (AtlasCamera) -> Unit,
    modifier: Modifier,
) {
    val percent by remember { derivedStateOf { (camera().zoom * 100).roundToInt() } }
    Surface(
        color = Cosmos.Cream,
        contentColor = Cosmos.InkOnCream,
        shape = RoundedCornerShape(18.dp),
        modifier = modifier,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            TextButton(
                onClick = {
                    val c = camera()
                    onCamera(c.copy(zoom = (c.zoom * 1.4f).coerceAtMost(12f)))
                },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.semantics { contentDescription = "Zoom in" },
            ) {
                Text("+")
            }
            Text("$percent%", style = MaterialTheme.typography.labelMedium)
            TextButton(
                onClick = {
                    val c = camera()
                    onCamera(c.copy(zoom = (c.zoom / 1.4f).coerceAtLeast(.35f)))
                },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.semantics { contentDescription = "Zoom out" },
            ) {
                Text("−")
            }
        }
    }
}
