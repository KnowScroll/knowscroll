package com.knowscroll.mobile.ui.system

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.ui.common.rememberReducedMotion
import com.knowscroll.mobile.ui.theme.Cosmos
import com.knowscroll.mobile.ui.theme.PosterTheme
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class AtlasMarker(
    val id: String,
    val title: String,
    val detail: String = "",
    val status: String = "",
)

/** Authored links only. Live world membership never grants topic/revision authority. */
data class AtlasTopic(
    val id: String,
    val planet: String,
    val region: String,
    val title: String,
    val kind: String,
    val truth: String,
    val source: String,
    val x: Float,
    val y: Float,
)

/** Explicit levels own their return camera. Pinch never chooses an unrelated nearest body. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SpatialAtlas(
    markers: List<AtlasMarker>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    collectionLabel: String = "Worlds",
    actionLabel: String = "Explore world: ",
    onDetailLevelChanged: (Boolean) -> Unit = {},
    onDeselect: () -> Unit = {},
    onInspect: (() -> Unit)? = null,
    topics: List<AtlasTopic> = emptyList(),
    onOpenTopic: (AtlasTopic) -> Unit = {},
) {
    val points = remember(markers) { atlasLayout(markers.map { it.id }) }
    val point = points.firstOrNull { it.id == selectedId }
    var x by rememberSaveable { mutableFloatStateOf(0f) }
    var y by rememberSaveable { mutableFloatStateOf(0f) }
    var zoom by rememberSaveable { mutableFloatStateOf(.86f) }
    var arrived by rememberSaveable { mutableStateOf(false) }
    var home by rememberSaveable { mutableStateOf(listOf(0f, 0f, .86f)) }
    var planetHome by rememberSaveable { mutableStateOf(listOf(0f, 0f, 2.6f)) }
    var continentHome by rememberSaveable { mutableStateOf(listOf(0f, 0f, 3.8f)) }
    var priorSelection by rememberSaveable { mutableStateOf<String?>(null) }
    var level by rememberSaveable { mutableStateOf("system") }
    var region by rememberSaveable { mutableStateOf<String?>(null) }
    var topicId by rememberSaveable { mutableStateOf<String?>(null) }
    var sheet by rememberSaveable { mutableStateOf<String?>(null) }
    var shipX by rememberSaveable { mutableFloatStateOf(25f) }
    var shipY by rememberSaveable { mutableFloatStateOf(-20f) }
    var shipHeading by rememberSaveable { mutableFloatStateOf(-25f) }
    var travelling by remember { mutableStateOf(false) }
    var returningHome by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var flight by remember { mutableStateOf<Job?>(null) }
    val reduced = rememberReducedMotion()
    val density = LocalDensity.current.density
    val visiblePoints by remember(points) { derivedStateOf { separatedPoints(points, zoom) } }
    val stationShown by
        remember(points) { derivedStateOf { stationVisible(separatedPoints(points, zoom), zoom) } }
    val land = level == "continents" || level == "region"
    val geographyAlpha =
        animateFloatAsState(
            if (land) 1f else 0f,
            tween(if (reduced) 0 else 380),
            label = "globe to map",
        )
    val currentTopic =
        topics.firstOrNull { it.id == topicId && it.planet == selectedId && it.region == region }
    fun camera() = AtlasCamera(x, y, zoom)
    fun apply(c: AtlasCamera) {
        x = c.x
        y = c.y
        zoom = c.zoom
    }
    fun stop() {
        flight?.cancel()
        travelling = false
        returningHome = false
    }
    fun fly(target: AtlasCamera, destination: AtlasPoint? = null, returning: Boolean = false) {
        stop()
        val start = camera()
        val sx = shipX
        val sy = shipY
        val tx = destination?.let { it.x + 55f } ?: sx
        val ty = destination?.let { it.y - 15f } ?: sy
        if (destination != null)
            shipHeading = (kotlin.math.atan2(ty - sy, tx - sx) * 180f / kotlin.math.PI).toFloat()
        if (reduced) {
            apply(target)
            shipX = tx
            shipY = ty
            return
        }
        travelling = destination != null
        returningHome = returning
        flight =
            scope.launch {
                try {
                    Animatable(0f).animateTo(1f, tween(if (destination != null) 720 else 380)) {
                        val t = value
                        // Ship moves first; camera approach follows without a forced input lock.
                        val c = if (destination != null) ((t - .18f) / .82f).coerceIn(0f, 1f) else t
                        apply(
                            AtlasCamera(
                                start.x + (target.x - start.x) * c,
                                start.y + (target.y - start.y) * c,
                                start.zoom + (target.zoom - start.zoom) * c,
                            )
                        )
                        shipX = sx + (tx - sx) * t
                        shipY = sy + (ty - sy) * t - kotlin.math.sin(t * Math.PI).toFloat() * 18f
                    }
                } finally {
                    // A cancelled older flight must not clear its replacement's state.
                    if (kotlinx.coroutines.currentCoroutineContext().isActive) {
                        travelling = false
                        returningHome = false
                    }
                }
            }
    }
    fun planet(gesture: Boolean = false) {
        point?.let {
            level = "planet"
            region = null
            topicId = null
            if (!gesture) fly(AtlasCamera(it.x, it.y, 2.6f))
        }
    }
    fun continents(gesture: Boolean = false) {
        if (level == "planet") planetHome = listOf(x, y, zoom)
        point?.let {
            level = "continents"
            region = null
            topicId = null
            if (!gesture) fly(AtlasCamera(it.x, it.y, 2.15f))
        }
    }
    fun enterRegion(area: AuthoredRegion, gesture: Boolean = false) {
        val p = point ?: return
        if (level != "region") continentHome = listOf(x, y, zoom)
        level = "region"
        region = area.suffix
        topicId = null
        if (!gesture) fly(AtlasCamera(p.x + area.x, p.y + area.y, 5.4f))
    }
    fun back() {
        when {
            sheet != null -> sheet = null
            topicId != null -> topicId = null
            level == "region" -> {
                level = "continents"
                region = null
                fly(AtlasCamera(continentHome[0], continentHome[1], continentHome[2]))
            }
            level == "continents" -> {
                level = "planet"
                region = null
                fly(AtlasCamera(planetHome[0], planetHome[1], planetHome[2]))
            }
            selectedId != null -> {
                stop()
                level = "system"
                onDeselect()
            }
        }
    }
    LaunchedEffect(Unit) {
        if (!arrived && selectedId == null) {
            arrived = true
            if (!reduced) {
                apply(camera().copy(zoom = .68f))
                fly(AtlasCamera(0f, 0f, .86f))
            }
        }
    }
    LaunchedEffect(selectedId, points) {
        if (selectedId != null && point == null) {
            onDeselect()
            return@LaunchedEffect
        }
        if (selectedId != priorSelection) {
            topicId = null
            region = null
            if (selectedId != null && point != null) {
                if (priorSelection == null && !returningHome) home = listOf(x, y, zoom)
                level = "planet"
                fly(AtlasCamera(point.x, point.y, 2.6f), point)
            } else if (priorSelection != null) {
                level = "system"
                fly(AtlasCamera(home[0], home[1], home[2]), returning = true)
            }
            priorSelection = selectedId
        }
    }
    LaunchedEffect(land) { onDetailLevelChanged(land) }
    DisposableEffect(Unit) { onDispose { flight?.cancel() } }
    BackHandler(selectedId != null || sheet != null) { back() }
    BoxWithConstraints(
        modifier
            .clipToBounds()
            .then(if (sheet != null) Modifier.clearAndSetSemantics {} else Modifier)
    ) {
        val width = maxWidth.value
        val height = maxHeight.value
        fun position(px: Float, py: Float, half: Float = 24f) =
            Modifier.offset {
                IntOffset(
                    ((width / 2 + (px - x) * zoom - half) * density).roundToInt(),
                    ((height / 2 + (py - y) * zoom - half) * density).roundToInt(),
                )
            }
        Box(
            Modifier.fillMaxSize()
                .semantics {
                    contentDescription = "Spatial atlas"
                    stateDescription =
                        "$level; ${region.orEmpty()}; ${topicId.orEmpty()}; Zoom ${(zoom*100).roundToInt()} percent; camera ${x.roundToInt()}, ${y.roundToInt()}"
                }
                .pointerInput(points, selectedId, width, height, density) {
                    detectAtlasTransforms { focus, pan, factor ->
                        stop()
                        val next =
                            camera()
                                .transform(
                                    focus.x / density - width / 2,
                                    focus.y / density - height / 2,
                                    pan.x / density,
                                    pan.y / density,
                                    factor,
                                )
                                .bounded(points)
                        apply(next)
                        // Hysteresis is level-local. A focused selected planet owns deeper zoom.
                        if (level == "planet" && next.zoom > 3.3f && point != null)
                            continents(gesture = true)
                        else if (level == "continents" && next.zoom < 1.3f) planet(gesture = true)
                        else if (level == "continents" && next.zoom > 3.5f && point != null) {
                            val wx = next.x + (focus.x / density - width / 2) / next.zoom - point.x
                            val wy = next.y + (focus.y / density - height / 2) / next.zoom - point.y
                            authoredRegions
                                .firstOrNull {
                                    (it.x - wx) * (it.x - wx) + (it.y - wy) * (it.y - wy) <
                                        32f * 32f
                                }
                                ?.let { enterRegion(it, gesture = true) }
                        } else if (level == "region" && next.zoom < 3f) {
                            level = "continents"
                            region = null
                            topicId = null
                        }
                    }
                }
        ) {
            LivingSky(
                markers,
                points,
                ::camera,
                selectedId,
                reduced || sheet != null || land,
                MaterialTheme.typography.labelLarge,
                Modifier.fillMaxSize().graphicsLayer { alpha = 1f - geographyAlpha.value },
                hidden = false,
                ship = { Offset(shipX, shipY) },
                travelling = { travelling },
                heading = { shipHeading },
            )
            if (point != null)
                Box(Modifier.fillMaxSize().graphicsLayer { alpha = geographyAlpha.value }) {
                    AuthoredGeography(::camera, point, region, Modifier.fillMaxSize())
                }
            if (!land && selectedId == null) {
                // Hit areas use the same deterministic collision policy as the renderer.
                visiblePoints.forEach { p ->
                    val marker = markers.first { it.id == p.id }
                    Box(
                        position(p.x, p.y)
                            .size(48.dp)
                            .clickable { onSelect(p.id) }
                            .semantics {
                                contentDescription = "$actionLabel${marker.title}"
                                this[SemanticsProperties.Text] =
                                    listOf(marker.title, marker.detail, marker.status)
                                        .filter { it.isNotBlank() }
                                        .map { androidx.compose.ui.text.AnnotatedString(it) }
                            }
                    )
                }
                if (stationShown)
                    Box(
                        position(98f, 0f)
                            .size(48.dp)
                            .clickable { sheet = "Station" }
                            .semantics { contentDescription = "Station" }
                    )
            } else if (!land && point != null) {
                Box(
                    position(point.x, point.y, 150f)
                        .size(300.dp)
                        .clickable { continents() }
                        .semantics {
                            contentDescription =
                                "Enter continents on ${markers.firstOrNull { it.id==selectedId }?.title}"
                        }
                )
            } else if (level == "continents" && point != null) {
                authoredRegions.forEach { area ->
                    Surface(
                        modifier =
                            position(point.x + area.x, point.y + area.y, 52f)
                                .width(104.dp)
                                .heightIn(min = 48.dp)
                                .clickable { enterRegion(area) }
                                .semantics {
                                    contentDescription = "Explore authored region: ${area.name}"
                                },
                        color = Cosmos.Cream.copy(alpha = .94f),
                        contentColor = Cosmos.InkOnCream,
                        shape = RoundedCornerShape(16.dp),
                    ) {
                        Text(
                            area.name,
                            Modifier.padding(8.dp),
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
            } else if (level == "region" && point != null) {
                topics
                    .filter { it.planet == selectedId && it.region == region }
                    .forEach { topic ->
                        Surface(
                            modifier =
                                position(point.x + topic.x, point.y + topic.y)
                                    .size(48.dp)
                                    .clickable { topicId = topic.id }
                                    .semantics { contentDescription = "Topic: ${topic.title}" },
                            shape = CircleShape,
                            color = Cosmos.Cream.copy(alpha = .9f),
                            border = BorderStroke(2.dp, Cosmos.InkOnCream),
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Text(
                                    if (topic.kind == "Reel") "▶" else "✦",
                                    color = Cosmos.InkOnCream,
                                )
                            }
                        }
                    }
            }
        }
        Row(
            Modifier.align(Alignment.TopStart).padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (selectedId != null)
                TextButton(
                    onClick = ::back,
                    colors =
                        ButtonDefaults.textButtonColors(
                            containerColor = Cosmos.Cream,
                            contentColor = Cosmos.InkOnCream,
                        ),
                    modifier =
                        Modifier.size(48.dp).semantics {
                            contentDescription =
                                if (level == "planet") "Close world detail and return to the system"
                                else "Back one atlas level"
                        },
                ) {
                    Text("‹")
                }
            Surface(
                color = Cosmos.Cream,
                contentColor = Cosmos.InkOnCream,
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier.weight(1f, false),
            ) {
                Text(
                    when (level) {
                        "planet" -> markers.firstOrNull { it.id == selectedId }?.title.orEmpty()
                        "continents" -> "Continents & coastlines"
                        "region" ->
                            "${authoredRegions.firstOrNull { it.suffix==region }?.name} · local detail"
                        else -> "$collectionLabel ${markers.size}"
                    },
                    Modifier.clickable { sheet = if (land) "Regions" else "Worlds" }
                        .heightIn(min = 48.dp)
                        .padding(12.dp),
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            TextButton(
                onClick = { sheet = "Worlds" },
                colors =
                    ButtonDefaults.textButtonColors(
                        containerColor = Cosmos.Dark.copy(alpha = .8f),
                        contentColor = Cosmos.Cream,
                    ),
            ) {
                Text("List")
            }
            if (selectedId != null && onInspect != null)
                TextButton(
                    onClick = onInspect,
                    colors =
                        ButtonDefaults.textButtonColors(
                            containerColor = Cosmos.Dark.copy(alpha = .8f),
                            contentColor = Cosmos.Cream,
                        ),
                ) {
                    Text("Info")
                }
        }
        if (currentTopic != null)
            PosterTheme {
                Surface(
                    Modifier.align(Alignment.BottomCenter)
                        .padding(12.dp)
                        .fillMaxWidth()
                        .heightIn(max = 280.dp),
                    shape = RoundedCornerShape(22.dp),
                    color = Cosmos.Cream,
                    contentColor = Cosmos.InkOnCream,
                ) {
                    Column(
                        Modifier.verticalScroll(rememberScrollState()).padding(18.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            "${currentTopic.kind.uppercase()} · AUTHORED TOPIC",
                            style = MaterialTheme.typography.labelMedium,
                        )
                        Text(currentTopic.title, style = MaterialTheme.typography.titleLarge)
                        Text(currentTopic.truth, style = MaterialTheme.typography.labelMedium)
                        Text(currentTopic.source, style = MaterialTheme.typography.bodySmall)
                        Row {
                            Button(onClick = { onOpenTopic(currentTopic) }) { Text("Open") }
                            TextButton(onClick = { topicId = null }) { Text("Close") }
                        }
                    }
                }
            }
        else {
            Text(
                when {
                    land -> "AUTHORED GEOGRAPHY · tap a region or topic"
                    selectedId != null -> "Tap the planet or pinch closer"
                    else -> "Tap a planet · the ship flies there"
                },
                Modifier.align(Alignment.BottomStart)
                    .padding(start = 16.dp, end = 72.dp, bottom = 16.dp),
                color = Cosmos.Cream,
                style = MaterialTheme.typography.labelSmall,
            )
            Column(Modifier.align(Alignment.BottomEnd).padding(8.dp)) {
                Surface(
                    shape = RoundedCornerShape(18.dp),
                    color = Cosmos.Cream,
                    contentColor = Cosmos.InkOnCream,
                ) {
                    Column {
                        TextButton(
                            onClick = {
                                when {
                                    level == "planet" -> continents()
                                    level == "continents" -> sheet = "Regions"
                                    else ->
                                        fly(camera().copy(zoom = (zoom * 1.3f).coerceAtMost(12f)))
                                }
                            },
                            colors =
                                ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                            modifier =
                                Modifier.size(48.dp).semantics { contentDescription = "Zoom in" },
                        ) {
                            Text("+")
                        }
                        TextButton(
                            onClick = { if (selectedId != null) back() else fly(AtlasCamera()) },
                            colors =
                                ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                            modifier =
                                Modifier.size(48.dp).semantics { contentDescription = "Zoom out" },
                        ) {
                            Text("−")
                        }
                    }
                }
            }
        }
    }
    if (sheet != null)
        PosterTheme {
            ModalBottomSheet(
                onDismissRequest = { sheet = null },
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
                containerColor = Cosmos.Cream,
            ) {
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = 520.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(22.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        if (sheet == "Regions") "Choose a region"
                        else if (sheet == "Station") "A place to pause."
                        else "YOUR ${collectionLabel.uppercase()}",
                        style = MaterialTheme.typography.titleLarge,
                    )
                    if (sheet == "Station")
                        Text(
                            "This station is an illustrative navigation landmark. Friends, rooms and live presence are not connected."
                        )
                    else if (sheet == "Regions")
                        authoredRegions.forEach { area ->
                            OutlinedButton(
                                onClick = {
                                    sheet = null
                                    enterRegion(area)
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(area.name)
                            }
                        }
                    else
                        markers.forEach { marker ->
                            OutlinedButton(
                                onClick = {
                                    sheet = null
                                    onSelect(marker.id)
                                },
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            ) {
                                Column {
                                    Text(marker.title)
                                    if (marker.detail.isNotEmpty())
                                        Text(
                                            marker.detail,
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                }
                            }
                        }
                    if (sheet == "Worlds")
                        TextButton(onClick = { sheet = "Station" }) { Text("Station") }
                    if (selectedId != null && !land)
                        TextButton(
                            onClick = {
                                sheet = null
                                continents()
                            }
                        ) {
                            Text("Explore continents")
                        }
                    if (land && topics.isEmpty())
                        Text(
                            "Illustrative geography. Open the authored Atlas from the universe for mapped topics and content."
                        )
                    TextButton(onClick = { sheet = null }) { Text("Close") }
                }
            }
        }
}
