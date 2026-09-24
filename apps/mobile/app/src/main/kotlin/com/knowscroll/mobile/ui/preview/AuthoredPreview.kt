package com.knowscroll.mobile.ui.preview

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.BuildConfig
import com.knowscroll.mobile.data.*
import com.knowscroll.mobile.ui.*
import com.knowscroll.mobile.ui.reel.ReelScreen
import com.knowscroll.mobile.ui.scroll.content.*
import com.knowscroll.mobile.ui.theme.*

/**
 * Explicit owner-testable authoring sandbox. Never posts exposures, Keeps, or model events.
 * Available only in the separate debug journey package, with simulated media from its API. The
 * graph is authored here over exact selected revisions, not inferred from feed adjacency.
 */
@Composable
fun AuthoredPreview(
    authority: Universe,
    onClose: () -> Unit,
    onAuthorityFailure: () -> Unit,
    initialScroll: Int = 0,
    initialReel: String? = null,
    atlasOrigin: Boolean = false,
    /** #135 verification N4: see [AuthoredAtlas]'s `credential`. */
    credential: CredentialProvider,
) {
    val context = LocalContext.current
    if (!BuildConfig.DEBUG || !com.knowscroll.mobile.JourneyBuild.isJourney(context.packageName)) return
    var mode by rememberSaveable { mutableStateOf(if (initialReel == null) "Scroll" else "Reel") }
    var scrollId by rememberSaveable { mutableIntStateOf(initialScroll) }
    var reelId by rememberSaveable { mutableStateOf<String?>(initialReel) }
    var trail by rememberSaveable { mutableStateOf(listOf<String>()) }
    var reels by remember { mutableStateOf<List<ScrollItem>?>(null) }
    var failure by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    val places = rememberSaveableStateHolder()
    LaunchedEffect(authority.universeId, authority.privacyEpoch, reload) {
        try {
            val feed = ApiClient(credential = credential).getFeed("Reel")
            if (
                feed.universeId != authority.universeId ||
                    feed.privacyEpoch != authority.privacyEpoch
            ) {
                onClose()
                onAuthorityFailure()
                return@LaunchedEffect
            }
            reels = feed.items.filter { it.media?.simulated == true }.sortedBy { it.assetId }
            if (reelId == null)
                reelId = reels?.firstOrNull()?.let { "${it.assetId}@${it.revision}" }
            failure = false
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (invalidatesReader(e)) {
                onClose()
                onAuthorityFailure()
            } else failure = true
        }
    }
    fun back() {
        val previous = trail.lastOrNull()
        if (previous == null) onClose()
        else {
            trail = trail.dropLast(1)
            val parts = previous.split(":")
            mode = parts[0]
            if (mode == "Scroll") scrollId = parts[1].toInt() else reelId = parts[1]
        }
    }
    fun branch(target: Int) {
        val current = if (mode == "Scroll") scrollId.toString() else reelId ?: return
        val next =
            if (mode == "Scroll") target.toString()
            else reels?.getOrNull(target)?.let { "${it.assetId}@${it.revision}" } ?: return
        if (next == current || trail.size >= 24) return
        trail = trail + "$mode:$current"
        if (mode == "Scroll") scrollId = target else reelId = next
    }
    BackHandler { back() }
    PosterTheme {
        Column(Modifier.fillMaxSize().background(Poster.Paper)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                TextButton(onClick = ::back) {
                    Text(
                        if (trail.isEmpty())
                            (if (atlasOrigin) "‹ Topic origin" else "‹ Exit preview")
                        else "‹ Branch origin"
                    )
                }
                TextButton(onClick = onClose) { Text("Close preview") }
            }
            Text(
                "AUTHORED PREVIEW · NO HISTORY RECORDED",
                Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.labelMedium,
                color = Poster.Cobalt,
            )
            CableControls(mode, { mode = it })
            if (mode == "Scroll") {
                places.SaveableStateProvider("scroll:$scrollId") {
                    PreviewDocument(
                        scrollId,
                        { branch(it) },
                        {
                            scrollId = (scrollId + 1) % 3
                            trail = emptyList()
                        },
                    )
                }
            } else {
                val media = reels.orEmpty()
                val index = media.indexOfFirst { "${it.assetId}@${it.revision}" == reelId }
                if (media.isEmpty() || index < 0) {
                    Column(
                        Modifier.padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text(
                            if (failure) "The preview library could not be reached."
                            else if (reels == null) "Opening supplied videos…"
                            else if (media.isEmpty()) "No supplied test videos are available."
                            else "This preview revision is no longer in the library.",
                            style = MaterialTheme.typography.headlineMedium,
                        )
                        Text(
                            "This preview requires the guarded disposable media fixture. It does not request generation."
                        )
                        Button(onClick = { reload++ }) { Text("Retry preview library") }
                    }
                } else {
                    val item = media[index]
                    Text(
                        "SUPPLIED DEMO ${index + 1} / ${media.size}",
                        Modifier.padding(horizontal = 16.dp),
                        style = MaterialTheme.typography.labelMedium,
                    )
                    // Explicit authored comparison links. The targets are bound to this response's
                    // exact asset and revision; unrelated production feed entries never enter it.
                    val choices =
                        media.indices
                            .filter { it != index }
                            .map { target ->
                                EncounterBranch(
                                    "preview:${item.assetId}:${media[target].assetId}",
                                    item.assetId,
                                    item.revision,
                                    media[target].assetId,
                                    "Compare demo ${target + 1}",
                                    "Authored supplied-demo comparison; no source-alignment claim",
                                )
                            }
                    places.SaveableStateProvider("reel:${item.assetId}@${item.revision}") {
                        ReelScreen(
                            ScrollState.Reading(item, "preview-no-exposure", "", KeepState.Idle, 0),
                            {},
                            ::back,
                            {
                                reelId =
                                    media[(index + 1) % media.size].let {
                                        "${it.assetId}@${it.revision}"
                                    }
                                trail = emptyList()
                            },
                            onClose,
                            {},
                            {
                                onClose()
                                onAuthorityFailure()
                            },
                            { _, _ -> },
                            BranchAvailability.Ready(choices),
                            { link ->
                                branch(media.indexOfFirst { it.assetId == link.targetAssetId })
                            },
                            preview = true,
                            mediaToken = credential.currentToken(),
                            onPrevious = {
                                reelId =
                                    media[(index - 1 + media.size) % media.size].let {
                                        "${it.assetId}@${it.revision}"
                                    }
                                trail = emptyList()
                            },
                        )
                    }
                }
            }
        }
    }
}

internal val previewTitles =
    listOf(
        "Why does an orbit keep falling?",
        "What changes when speed changes?",
        "Reading a model without mistaking it for reality",
    )

internal fun previewDocument(index: Int): ScrollDocument {
    val paragraphs =
        listOf(
            "An orbit combines sideways motion with inward acceleration. In this authored example, the curved path is an illustration of that relationship. The drawing is not a measurement of your understanding or your world.",
            "Changing one quantity helps us ask a smaller question. Hold the central body fixed and compare two starting speeds. This slider is a comparison control, not an orbital simulation: its percentages describe the control position only.",
            "A useful model names its assumptions. These diagrams omit atmospheric drag, collisions and many-body effects. The map and branches were authored for interaction testing; they are not a personal inference.",
        )
    return ScrollDocument(
        buildList {
            add(ScrollBlock.Prose(paragraphs[index]))
            add(
                ScrollBlock.Image(
                    "preview:orbit",
                    "Authored orbit diagram: a body follows a curved path around a central body",
                    "Illustrative geometry · authored locally, not an observation",
                )
            )
            add(
                ScrollBlock.Citation(
                    "Read the NASA orbit reference ↗",
                    "https://science.nasa.gov/solar-system/orbits-and-keplers-laws/",
                )
            )
            add(ScrollBlock.ComparisonSlider("Compare the two illustrations", "A", "B"))
            add(
                ScrollBlock.Diagram(
                    "Follow the relationship · drag this diagram",
                    listOf(
                        "Starting position",
                        "Sideways velocity",
                        "Inward acceleration",
                        "Curved trajectory",
                        "Model assumptions",
                    ),
                )
            )
            repeat(8) { number ->
                add(
                    ScrollBlock.Heading(
                        "${number + 1}. ${listOf("Look closely", "Change one thing", "Keep the limit in view")[number % 3]}"
                    )
                )
                add(ScrollBlock.Prose(paragraphs[(index + number) % 3]))
            }
            add(ScrollBlock.Unsupported("executable code: no sandbox is available"))
        }
    )
}

@Composable
private fun PreviewDocument(index: Int, onBranch: (Int) -> Unit, onNext: () -> Unit) {
    val scroll = rememberScrollState()
    val document = remember(index) { previewDocument(index) }
    val image = remember {
        Bitmap.createBitmap(720, 360, Bitmap.Config.ARGB_8888).also { bitmap ->
            val canvas = Canvas(bitmap)
            canvas.drawColor(0xFF2C46E8.toInt())
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            paint.color = 0xFFFFFBF0.toInt()
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 4f
            canvas.drawOval(80f, 50f, 640f, 310f, paint)
            paint.style = Paint.Style.FILL
            paint.color = 0xFFFFE44D.toInt()
            canvas.drawCircle(310f, 180f, 40f, paint)
            paint.color = 0xFF14C79B.toInt()
            canvas.drawCircle(622f, 135f, 22f, paint)
        }
    }
    val branches =
        remember(index) {
            (0..2)
                .filter { it != index }
                .map { target ->
                    EncounterBranch(
                        "authored:$index:$target",
                        "preview-scroll-$index",
                        1,
                        "preview-scroll-$target",
                        if (target == 1) "Change speed →"
                        else if (target == 2) "Model limits →" else "Orbit basics →",
                        "Authored explanatory relationship, preview revision 1",
                    )
                }
        }
    Column(Modifier.fillMaxSize()) {
        Surface(
            color = Poster.Yellow,
            border = BorderStroke(2.dp, Poster.Ink),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.padding(horizontal = 16.dp),
        ) {
            BranchRail(
                BranchAvailability.Ready(branches),
                { onBranch(it.targetAssetId.last().digitToInt()) },
                Modifier.padding(10.dp),
            )
        }
        Column(
            Modifier.weight(1f)
                .verticalScroll(scroll)
                .semantics {
                    contentDescription = "Preview Scroll reading"
                    stateDescription = "Position ${scroll.value}"
                }
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Text(
                previewTitles[index],
                style = MaterialTheme.typography.headlineLarge,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                "Read vertically. Branch with the yellow rail; sliders and diagrams keep their own gestures.",
                style = MaterialTheme.typography.bodyMedium,
            )
            ScrollBlocks(document, imageLoader = { if (it == "preview:orbit") image else null })
            HorizontalDivider(color = Poster.Ink, thickness = 2.dp)
            Text("End of this Scroll", style = MaterialTheme.typography.titleLarge)
            Text(
                "The next discovery is a separate document. Your reading gesture never turns the page."
            )
            Button(onClick = onNext, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                Text("Next preview discovery ↑")
            }
        }
    }
}
