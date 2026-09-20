package com.knowscroll.mobile.ui.universe

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.Trace
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.HistoryClearState
import com.knowscroll.mobile.ui.SignOutState
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.math.max
import kotlin.math.min

/**
 * docs/product/ui-system.md section 5b/5c: Cosmos supplies the frame (a canvas of floating pills
 * and bodies, never a document with a header); Living Observatory supplies the experience (the
 * stage is chosen by what the reader has actually done, and its honest first-visit state -- no
 * topics, generic truthful placeholder bodies, a yellow call to action -- needs no invented data).
 *
 * Only the **universe** level is built. System, planet and interior all need semantic geography
 * this client has no data for (section 5b's own table); building them would be exactly the
 * "pretty map of nothing" the spec warns against.
 */
@Composable
fun UniverseScreen(
    state: UniverseState,
    historyClear: HistoryClearState,
    signOut: SignOutState,
    onEnterScroll: () -> Unit,
    onOpenTrace: (Trace) -> Unit,
    onRetry: () -> Unit,
    onRequestHistoryClear: () -> Unit,
    onCancelHistoryClear: () -> Unit,
    onConfirmHistoryClear: () -> Unit,
    onRetryHistoryClear: () -> Unit,
    onRequestSignOut: () -> Unit,
    onCancelSignOut: () -> Unit,
    onConfirmSignOut: () -> Unit,
    onRetrySignOut: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when (state) {
                    is UniverseState.Loading -> Column(
                        Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp)
                    ) {
                        Text(stringResource(R.string.universe_kicker), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.universe_loading), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                        }
                    }
                    is UniverseState.Unavailable -> Column(
                        Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(stringResource(R.string.universe_kicker), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
                        Text(stringResource(R.string.universe_unavailable), style = MaterialTheme.typography.titleLarge, color = Cosmos.Coral)
                        Text(stringResource(R.string.universe_unavailable_help), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                        Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                        OutlinedButton(
                            onClick = onRetry,
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Retry loading the universe" }
                        ) { Text(stringResource(R.string.action_retry)) }
                    }
                    is UniverseState.Loaded -> UniverseCanvasScreen(
                        universe = state.universe,
                        historyClear = historyClear,
                        signOut = signOut,
                        onEnterScroll = onEnterScroll,
                        onOpenTrace = onOpenTrace,
                        onRequestHistoryClear = onRequestHistoryClear,
                        onRetryHistoryClear = onRetryHistoryClear,
                        onRequestSignOut = onRequestSignOut,
                        onRetrySignOut = onRetrySignOut
                    )
                }
            }
            BottomCompass(selected = CompassTab.Home, onSelectHome = {}, onSelectScroll = onEnterScroll)
        }
        if (historyClear is HistoryClearState.Confirming) ClearHistoryConfirmation(
            onCancel = onCancelHistoryClear, onConfirm = onConfirmHistoryClear
        )
        if (signOut is SignOutState.Confirming) SignOutConfirmation(
            onCancel = onCancelSignOut, onConfirm = onConfirmSignOut
        )
    }
}

/** The real age of the universe, in days, from the earliest kept Trace -- the only creation-like
 * timestamp this client has (the universe itself carries no createdAt). Null when there is nothing
 * kept yet, rather than a fabricated "day 0". */
private fun universeAgeDays(traces: List<Trace>): Int? {
    val earliest = traces.mapNotNull { runCatching { Instant.parse(it.createdAt) }.getOrNull() }.minOrNull()
        ?: return null
    return max(0, ChronoUnit.DAYS.between(earliest, Instant.now()).toInt()) + 1
}

@Composable
private fun UniverseCanvasScreen(
    universe: Universe,
    historyClear: HistoryClearState,
    signOut: SignOutState,
    onEnterScroll: () -> Unit,
    onOpenTrace: (Trace) -> Unit,
    onRequestHistoryClear: () -> Unit,
    onRetryHistoryClear: () -> Unit,
    onRequestSignOut: () -> Unit,
    onRetrySignOut: () -> Unit
) {
    val hasRead = universe.traces.isNotEmpty()
    val ageDays = universeAgeDays(universe.traces)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
            Column {
                Text(stringResource(R.string.universe_kicker), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
                Text(stringResource(R.string.universe_title), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            }
            if (ageDays != null) StatusPill(stringResource(R.string.universe_day_pill, ageDays))
        }
        Text(
            stringResource(if (hasRead) R.string.universe_heading_started else R.string.universe_heading_first),
            style = MaterialTheme.typography.displayLarge, color = Cosmos.InkOnDark
        )
        Text(
            stringResource(if (hasRead) R.string.universe_subtitle_started else R.string.universe_subtitle_first),
            style = MaterialTheme.typography.bodyLarge, color = Cosmos.MutedOnDark
        )
        if (hasRead) YellowNote(stringResource(R.string.universe_kept_note, universe.traces.size))

        UniverseCanvas(traces = universe.traces, onOpenTrace = onOpenTrace)

        Text(
            stringResource(if (hasRead) R.string.universe_hint_started else R.string.universe_hint_first),
            style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark
        )

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(
                onClick = onEnterScroll,
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Yellow, contentColor = Cosmos.InkOnCream),
                shape = RoundedCornerShape(percent = 50),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Enter Scroll" }
            ) {
                Text(
                    stringResource(if (hasRead) R.string.universe_cta_started else R.string.universe_cta_first),
                    fontWeight = FontWeight(800), fontSize = 13.sp
                )
            }
            Text(
                stringResource(if (hasRead) R.string.universe_cta_started_helper else R.string.universe_cta_first_helper),
                style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark
            )
        }

        if (universe.traces.isNotEmpty()) {
            Text(stringResource(R.string.traces_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                universe.traces.forEach { trace ->
                    val traceDescription = stringResource(R.string.trace_revisit_action, trace.eventId)
                    Surface(
                        color = Cosmos.SpaceRaised,
                        contentColor = Cosmos.InkOnDark,
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth()
                            .clickable { onOpenTrace(trace) }
                            .semantics { contentDescription = traceDescription }
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Box(modifier = Modifier.size(8.dp).background(Cosmos.Yellow, CircleShape))
                            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(
                                    trace.title.ifBlank { stringResource(R.string.trace_unknown_title) },
                                    style = MaterialTheme.typography.titleMedium, color = Cosmos.InkOnDark
                                )
                                Text(trace.createdAt, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(4.dp))
        PrivacyControls(historyClear, onRequestHistoryClear, onRetryHistoryClear)
        SignOutControls(signOut, onRequestSignOut, onRetrySignOut)
    }
}

/** docs/product/ui-system.md section 5b: "Status pill (`.pillbtn`, top-right)" -- cream on ink,
 * fully-rounded. Carries the real `DAY n` age, never a decoration. */
@Composable
private fun StatusPill(label: String) {
    Surface(
        color = Cosmos.Cream.copy(alpha = 0.94f), contentColor = Cosmos.InkOnCream,
        shape = RoundedCornerShape(percent = 50)
    ) {
        Text(
            label, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            fontWeight = FontWeight(800), fontSize = 12.5.sp
        )
    }
}

/** docs/product/ui-system.md section 5c: "a yellow left-ruled note". Deviation: its content is
 * whichever real fact this screen has (see `universe_kept_note`), not a fabricated reason -- the
 * real why-this-appeared reason lives on a Scroll (in the reader), not on a kept Trace. */
@Composable
private fun YellowNote(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(3.dp).height(18.dp).background(Cosmos.Yellow))
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Yellow, fontWeight = FontWeight.SemiBold)
    }
}

/**
 * The universe canvas (ui-system.md section 5b "screen is a canvas", 5c "bodies on a star
 * ground"): one real body per kept Trace, labelled with its real title, plus an honest unexplored
 * region when there is nothing (or nothing more) recorded. Zoom is a real control over this real
 * canvas (section 5c: "Zoom controls are real controls over a real canvas, not decoration");
 * drag-to-pan is not implemented (deviation -- section 4b marks the full drag-and-pinch canvas as
 * requiring semantic geography this client does not have; a stepped zoom is the honest subset).
 */
@Composable
private fun UniverseCanvas(traces: List<Trace>, onOpenTrace: (Trace) -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    val canvasDescription = stringResource(R.string.universe_canvas_description)
    BoxWithConstraints(
        Modifier.fillMaxWidth().height(340.dp).clip(RoundedCornerShape(22.dp))
            .background(Cosmos.SpaceRaised.copy(alpha = 0.55f))
            .semantics { contentDescription = canvasDescription }
    ) {
        val w = maxWidth
        val h = maxHeight
        Box(Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale)) {
            if (traces.isEmpty()) {
                DustBody(Modifier.offset(x = w * 0.16f, y = h * 0.24f), stringResource(R.string.universe_body_angle))
                RealBody(
                    Modifier.offset(x = w * 0.5f - 28.dp, y = h * 0.5f - 28.dp),
                    title = stringResource(R.string.universe_body_possibility),
                    subLabel = stringResource(R.string.universe_body_possibility_helper),
                    onClick = null
                )
                DustBody(Modifier.offset(x = w * 0.6f, y = h * 0.26f), stringResource(R.string.universe_body_surprise))
            } else {
                traces.forEachIndexed { index, trace ->
                    val fx = 0.14f + ((index * 0.61803398875f) % 0.62f)
                    val fy = 0.16f + ((index * 0.38196601125f) % 0.54f)
                    RealBody(
                        Modifier.offset(x = w * fx, y = h * fy),
                        title = trace.title.ifBlank { stringResource(R.string.trace_unknown_title) },
                        subLabel = null,
                        onClick = { onOpenTrace(trace) }
                    )
                }
                DustCluster(Modifier.offset(x = w * 0.5f, y = h * 0.16f))
            }
        }
        Row(
            Modifier.align(Alignment.BottomStart).padding(10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            val zoomOutDescription = stringResource(R.string.universe_zoom_out)
            val zoomInDescription = stringResource(R.string.universe_zoom_in)
            val recenterDescription = stringResource(R.string.universe_recenter)
            ZoomButton("−", zoomOutDescription) { scale = max(0.7f, scale - 0.15f) }
            ZoomButton("+", zoomInDescription) { scale = min(1.6f, scale + 0.15f) }
            ZoomButton("⊙", recenterDescription) { scale = 1f }
            Text(
                stringResource(R.string.universe_view_label),
                style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark,
                modifier = Modifier.padding(start = 4.dp)
            )
        }
        if (traces.isNotEmpty()) Legend(Modifier.align(Alignment.TopEnd).padding(10.dp))
    }
}

@Composable
private fun ZoomButton(glyph: String, description: String, onClick: () -> Unit) {
    Surface(
        color = Cosmos.Cream.copy(alpha = 0.9f), contentColor = Cosmos.InkOnCream,
        shape = CircleShape,
        modifier = Modifier.size(32.dp).clickable(onClickLabel = description, onClick = onClick)
            .semantics { contentDescription = description }
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(glyph, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        }
    }
}

@Composable
private fun Legend(modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.End) {
        LegendRow(Cosmos.Yellow, stringResource(R.string.universe_legend_kept))
        LegendRow(Cosmos.MutedOnDark, stringResource(R.string.universe_legend_unread))
    }
}

@Composable
private fun LegendRow(dot: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(6.dp).background(dot, CircleShape))
        Text(label, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
    }
}

/** A real body: a kept Trace, or (empty state only) a truthful generic placeholder -- never an
 * invented topic. Positioned by an explicit pixel offset computed once from the canvas size, so
 * it never jumps between recompositions. */
@Composable
private fun RealBody(modifier: Modifier = Modifier, title: String, subLabel: String?, onClick: (() -> Unit)?) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            var bodyModifier = Modifier.size(56.dp).background(Cosmos.Teal, CircleShape)
            if (onClick != null) bodyModifier = bodyModifier.clickable(onClick = onClick)
            Box(bodyModifier.semantics { contentDescription = title })
            Text(title, style = MaterialTheme.typography.labelMedium, color = Cosmos.InkOnDark, fontWeight = FontWeight.Bold)
            if (subLabel != null) Text(subLabel, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
        }
    }
}

@Composable
private fun DustBody(modifier: Modifier = Modifier, label: String) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Box(Modifier.size(30.dp).background(Cosmos.MutedOnDark.copy(alpha = 0.28f), CircleShape))
            Text(label, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark.copy(alpha = 0.7f))
        }
    }
}

@Composable
private fun DustCluster(modifier: Modifier = Modifier) {
    val label = stringResource(R.string.universe_dust_label)
    Box(modifier, contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Box(Modifier.size(26.dp).background(Cosmos.MutedOnDark.copy(alpha = 0.22f), CircleShape))
            Text(label, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark.copy(alpha = 0.6f))
        }
    }
}

@Composable
private fun PrivacyControls(
    state: HistoryClearState,
    onRequestHistoryClear: () -> Unit,
    onRetryHistoryClear: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.privacy_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
        OutlinedButton(
            onClick = onRequestHistoryClear,
            enabled = state !is HistoryClearState.Clearing && state !is HistoryClearState.Retryable && state !is HistoryClearState.ReconcileUnavailable && state !is HistoryClearState.SessionUnavailable,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Clear Scroll history" }
        ) { Text(stringResource(R.string.clear_history_action)) }
        when (state) {
            is HistoryClearState.Clearing -> Text(stringResource(R.string.clear_history_progress), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
            is HistoryClearState.Retryable -> {
                Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                OutlinedButton(
                    onClick = onRetryHistoryClear,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Retry the same history clear request" }
                ) { Text(stringResource(R.string.clear_history_retry)) }
            }
            is HistoryClearState.ReconcileUnavailable -> {
                Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                OutlinedButton(
                    onClick = onRetryHistoryClear,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Retry privacy reconciliation" }
                ) { Text(stringResource(R.string.action_retry)) }
            }
            is HistoryClearState.NeedsConfirmation -> Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
            is HistoryClearState.SessionUnavailable -> Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
            else -> Unit
        }
    }
}

/** Sign out this device (#91). Distinct from Clear History: it ends only this
 * device's session; it never erases recorded Scroll history. */
@Composable
private fun SignOutControls(
    state: SignOutState,
    onRequestSignOut: () -> Unit,
    onRetrySignOut: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(
            onClick = onRequestSignOut,
            enabled = state is SignOutState.Idle,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Sign out this device" }
        ) { Text(stringResource(R.string.sign_out_action)) }
        when (state) {
            is SignOutState.Revoking -> Text(stringResource(R.string.sign_out_progress), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
            is SignOutState.Retryable -> {
                Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                OutlinedButton(
                    onClick = onRetrySignOut,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Retry sign out this device" }
                ) { Text(stringResource(R.string.sign_out_retry)) }
            }
            else -> Unit
        }
    }
}

@Composable
private fun SignOutConfirmation(onCancel: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.sign_out_title)) },
        text = { Text(stringResource(R.string.sign_out_effects)) },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Coral, contentColor = Cosmos.Dark),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Confirm sign out this device" }
            ) { Text(stringResource(R.string.sign_out_confirm)) }
        },
        dismissButton = {
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Cancel sign out this device" }
            ) { Text(stringResource(R.string.sign_out_cancel)) }
        }
    )
}

@Composable
private fun ClearHistoryConfirmation(onCancel: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.clear_history_title)) },
        text = { Text(stringResource(R.string.clear_history_effects)) },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Coral, contentColor = Cosmos.Dark),
                modifier = Modifier.semantics { contentDescription = "Confirm clear Scroll history" }
            ) { Text(stringResource(R.string.clear_history_confirm)) }
        },
        dismissButton = {
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.semantics { contentDescription = "Cancel clear Scroll history" }
            ) { Text(stringResource(R.string.clear_history_cancel)) }
        }
    )
}
