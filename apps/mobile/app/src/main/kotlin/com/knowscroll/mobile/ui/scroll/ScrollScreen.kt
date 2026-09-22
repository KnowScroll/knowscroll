package com.knowscroll.mobile.ui.scroll

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ScrollState as FoundationScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ReaderOrigin
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.canRequestDiscovery
import com.knowscroll.mobile.ui.explainOriginText
import com.knowscroll.mobile.ui.explainReasonText
import com.knowscroll.mobile.ui.explainShowsSourcesNote
import com.knowscroll.mobile.ui.NO_REASON_RECORDED
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.common.rememberReducedMotion
import com.knowscroll.mobile.ui.theme.Poster
import com.knowscroll.mobile.ui.theme.PosterTheme
import com.knowscroll.mobile.ui.theme.Cosmos
import com.knowscroll.mobile.ui.theme.TruthPill
import com.knowscroll.mobile.ui.truthStateMeaning
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged

@Composable
fun ScrollScreen(
    state: ScrollState,
    onKeep: () -> Unit,
    onReturn: () -> Unit,
    onNext: () -> Unit,
    onRetry: () -> Unit,
    onReadingPosition: (String, Int) -> Unit,
    onOpenKeep: () -> Unit,
    modifier: Modifier = Modifier,
    mode: String = "Scroll"
) {
    PosterTheme { Column(modifier.fillMaxSize().background(Poster.Paper)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (state) {
                is ScrollState.Reading -> key(state.item.assetId) {
                    ReadingSheet(state, onKeep, onReturn, onNext, onReadingPosition)
                }
                is ScrollState.Unavailable -> RestScreen(false, state.message, onReturn, onRetry, state.retryable, mode)
                is ScrollState.Exhausted -> RestScreen(true, null, onReturn, onRetry, mode = mode)
                else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp)
                }
            }
        }
        // docs/product/ui-system.md section 4b/5b / BottomCompassRedTest: the compass is the
        // phone's primary navigation and is present on every screen, not just the universe --
        // "Cable" is the current entry here; its own tap is a no-op since it is already the
        // active screen. Tapping Keep leaves the reader for the real kept-Traces destination.
        BottomCompass(selected = CompassTab.Cable, onSelectAtlas = onReturn, onSelectCable = {}, onSelectKeep = onOpenKeep, poster = true)
    }
    }
}

@Composable
private fun RestScreen(exhausted: Boolean, message: String?, onReturn: () -> Unit, onRetry: () -> Unit, retryable:Boolean=true, mode: String = "Scroll") {
    val homeDescription = stringResource(R.string.reader_home_description)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
        Text(stringResource(R.string.reader_origin), style = MaterialTheme.typography.labelMedium, color = Poster.Muted)
        Spacer(Modifier.height(24.dp))
        Text(
            if (exhausted) "A quiet place to stop" else "This $mode is unavailable.",
            style = MaterialTheme.typography.headlineLarge, color = Poster.Ink
        )
        Text(message ?: "No more $mode encounters are available in this library. Switch mode, return to the Atlas, or check again later.", color = Poster.Muted)
        OutlinedButton(onClick = onRetry, enabled=retryable, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(if (exhausted) R.string.reader_check_library else R.string.action_retry))
        }
        OutlinedButton(
            onClick = onReturn,
            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = homeDescription }
        ) { Text(stringResource(R.string.action_home)) }
    }
}

@Composable
private fun ReadingSheet(
    state: ScrollState.Reading,
    onKeep: () -> Unit,
    onReturn: () -> Unit,
    onNext: () -> Unit,
    onReadingPosition: (String, Int) -> Unit
) {
    val contentLabel = stringResource(R.string.reader_content_description)
    val item = state.item
    val originLabel = stringResource(
        if (state.origin is com.knowscroll.mobile.ui.ReaderOrigin.SavedTrace) R.string.reader_saved_trace_origin
        else R.string.reader_origin
    )
    val readingScroll = rememberScrollState(state.readingPosition)
    val positionDescription = stringResource(R.string.reader_position_description, readingScroll.value)
    var sourcesOpen by rememberSaveable { mutableStateOf(false) }
    var explainOpen by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(item.assetId, readingScroll) {
        snapshotFlow { readingScroll.value }.distinctUntilChanged().collectLatest {
            delay(200)
            onReadingPosition(item.assetId, it)
        }
    }
    DisposableEffect(item.assetId, readingScroll) {
        onDispose { onReadingPosition(item.assetId, readingScroll.value) }
    }
    BackHandler(enabled = sourcesOpen || explainOpen) { sourcesOpen = false; explainOpen = false }

    Column(Modifier.fillMaxSize()) {
        // docs/product/ui-system.md section 5b: "origin chip (`● in Machine learning ›`)" -- a
        // cream pill on the space ground, not a plain label.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Surface(
                color = Cosmos.Cream.copy(alpha = 0.94f), contentColor = Cosmos.InkOnCream,
                shape = RoundedCornerShape(percent = 50)
            ) {
                Row(
                    Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Box(Modifier.size(6.dp).background(Cosmos.Teal, androidx.compose.foundation.shape.CircleShape))
                    Text(originLabel, fontWeight = androidx.compose.ui.text.font.FontWeight(800), fontSize = 12.5.sp)
                }
            }
            // Audit A2 (#72): the 150dp gradient placeholder that used to repeat the title is
            // gone. The cream reading sheet below now begins directly under the origin chip, so
            // the *thin* progress bar the spec asks for has been moved up here as a sliver at
            // the top of the column, hugging the canvas edge -- it still reflects the real
            // reading position via the same readingScroll state, never a clock-driven animation,
            // and it does not duplicate the title.
            ReadingProgressSliver(readingScroll, modifier = Modifier.weight(1f))
        }
        // Audit A2 (#72): the previous typographic `Stage` block was a 150dp gradient placeholder
        // repeating the title above the cream reading sheet. Removed: the Scroll's stage *is* its
        // reading content (audit D2 / ui-system.md section 5b table). The cream sheet below now
        // begins directly under the origin chip, with the title, truth pill and progress visible
        // there -- the same reading surface, never a duplicated heading row. Source / Explain
        // sheets, kept reading position (readingScroll, the LaunchedEffect/DisposableEffect that
        // debounce it), and exposure recording (AppViewModel.onVisible) all continue to mount.
        Surface(
            color = Poster.Paper, contentColor = Poster.Ink,
            shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp),
            modifier = Modifier.weight(1f).fillMaxWidth()
        ) {
            Column(Modifier.fillMaxSize()) {
                Column(
                    Modifier.weight(1f).fillMaxWidth().verticalScroll(readingScroll)
                        .semantics {
                            contentDescription = contentLabel
                            stateDescription = positionDescription
                        }.padding(horizontal = 24.dp, vertical = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp)
                ) {
                    // docs/product/ui-system.md section 5b: the reader's state pill carries the
                    // real truth state and real source count -- `DOCUMENTED · 3 SOURCES`. This
                    // client's ScrollItem carries exactly one source, so the count is always 1;
                    // real, not a placeholder.
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TruthPill(item.truthState, stringResource(R.string.reader_truth_label, item.truthState.uppercase()))
                        Text(
                            stringResource(R.string.reader_state_pill_sources, 1),
                            style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream
                        )
                    }
                    Text(item.title, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
                    if (item.reason.isNotBlank()) Text(item.reason, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
                    Text(item.summary, style = MaterialTheme.typography.titleMedium, color = Cosmos.MutedOnCream)
                    val document = remember(item.assetId, item.revision, item.body) {
                        com.knowscroll.mobile.ui.scroll.content.ScrollDocument.fromBody(item.body)
                    }
                    com.knowscroll.mobile.ui.scroll.content.ScrollBlocks(document)
                    com.knowscroll.mobile.ui.BranchRail()
                    HorizontalDivider(color = Cosmos.CreamDim)
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.reader_source_marker), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                        Text(item.sourceTitle, style = MaterialTheme.typography.bodyMedium)
                        Text(stringResource(R.string.reader_attribution_note), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
                    }
                    DiscoveryThreshold(state.keep, state.discovery, onNext)
                }
                ReaderControls(state.keep, state.discovery, onKeep, onReturn, { sourcesOpen = true }) { explainOpen = true }
            }
        }
    }
    if (sourcesOpen) SourceSheet(item) { sourcesOpen = false }
    if (explainOpen) ExplainSheet(item, state.origin) { explainOpen = false }
}

/**
 * Audit A2 (#72): the previous 150dp `Stage` block carried a thin progress bar. Removed along
 * with the rest of that stage; the bar is now a sliver beside the origin chip, driven by the same
 * real reading position. Reduced motion collapses the tween to a single frame.
 */
@Composable
private fun ReadingProgressSliver(readingScroll: FoundationScrollState, modifier: Modifier = Modifier) {
    val reducedMotion = rememberReducedMotion()
    val maxValue = readingScroll.maxValue.coerceAtLeast(1)
    val rawProgress = readingScroll.value.toFloat() / maxValue.toFloat()
    val progress by animateFloatAsState(
        targetValue = rawProgress.coerceIn(0f, 1f),
        animationSpec = tween(durationMillis = if (reducedMotion) 0 else 300),
        label = "reading-progress"
    )
    LinearProgressIndicator(
        progress = { progress },
        color = Cosmos.Yellow,
        trackColor = Cosmos.Cream.copy(alpha = 0.18f),
        modifier = modifier.heightIn(min = 3.dp)
    )
}
@Composable
private fun DiscoveryThreshold(keep: KeepState, state: DiscoveryState, onNext: () -> Unit) {
    val nextDescription = stringResource(R.string.reader_next_description)
    Surface(color = Cosmos.CreamDim, contentColor = Cosmos.InkOnCream, shape = RoundedCornerShape(20.dp)) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                stringResource(if (state is DiscoveryState.Exhausted) R.string.reader_library_end else R.string.reader_threshold_title),
                style = MaterialTheme.typography.titleLarge
            )
            Text(
                stringResource(when (state) {
                    DiscoveryState.Failed -> R.string.reader_next_failed
                    DiscoveryState.Exhausted -> R.string.reader_library_end_detail
                    else -> R.string.reader_threshold_detail
                }),
                style = MaterialTheme.typography.bodyMedium,
                color = if (state is DiscoveryState.Failed) Cosmos.InkOnCream else Cosmos.MutedOnCream
            )
            if (state is DiscoveryState.Loading) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Cosmos.Dark, strokeWidth = 2.dp)
                    Text(stringResource(R.string.reader_next_loading), style = MaterialTheme.typography.bodyMedium)
                }
            }
            // docs/product/ui-system.md section 5b: "keep going →" (teal) -- the deliberate-next
            // action pill. "Not so fast" (coral) is not drawn: section 5b's own table says no
            // contract exists for it.
            Button(
                onClick = onNext,
                enabled = canRequestDiscovery(keep, state),
                colors = ButtonDefaults.buttonColors(containerColor = Poster.Cobalt, contentColor = Cosmos.Dark),
                shape = RoundedCornerShape(percent = 50),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .semantics { contentDescription = nextDescription }
            ) {
                Text(stringResource(when (state) {
                    DiscoveryState.Failed -> R.string.reader_next_retry
                    DiscoveryState.Exhausted -> R.string.reader_check_library
                    else -> R.string.action_next_pill
                }))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReaderControls(
    keep: KeepState, discovery: DiscoveryState, onKeep: () -> Unit, onReturn: () -> Unit,
    onSources: () -> Unit, onExplain: () -> Unit
) {
    val homeDescription = stringResource(R.string.reader_home_description)
    val keepDescription = stringResource(R.string.reader_keep_description)
    val sourcesDescription = stringResource(R.string.reader_sources_description)
    val explainDescription = stringResource(R.string.reader_explain_description)
    val keepLabel = stringResource(when (keep) {
        is KeepState.Kept -> R.string.action_kept
        is KeepState.Saving -> R.string.reader_keep_pending
        else -> R.string.action_keep
    })
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (keep is KeepState.Failed || keep is KeepState.Conflict) Text(
            if (keep is KeepState.Failed) keep.message else (keep as KeepState.Conflict).message,
            color = Cosmos.InkOnCream, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 12.dp)
        )
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            TextButton(
                onClick = onReturn,
                modifier = Modifier.widthIn(min = 72.dp).heightIn(min = 48.dp).semantics { contentDescription = homeDescription },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream)
            ) { Text(stringResource(R.string.action_home)) }
            // docs/product/ui-system.md section 5b: "Keep this" (yellow).
            Button(
                onClick = onKeep,
                enabled = keep !is KeepState.Saving && keep !is KeepState.Kept && discovery !is DiscoveryState.Loading,
                modifier = Modifier.widthIn(min = 72.dp).heightIn(min = 48.dp).semantics { contentDescription = keepDescription },
                shape = RoundedCornerShape(percent = 50),
                colors = ButtonDefaults.buttonColors(containerColor = Poster.Yellow, contentColor = Cosmos.InkOnCream)
            ) { Text(keepLabel) }
            TextButton(
                onClick = onSources,
                modifier = Modifier.widthIn(min = 72.dp).heightIn(min = 48.dp).semantics { contentDescription = sourcesDescription },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream)
            ) { Text(stringResource(R.string.action_sources)) }
            TextButton(
                onClick = onExplain,
                modifier = Modifier.widthIn(min = 72.dp).heightIn(min = 48.dp).semantics { contentDescription = explainDescription },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream)
            ) { Text(stringResource(R.string.reader_explain_action)) }
        }
    }
}

/** "Why this appeared" (#91): only fields the API actually returned — the verbatim
 * reason, the truth state's fixed meaning, and the reader's own discovery/saved-Trace
 * origin. No interest, learning or hidden profile is shown or implied. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ExplainSheet(item: ScrollItem, origin: ReaderOrigin, onDismiss: () -> Unit) {
    val closeDescription = stringResource(R.string.reader_explain_close_description)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Cosmos.Cream, contentColor = Cosmos.InkOnCream
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                stringResource(R.string.reader_explain_sheet_title),
                style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() }
            )
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(R.string.reader_explain_reason_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                Text(explainReasonText(item.reason) ?: NO_REASON_RECORDED, style = MaterialTheme.typography.bodyLarge)
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(R.string.reader_explain_truth_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                Text(item.truthState.uppercase(), style = MaterialTheme.typography.titleMedium)
                truthStateMeaning(item.truthState)?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                if (explainShowsSourcesNote(item.truthState)) {
                    Text(stringResource(R.string.reader_explain_documented_sources_note), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(R.string.reader_explain_origin_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                Text(explainOriginText(origin), style = MaterialTheme.typography.bodyMedium)
            }
            OutlinedButton(
                onClick = onDismiss,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = closeDescription }
            ) { Text(stringResource(R.string.reader_explain_close)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SourceSheet(item: ScrollItem, onDismiss: () -> Unit) {
    val openDescription = stringResource(R.string.reader_open_source_description, item.sourceTitle)
    val closeDescription = stringResource(R.string.reader_close_sources_description)
    val context = LocalContext.current
    var browserUnavailable by remember { mutableStateOf(false) }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Cosmos.Cream, contentColor = Cosmos.InkOnCream
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(stringResource(R.string.reader_source_sheet_title), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
            Text(item.title, style = MaterialTheme.typography.titleMedium)
            Text("${item.kind.uppercase()} · ${item.truthState.uppercase()}", style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
            Text(item.sourceTitle, style = MaterialTheme.typography.titleLarge)
            Text(item.sourceUrl, style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.reader_attribution_note), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
            Button(
                onClick = {
                    browserUnavailable = runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(item.sourceUrl)))
                    }.isFailure
                },
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Dark, contentColor = Cosmos.Cream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .semantics { contentDescription = openDescription }
            ) { Text(stringResource(R.string.action_open_source)) }
            if (browserUnavailable) Text(stringResource(R.string.reader_browser_unavailable), color = Cosmos.InkOnCream)
            OutlinedButton(
                onClick = onDismiss,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = closeDescription }
            ) { Text(stringResource(R.string.reader_close_sources)) }
        }
    }
}
