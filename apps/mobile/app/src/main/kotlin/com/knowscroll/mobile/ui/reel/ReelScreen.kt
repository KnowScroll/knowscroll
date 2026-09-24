package com.knowscroll.mobile.ui.reel

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.BuildConfig
import com.knowscroll.mobile.R
import com.knowscroll.mobile.ui.*
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.scroll.ExplainSheet
import com.knowscroll.mobile.ui.scroll.WhyControls
import com.knowscroll.mobile.ui.theme.Cosmos
import com.knowscroll.mobile.ui.theme.Poster
import com.knowscroll.mobile.ui.theme.PosterTheme

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReelScreen(
    state: ScrollState.Reading,
    onKeep: () -> Unit,
    onReturn: () -> Unit,
    onNext: () -> Unit,
    onOpenKeep: () -> Unit,
    onVisible: () -> Unit,
    onAuthorityFailure: () -> Unit,
    onPosition: (String, Int) -> Unit,
    branches: BranchAvailability = BranchAvailability.Unavailable,
    onBranch: (EncounterBranch) -> Unit = {},
    /** #167: why a continuation could not be opened (e.g. it was withdrawn), shown until it settles. */
    branchMessage: String? = null,
    preview: Boolean = false,
    onPrevious: (() -> Unit)? = null,
    /** #167 (ADR-0043): the recorded "why" and its corrections, through the Scroll reader's own sheet.
     * The authored preview has no recorded decision, so it offers no "Why". */
    why: WhyControls = WhyControls(),
    /** #135: the resolved bearer credential for this media request (the signed-in session, or
     * the development token in a debug build). `null` sends no `Authorization` header at all --
     * the default preserves the exact previous debug behaviour for any caller that does not pass
     * one explicitly (the reader and the Authored Preview both pass the reader's credential). */
    mediaToken: String? = BuildConfig.KS_DEV_TOKEN.takeIf { it.isNotBlank() },
) {
    val media = requireNotNull(state.item.media)
    var branchHelp by rememberSaveable(state.item.assetId) { mutableStateOf(false) }
    var explain by rememberSaveable(state.item.assetId) { mutableStateOf(false) }
    var drag by remember { mutableStateOf(Offset.Zero) }
    val threshold = with(LocalDensity.current) { 72.dp.toPx() }
    val canNext = state.exposureId.isNotEmpty() && canRequestDiscovery(state.keep, state.discovery)
    BackHandler(enabled = branchHelp || explain) {
        branchHelp = false
        explain = false
    }
    PosterTheme {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val footerMax = (maxHeight * .30f).coerceIn(96.dp, 220.dp)
            Column(Modifier.fillMaxSize().background(Poster.Paper)) {
                FlowRow(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    TextButton(onClick = onReturn) { Text("‹ Return to origin") }
                    if (!preview) {
                        val whyDescription = stringResource(R.string.reel_explain_description)
                        TextButton(
                            onClick = { explain = true },
                            modifier = Modifier.semantics { contentDescription = whyDescription },
                        ) { Text(stringResource(R.string.reader_explain_action)) }
                    }
                }
                Text(
                    if (media.simulated) "TEST MEDIA · NOT GENERATED EVIDENCE"
                    else "GENERATED SYNTHESIS",
                    color = Poster.Cobalt,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
                ReelPlayer(
                    BuildConfig.KS_DEBUG_API_BASE.trimEnd('/') + media.path,
                    mediaToken?.let { mapOf("Authorization" to "Bearer $it") } ?: emptyMap(),
                    Modifier.weight(1f).fillMaxWidth(),
                    onVisible,
                    onAuthorityFailure,
                    {
                        onPosition(
                            state.item.assetId,
                            it.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
                        )
                    },
                    state.readingPosition.toLong(),
                    active = !branchHelp && !explain,
                    gestureModifier =
                        Modifier.pointerInput(state.item.assetId, canNext, branches) {
                            detectDragGestures(
                                onDragStart = { drag = Offset.Zero },
                                onDragCancel = { drag = Offset.Zero },
                                onDragEnd = {
                                    if (
                                        kotlin.math.abs(drag.x) > threshold &&
                                            kotlin.math.abs(drag.x) > kotlin.math.abs(drag.y)
                                    ) {
                                        val choices =
                                            (branches as? BranchAvailability.Ready)
                                                ?.branches
                                                .orEmpty()
                                        if (choices.isEmpty()) branchHelp = true
                                        else
                                            onBranch(
                                                if (drag.x < 0) choices.first() else choices.last()
                                            )
                                    } else if (drag.y < -threshold && canNext) onNext()
                                    else if (drag.y > threshold) onPrevious?.invoke()
                                    drag = Offset.Zero
                                },
                            ) { change, amount ->
                                change.consume()
                                drag += amount
                            }
                        },
                )
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = footerMax)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (!preview)
                            Button(
                                onClick = onKeep,
                                enabled =
                                    state.exposureId.isNotEmpty() &&
                                        state.keep !is KeepState.Kept &&
                                        state.keep !is KeepState.Saving,
                            ) {
                                Text(
                                    if (state.keep is KeepState.Kept) "Kept"
                                    else if (state.keep is KeepState.Saving) "Saving…"
                                    else "Save Relic"
                                )
                            }
                        OutlinedButton(onClick = { branchHelp = true }) { Text("Continue →") }
                        if (onPrevious != null)
                            TextButton(onClick = onPrevious) { Text("Previous ↓") }
                        TextButton(onClick = onNext, enabled = canNext) { Text("Next ↑") }
                    }
                    Text(
                        state.item.title,
                        color = Poster.Ink,
                        style = MaterialTheme.typography.titleLarge,
                        maxLines = 2,
                    )
                    Text(
                        "↑ Another discovery   ↔ Continue this idea",
                        color = Poster.Muted,
                        style = MaterialTheme.typography.labelSmall,
                    )
                    when (state.discovery) {
                        DiscoveryState.Loading ->
                            Text("Finding the next discovery…", color = Poster.Ink)
                        DiscoveryState.Failed ->
                            Text(
                                "Could not load the next discovery. Tap Next to retry.",
                                color = Cosmos.Coral,
                            )
                        DiscoveryState.Exhausted ->
                            Text("You have reached the end of this library.", color = Poster.Ink)
                        else -> Unit
                    }
                    branchMessage?.let { Text(it, color = Poster.Ink) }
                    if (state.keep is KeepState.Failed || state.keep is KeepState.Conflict)
                        Text(
                            "This Relic could not be saved. Retry keeps the same request.",
                            color = Cosmos.Coral,
                        )
                }
                if (!preview)
                    BottomCompass(CompassTab.Cable, onReturn, {}, onOpenKeep, poster = true)
            }
        }
        LaunchedEffect(explain, state.item.assetId) { if (explain) why.onOpen() }
        if (explain)
            ExplainSheet(
                state.item,
                state.origin,
                why.panel?.takeIf { it.assetId == state.item.assetId },
                why.onCorrect,
            ) {
                explain = false
            }
        if (branchHelp)
            AlertDialog(
                containerColor = com.knowscroll.mobile.ui.theme.Cosmos.Cream,
                titleContentColor = com.knowscroll.mobile.ui.theme.Cosmos.InkOnCream,
                textContentColor = com.knowscroll.mobile.ui.theme.Cosmos.InkOnCream,
                onDismissRequest = { branchHelp = false },
                title = { Text("Continue this idea") },
                text = {
                    BranchRail(
                        branches,
                        {
                            branchHelp = false
                            onBranch(it)
                        },
                    )
                },
                confirmButton = {
                    TextButton(onClick = { branchHelp = false }) { Text("Back to Reel") }
                },
            )
    }
}
