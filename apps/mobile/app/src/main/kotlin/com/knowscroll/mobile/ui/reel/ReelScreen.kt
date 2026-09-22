package com.knowscroll.mobile.ui.reel

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.BuildConfig
import com.knowscroll.mobile.ui.*
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.scroll.SourceSheet
import com.knowscroll.mobile.ui.theme.Cosmos

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
) {
    val media = requireNotNull(state.item.media)
    var sources by rememberSaveable(state.item.assetId) { mutableStateOf(false) }
    var branchHelp by rememberSaveable(state.item.assetId) { mutableStateOf(false) }
    var drag by remember { mutableStateOf(Offset.Zero) }
    val threshold = with(LocalDensity.current) { 72.dp.toPx() }
    val canNext = state.exposureId.isNotEmpty() && canRequestDiscovery(state.keep, state.discovery)
    BackHandler(enabled = sources || branchHelp) {
        sources = false
        branchHelp = false
    }
    Column(Modifier.fillMaxSize().background(Cosmos.Dark)) {
        FlowRow(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            TextButton(onClick = onReturn) { Text("‹ Return to origin") }
            TextButton(onClick = { sources = true }) { Text("Sources & truth") }
        }
        Text(
            if (media.simulated) "TEST MEDIA · NOT GENERATED EVIDENCE" else "GENERATED SYNTHESIS",
            color = Cosmos.Teal,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        ReelPlayer(
            BuildConfig.KS_DEBUG_API_BASE.trimEnd('/') + media.path,
            mapOf("Authorization" to "Bearer ${BuildConfig.KS_DEV_TOKEN}"),
            Modifier.weight(1f).fillMaxWidth(),
            onVisible,
            onAuthorityFailure,
            { onPosition(state.item.assetId, it.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()) },
            state.readingPosition.toLong(),
            active = !sources && !branchHelp,
            gestureModifier =
                Modifier.pointerInput(state.item.assetId, canNext) {
                    detectDragGestures(
                        onDragStart = { drag = Offset.Zero },
                        onDragCancel = { drag = Offset.Zero },
                        onDragEnd = {
                            if (
                                kotlin.math.abs(drag.x) > threshold &&
                                    kotlin.math.abs(drag.x) > kotlin.math.abs(drag.y)
                            )
                                branchHelp = true
                            else if (drag.y < -threshold && canNext) onNext()
                            drag = Offset.Zero
                        },
                    ) { change, amount ->
                        change.consume()
                        drag += amount
                    }
                },
        )
        Column(
            Modifier.fillMaxWidth().heightIn(max=220.dp).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                state.item.title,
                color = Cosmos.Cream,
                style = MaterialTheme.typography.titleLarge,
                maxLines = 2,
            )
            Text(
                "↑ Another discovery   ↔ Continue this idea",
                color = Cosmos.MutedOnDark,
                style = MaterialTheme.typography.labelSmall,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onKeep,
                    enabled =
                        state.exposureId.isNotEmpty() &&
                            state.keep !is KeepState.Kept &&
                            state.keep !is KeepState.Saving,
                ) {
                    Text(
                        if (state.keep is KeepState.Kept) "Kept"
                        else if (state.keep is KeepState.Saving) "Saving…" else "Save Relic"
                    )
                }
                OutlinedButton(onClick = { branchHelp = true }) { Text("Continue →") }
                TextButton(onClick = onNext, enabled = canNext) { Text("Next ↑") }
            }
            when (state.discovery) {
                DiscoveryState.Loading -> Text("Finding the next discovery…", color = Cosmos.Cream)
                DiscoveryState.Failed ->
                    Text(
                        "Could not load the next discovery. Tap Next to retry.",
                        color = Cosmos.Coral,
                    )
                DiscoveryState.Exhausted ->
                    Text("You have reached the end of this library.", color = Cosmos.Cream)
                else -> Unit
            }
            if (state.keep is KeepState.Failed || state.keep is KeepState.Conflict)
                Text(
                    "This Relic could not be saved. Retry keeps the same request.",
                    color = Cosmos.Coral,
                )
        }
        BottomCompass(CompassTab.Cable, onReturn, {}, onOpenKeep)
    }
    if (sources) SourceSheet(state.item) { sources = false }
    if (branchHelp)
        AlertDialog(
            onDismissRequest = { branchHelp = false },
            title = { Text("Continue this idea") },
            text = { BranchRail() },
            confirmButton = {
                TextButton(onClick = { branchHelp = false }) { Text("Back to Reel") }
            },
        )
}
