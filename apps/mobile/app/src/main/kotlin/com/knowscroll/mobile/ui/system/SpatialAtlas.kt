package com.knowscroll.mobile.ui.system

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.ui.common.WorldGlobe
import com.knowscroll.mobile.ui.common.rememberReducedMotion
import com.knowscroll.mobile.ui.theme.Cosmos
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

data class AtlasMarker(
    val id: String,
    val title: String,
    val detail: String = "",
    val status: String = "",
)

/**
 * One map stays mounted while inspection changes scale. Controls and labels remain screen-sized.
 */
@Composable
fun SpatialAtlas(
    markers: List<AtlasMarker>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    collectionLabel: String = "Worlds",
    actionLabel: String = "Explore world: ",
) {
    val points = remember(markers.map { it.id }) { atlasLayout(markers.map { it.id }) }
    val markersById = remember(markers) { markers.associateBy { it.id } }
    var x by rememberSaveable { mutableFloatStateOf(0f) }
    var y by rememberSaveable { mutableFloatStateOf(0f) }
    var zoom by rememberSaveable { mutableFloatStateOf(1f) }
    var homeX by rememberSaveable { mutableFloatStateOf(0f) }
    var homeY by rememberSaveable { mutableFloatStateOf(0f) }
    var homeZoom by rememberSaveable { mutableFloatStateOf(1f) }
    var wasSelected by rememberSaveable { mutableStateOf<String?>(null) }
    var listOpen by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var flight by remember { mutableStateOf<Job?>(null) }
    val reduced = rememberReducedMotion()
    val density = LocalDensity.current.density
    fun apply(camera: AtlasCamera) {
        x = camera.x
        y = camera.y
        zoom = camera.zoom
    }
    fun fly(target: AtlasCamera) {
        flight?.cancel()
        if (reduced) {
            apply(target)
            return
        }
        val start = AtlasCamera(x, y, zoom)
        flight =
            scope.launch {
                Animatable(0f).animateTo(1f, spring(dampingRatio = .9f, stiffness = 340f)) {
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
    LaunchedEffect(selectedId) {
        if (selectedId != null && selectedId != wasSelected) {
            if (wasSelected == null) {
                homeX = x
                homeY = y
                homeZoom = zoom
            }
            points
                .firstOrNull { it.id == selectedId }
                ?.let { fly(AtlasCamera(it.x, it.y + 80f, 2f)) }
        } else if (selectedId == null && wasSelected != null)
            fly(AtlasCamera(homeX, homeY, homeZoom))
        wasSelected = selectedId
    }
    // Rotation/reconciliation must never leave an animation updating a discarded map.
    DisposableEffect(Unit) { onDispose { flight?.cancel() } }
    BoxWithConstraints(
        modifier
            .clipToBounds()
            .then(
                if (selectedId != null || listOpen) Modifier.clearAndSetSemantics {} else Modifier
            )
    ) {
        val width = maxWidth.value
        val height = maxHeight.value
        Box(
            Modifier.fillMaxSize()
                .semantics {
                    contentDescription = "Spatial atlas"
                    stateDescription =
                        "Zoom ${ (zoom * 100).roundToInt() } percent; camera ${x.roundToInt()}, ${y.roundToInt()}"
                    customActions =
                        listOf(
                            CustomAccessibilityAction("Recenter atlas") {
                                fly(AtlasCamera())
                                true
                            },
                            CustomAccessibilityAction("Zoom in") {
                                fly(AtlasCamera(x, y, (zoom * 1.4f).coerceAtMost(3.2f)))
                                true
                            },
                            CustomAccessibilityAction("Zoom out") {
                                fly(AtlasCamera(x, y, (zoom / 1.4f).coerceAtLeast(.35f)))
                                true
                            },
                        )
                }
                .pointerInput(points, selectedId, width, height, density) {
                    detectAtlasTransforms { centroid, pan, factor ->
                        flight?.cancel()
                        apply(
                            AtlasCamera(x, y, zoom)
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
            Canvas(Modifier.fillMaxSize()) {
                val origin =
                    Offset(
                        size.width / 2 - x * zoom * density,
                        size.height / 2 - y * zoom * density,
                    )
                // Decorative survey rings explicitly carry no relationship or growth semantics.
                for (r in listOf(130f, 260f, 390f)) drawCircle(
                    Cosmos.Teal.copy(alpha = .09f),
                    r * zoom * density,
                    origin,
                    style = Stroke(1.dp.toPx()),
                )
                drawLine(
                    Cosmos.Cream.copy(alpha = .15f),
                    origin - Offset(7.dp.toPx(), 0f),
                    origin + Offset(7.dp.toPx(), 0f),
                )
                drawLine(
                    Cosmos.Cream.copy(alpha = .15f),
                    origin - Offset(0f, 7.dp.toPx()),
                    origin + Offset(0f, 7.dp.toPx()),
                )
            }
            points.forEachIndexed { index, point ->
                val world = markersById.getValue(point.id)
                val sx = width / 2 + (point.x - x) * zoom
                val sy = height / 2 + (point.y - y) * zoom
                val diameter = (78f * zoom).coerceIn(42f, 200f)
                if (sx > -90 && sx < width + 90 && sy > -110 && sy < height + 110) {
                    Column(
                        Modifier.offset {
                                IntOffset(
                                    ((sx - 76) * density).roundToInt(),
                                    ((sy - diameter / 2) * density).roundToInt(),
                                )
                            }
                            .width(152.dp)
                            .clickable { onSelect(world.id) }
                            .semantics { contentDescription = "$actionLabel${world.title}" },
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        WorldGlobe(Modifier.size(diameter.dp), index)
                        if (zoom >= .65f && selectedId != world.id)
                            Text(
                                world.title,
                                color = Cosmos.Cream,
                                style = MaterialTheme.typography.labelLarge,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center,
                            )
                        if (zoom >= .65f && selectedId != world.id && world.detail.isNotBlank())
                            Text(
                                world.detail,
                                color = Cosmos.MutedOnDark,
                                style = MaterialTheme.typography.labelSmall,
                                textAlign = TextAlign.Center,
                            )
                        if (zoom >= .65f && selectedId != world.id && world.status.isNotBlank())
                            Text(
                                world.status,
                                color = Cosmos.Teal2,
                                style = MaterialTheme.typography.labelSmall,
                                textAlign = TextAlign.Center,
                            )
                    }
                }
            }
        }
        Row(
            Modifier.align(Alignment.TopStart).padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            FilledTonalButton(onClick = { listOpen = true }) {
                Text("$collectionLabel ${markers.size}")
            }
            FilledTonalButton(onClick = { fly(AtlasCamera()) }) { Text("Recenter") }
        }
        Row(
            Modifier.align(Alignment.BottomEnd).padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FilledTonalButton(
                onClick = { fly(AtlasCamera(x, y, (zoom / 1.4f).coerceAtLeast(.35f))) },
                modifier = Modifier.semantics { contentDescription = "Zoom out" },
            ) {
                Text("−")
            }
            Text(
                "${(zoom*100).roundToInt()}%",
                color = Cosmos.MutedOnDark,
                modifier = Modifier.padding(8.dp),
            )
            FilledTonalButton(
                onClick = { fly(AtlasCamera(x, y, (zoom * 1.4f).coerceAtMost(3.2f))) },
                modifier = Modifier.semantics { contentDescription = "Zoom in" },
            ) {
                Text("+")
            }
        }
    }
    BackHandler(enabled = listOpen) { listOpen = false }
    if (listOpen)
        AlertDialog(
            onDismissRequest = { listOpen = false },
            title = { Text(collectionLabel) },
            text = {
                Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState())) {
                    markers.forEach { world ->
                        TextButton(
                            onClick = {
                                listOpen = false
                                onSelect(world.id)
                            }
                        ) {
                            Text(world.title)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { listOpen = false }) { Text("Close") } },
        )
}
