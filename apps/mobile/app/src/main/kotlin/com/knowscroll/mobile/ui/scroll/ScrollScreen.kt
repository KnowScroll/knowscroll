package com.knowscroll.mobile.ui.scroll

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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import com.knowscroll.mobile.ui.why.WhyAvailability
import com.knowscroll.mobile.ui.why.WhyPanel
import com.knowscroll.mobile.ui.why.correctionLabel
import com.knowscroll.mobile.ui.why.whyStepText
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
import com.knowscroll.mobile.ui.noReasonRecorded
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
import kotlinx.coroutines.flow.first

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
    mode: String = "Scroll",
    branches: com.knowscroll.mobile.ui.branch.BranchPanel? = null,
    onOpenBranch: (String) -> Unit = {},
    onRetryBranches: () -> Unit = {},
    onObjectConnection: (String, String) -> Unit = { _, _ -> },
    /** System-Back semantics: from a Scroll opened by a connection, return to its origin. */
    onBack: () -> Unit = onReturn,
    /** #133: the recorded "why" and the reader's corrections, loaded when the sheet opens. */
    why: WhyControls = WhyControls(),
    /** #132: the Ask/answer panel, opened only when the reader taps "Ask". */
    ask: AskControls = AskControls(),
    /** #165: the Scroll's passages the reader may keep, opened only when they tap "Passages". */
    passages: PassagesControls = PassagesControls(),
) {
    PosterTheme { Column(modifier.fillMaxSize().background(Poster.Paper)) {
        // #97 root cause: explainOpen/connectionsOpen used to be rememberSaveable
        // *inside* ReadingSheet, which the `when` below removes from composition whenever `state`
        // isn't Reading. AppViewModel.onForeground() runs reconcilePrivacy(restoreStoredScroll =
        // true) on every Lifecycle.State.STARTED re-entry -- including the one right after an
        // Activity recreation, since KnowScrollApp's repeatOnLifecycle(STARTED) restarts fresh on
        // every onStart -- which briefly sets `scroll` to ScrollState.Loading and then restores a
        // *fresh* Reading for the same assetId from the persisted store. That is a second mount of
        // ReadingSheet inside the same live composition (no new Activity, no Bundle involved the
        // second time), and Compose's SaveableStateRegistry only lets a Bundle-restored value be
        // consumed once: the flags' first mount (right after the real recreation) already consumed
        // the restored `true`, so the second mount moments later fell back to the plain `false`
        // default. Hoisting the flags here, above the `when`, keeps them alive across that
        // same-item reload; keying them on the Scroll (which only changes when the reader
        // shows a genuinely different item) preserves the existing behavior of closing the sheets
        // when the reader moves on.
        // Saved state itself: after process death the screen first composes without a Scroll
        // (a new ViewModel starts in Loading), and the flags must still belong to the same Scroll.
        // The key is derived, never written during composition: the Scroll on screen, or while it
        // reloads, the last one shown (remembered after each commit).
        var stickyAssetId by rememberSaveable { mutableStateOf<String?>(null) }
        val readingId = (state as? ScrollState.Reading)?.item?.assetId
        // Only a reload carries the sheets over; an unavailable or exhausted reader closes them.
        val sheetKey = readingId ?: stickyAssetId.takeIf { state is ScrollState.Loading }
        SideEffect { if (readingId != null) stickyAssetId = readingId }
        var explainOpen by rememberSaveable(sheetKey) { mutableStateOf(false) }
        var connectionsOpen by rememberSaveable(sheetKey) { mutableStateOf(false) }
        var askOpen by rememberSaveable(sheetKey) { mutableStateOf(false) }
        var passagesOpen by rememberSaveable(sheetKey) { mutableStateOf(false) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (state) {
                is ScrollState.Reading -> key(state.item.assetId) {
                    ReadingSheet(
                        state, onKeep, onReturn, onNext, onReadingPosition,
                        branches?.takeIf { it.assetId == state.item.assetId }, onOpenBranch, onRetryBranches, onObjectConnection, onBack,
                        explainOpen, { explainOpen = it }, connectionsOpen, { connectionsOpen = it },
                        askOpen, { askOpen = it },
                        why.copy(panel = why.panel?.takeIf { it.assetId == state.item.assetId }),
                        ask.copy(panel = ask.panel?.takeIf { it.assetId == state.item.assetId }),
                        passagesOpen, { passagesOpen = it }, passages,
                    )
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
    onReadingPosition: (String, Int) -> Unit,
    branches: com.knowscroll.mobile.ui.branch.BranchPanel?,
    onOpenBranch: (String) -> Unit,
    onRetryBranches: () -> Unit,
    onObjectConnection: (String, String) -> Unit,
    onBack: () -> Unit,
    explainOpen: Boolean,
    onExplainOpenChange: (Boolean) -> Unit,
    connectionsOpen: Boolean,
    onConnectionsOpenChange: (Boolean) -> Unit,
    askOpen: Boolean,
    onAskOpenChange: (Boolean) -> Unit,
    why: WhyControls,
    ask: AskControls,
    passagesOpen: Boolean,
    onPassagesOpenChange: (Boolean) -> Unit,
    passages: PassagesControls,
) {
    val contentLabel = stringResource(R.string.reader_content_description)
    val item = state.item
    val originLabel = stringResource(
        when (state.origin) {
            is com.knowscroll.mobile.ui.ReaderOrigin.SavedTrace -> R.string.reader_saved_trace_origin
            is com.knowscroll.mobile.ui.ReaderOrigin.Branch -> R.string.reader_branch_origin
            else -> R.string.reader_origin
        }
    )
    val readingScroll = rememberScrollState(state.readingPosition)
    // #131: content below the body (live continuations) arrives after first layout, so the
    // document can be briefly shorter than the saved position. ScrollState clamps to that shorter
    // maximum; without this guard the clamped value was written back as the reading position and
    // exact return/restoration silently lost the reader's place. Hold the saved position until the
    // document can contain it (bounded), and give way at once if the reader scrolls first.
    val savedPosition = state.readingPosition
    var restoringPosition by remember(item.assetId) { mutableStateOf(savedPosition > 0) }
    LaunchedEffect(item.assetId, savedPosition) {
        if (!restoringPosition) return@LaunchedEffect
        kotlinx.coroutines.withTimeoutOrNull(3_000) {
            snapshotFlow { readingScroll.isScrollInProgress to readingScroll.maxValue }
                .first { (scrolling, max) -> scrolling || documentCanHold(max, savedPosition) }
        }
        if (!readingScroll.isScrollInProgress && readingScroll.value != savedPosition && documentCanHold(readingScroll.maxValue, savedPosition)) {
            readingScroll.scrollTo(savedPosition)
        }
        restoringPosition = false
    }
    val positionDescription = stringResource(R.string.reader_position_description, readingScroll.value)
    // #97: explainOpen/connectionsOpen/askOpen/passagesOpen are owned by ScrollScreen (see the
    // comment there) so they survive a same-item Loading/Reading remount; they are threaded through here.
    LaunchedEffect(item.assetId, readingScroll) {
        snapshotFlow { readingScroll.value to restoringPosition }.distinctUntilChanged().collectLatest { (value, restoring) ->
            if (restoring) return@collectLatest
            delay(200)
            onReadingPosition(item.assetId, value)
        }
    }
    val latestRestoring = rememberUpdatedState(restoringPosition)
    DisposableEffect(item.assetId, readingScroll) {
        onDispose { onReadingPosition(item.assetId, if (latestRestoring.value) savedPosition else readingScroll.value) }
    }
    BackHandler(enabled = explainOpen || connectionsOpen || askOpen || passagesOpen) {
        onExplainOpenChange(false); onConnectionsOpenChange(false); onPassagesOpenChange(false)
        if (askOpen) { onAskOpenChange(false); ask.onClose() }
    }

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
            // #131: a Scroll opened by a connection shows where it came from, and one tap returns
            // there at the exact reading position (the same path as system Back).
            (state.origin as? com.knowscroll.mobile.ui.ReaderOrigin.Branch)?.let { origin ->
                val backLabel = stringResource(R.string.reader_branch_back, origin.fromTitle)
                TextButton(
                    onClick = onBack,
                    colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = backLabel },
                ) { Text("← ${origin.fromTitle}", maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, fontSize = 12.5.sp) }
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
        // there -- the same reading surface, never a duplicated heading row. The reader's
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
                    // real truth state. #161: readers never see a source, so it carries no count.
                    TruthPill(item.truthState, stringResource(R.string.reader_truth_label, item.truthState.uppercase()))
                    Text(item.title, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
                    if (item.reason.isNotBlank()) Text(item.reason, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
                    Text(item.summary, style = MaterialTheme.typography.titleMedium, color = Cosmos.MutedOnCream)
                    val document = remember(item.assetId, item.revision, item.body) {
                        com.knowscroll.mobile.ui.scroll.content.ScrollDocument.fromBody(item.body)
                    }
                    com.knowscroll.mobile.ui.scroll.content.ScrollBlocks(document)
                    BranchSection(branches, { onOpenBranch(it.id) }, onRetryBranches) { onConnectionsOpenChange(true) }
                    HorizontalDivider(color = Cosmos.CreamDim)
                    DiscoveryThreshold(state.keep, state.discovery, onNext)
                }
                ReaderControls(state.keep, state.discovery, onKeep, onReturn, { onExplainOpenChange(true) }, { onAskOpenChange(true) }) { onPassagesOpenChange(true) }
            }
        }
    }
    LaunchedEffect(explainOpen, item.assetId) { if (explainOpen) why.onOpen() }
    if (explainOpen) ExplainSheet(item, state.origin, why.panel, why.onCorrect) { onExplainOpenChange(false) }
    if (connectionsOpen) {
        val live = branches?.branches.orEmpty()
        if (live.isEmpty()) onConnectionsOpenChange(false)
        else ConnectionSheet(
            live,
            { onConnectionsOpenChange(false); onOpenBranch(it) },
            { bridge, objection -> onConnectionsOpenChange(false); onObjectConnection(bridge, objection) },
        ) { onConnectionsOpenChange(false) }
    }
    LaunchedEffect(askOpen, item.assetId) { if (askOpen) ask.onOpen() }
    if (askOpen) AskSheet(ask) { onAskOpenChange(false); ask.onClose() }
    LaunchedEffect(passagesOpen, item.assetId) { if (passagesOpen) passages.onOpen(item.assetId) }
    if (passagesOpen) PassagesSheet(item, passages) { onPassagesOpenChange(false) }
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
    onExplain: () -> Unit, onAsk: () -> Unit, onPassages: () -> Unit,
) {
    val homeDescription = stringResource(R.string.reader_home_description)
    val keepDescription = stringResource(R.string.reader_keep_description)
    val explainDescription = stringResource(R.string.reader_explain_description)
    val askDescription = stringResource(R.string.reader_ask_description)
    val passagesDescription = stringResource(R.string.reader_passages_description)
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
                onClick = onExplain,
                modifier = Modifier.widthIn(min = 72.dp).heightIn(min = 48.dp).semantics { contentDescription = explainDescription },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream)
            ) { Text(stringResource(R.string.reader_explain_action)) }
            TextButton(
                onClick = onAsk,
                modifier = Modifier.widthIn(min = 72.dp).heightIn(min = 48.dp).semantics { contentDescription = askDescription },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream)
            ) { Text(stringResource(R.string.ask_action)) }
            // #165: the Scroll's passages, each of which the reader may keep as a Relic.
            TextButton(
                onClick = onPassages,
                modifier = Modifier.widthIn(min = 72.dp).heightIn(min = 48.dp).semantics { contentDescription = passagesDescription },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream)
            ) { Text(stringResource(R.string.reader_passages_action)) }
        }
    }
}

/** "Why this appeared" (#91): only fields the API actually returned — the verbatim
 * reason, the truth state's fixed meaning, and the reader's own discovery/saved-Trace
 * origin. No interest, learning or hidden profile is shown or implied. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ExplainSheet(item: ScrollItem, origin: ReaderOrigin, why: WhyPanel?, onCorrect: (String) -> Unit, onDismiss: () -> Unit) {
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
                Text(explainReasonText(item.reason) ?: noReasonRecorded(item.kind), style = MaterialTheme.typography.bodyLarge)
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(R.string.reader_explain_truth_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                Text(item.truthState.uppercase(), style = MaterialTheme.typography.titleMedium)
                truthStateMeaning(item.truthState)?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(R.string.reader_explain_origin_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                Text(explainOriginText(origin, item.kind), style = MaterialTheme.typography.bodyMedium)
            }
            if (why != null) WhySection(why, onCorrect)
            OutlinedButton(
                onClick = onDismiss,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = closeDescription }
            ) { Text(stringResource(R.string.reader_explain_close)) }
        }
    }
}

/** ScrollState reports `Int.MAX_VALUE` until its first layout, which is not a measured document. */
internal fun documentCanHold(maxValue: Int, position: Int): Boolean = maxValue != Int.MAX_VALUE && maxValue >= position

/** #133: the why sheet's recorded inputs, grouped so the reader's parameters stay readable. */
data class WhyControls(val panel: WhyPanel? = null, val onOpen: () -> Unit = {}, val onCorrect: (String) -> Unit = {})

/** "What led here": the recorded evidence path, and the corrections this encounter supports. */
@Composable
private fun WhySection(why: WhyPanel, onCorrect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(R.string.reader_why_path_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
        when (val availability = why.availability) {
            WhyAvailability.Loading -> Text(stringResource(R.string.reader_why_loading), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
            WhyAvailability.Unrecorded -> Text(stringResource(R.string.reader_why_unrecorded), style = MaterialTheme.typography.bodyMedium)
            WhyAvailability.Failed -> Text(stringResource(R.string.reader_why_failed), style = MaterialTheme.typography.bodyMedium)
            is WhyAvailability.Ready -> {
                val steps = availability.why.steps
                if (steps.isEmpty()) Text(stringResource(R.string.reader_why_no_path), style = MaterialTheme.typography.bodyMedium)
                steps.forEach { Text("\u00b7 ${whyStepText(it)}", style = MaterialTheme.typography.bodyMedium) }
                val offered = availability.why.corrections.filter { it !in why.corrected }
                if (offered.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    offered.forEach { kind ->
                        OutlinedButton(
                            onClick = { onCorrect(kind) }, enabled = why.sending == null,
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text(correctionLabel(kind)) }
                    }
                }
            }
        }
        why.message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
    }
}
