package com.knowscroll.mobile.ui.universe

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
import kotlin.math.max
import kotlin.math.min

/** Atlas contains saved Traces; source-backed worlds are inspected inside System. */
@Composable
fun UniverseScreen(
    state: UniverseState,
    historyClear: HistoryClearState,
    signOut: SignOutState,
    onEnterScroll: () -> Unit,
    onOpenTrace: (Trace) -> Unit,
    onEnterSystem: () -> Unit,
    onRetry: () -> Unit,
    onRequestHistoryClear: () -> Unit,
    onCancelHistoryClear: () -> Unit,
    onConfirmHistoryClear: () -> Unit,
    onRetryHistoryClear: () -> Unit,
    onRequestSignOut: () -> Unit,
    onCancelSignOut: () -> Unit,
    onConfirmSignOut: () -> Unit,
    onRetrySignOut: () -> Unit,
    onOpenKeep: () -> Unit,
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
                        onEnterSystem = onEnterSystem,
                        onRequestHistoryClear = onRequestHistoryClear,
                        onRetryHistoryClear = onRetryHistoryClear,
                        onRequestSignOut = onRequestSignOut,
                        onRetrySignOut = onRetrySignOut
                    )
                }
            }
            BottomCompass(
                selected = CompassTab.Atlas,
                onSelectAtlas = {},
                onSelectCable = onEnterScroll,
                onSelectKeep = onOpenKeep
            )
        }
        if (historyClear is HistoryClearState.Confirming) ClearHistoryConfirmation(
            onCancel = onCancelHistoryClear, onConfirm = onConfirmHistoryClear
        )
        if (signOut is SignOutState.Confirming) SignOutConfirmation(
            onCancel = onCancelSignOut, onConfirm = onConfirmSignOut
        )
    }
}

// docs/product/ui-system.md sec.5b lists `DAY n ▸` as "the real age of the universe", but
// GET /v1/universe (docs/contracts/bootstrap-http.md) carries no universe-level createdAt at
// all -- only each Trace has one. An earlier version of this screen computed a `DAY n` pill from
// the earliest kept Trace's createdAt anyway, and its own doc comment claimed it "carries the
// real DAY n age, never a decoration". That claim did not hold: days-since-first-Keep is a real,
// contract-backed number, but it is not the universe's age -- an owner who signed in on day 1 and
// kept nothing until day 10 would see "DAY 1", which asserts something about the universe that
// no field in the contract supports. The web build (docs/CHECKPOINT.md, #110) refused this same
// pill for the same reason: no universe-creation timestamp exists to draw it from. This client
// now matches that refusal instead of inventing a proxy -- see §6: "not available, therefore not
// drawn" governs content, and a mislabelled real field is still a false claim about what it
// carries.

@Composable
private fun UniverseCanvasScreen(
    universe: Universe,
    historyClear: HistoryClearState,
    signOut: SignOutState,
    onEnterScroll: () -> Unit,
    onOpenTrace: (Trace) -> Unit,
    onEnterSystem: () -> Unit,
    onRequestHistoryClear: () -> Unit,
    onRetryHistoryClear: () -> Unit,
    onRequestSignOut: () -> Unit,
    onRetrySignOut: () -> Unit
) {
    val hasRead = universe.traces.isNotEmpty()
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        // docs/product/ui-system.md sec.5b's `DAY n ▸` status pill is deliberately not drawn here:
        // see the honesty note above `StatusPill`'s old definition (removed) -- no universe-level
        // createdAt exists in the bootstrap contract, matching the web build's own refusal.
        Column {
            Text(stringResource(R.string.universe_kicker), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Text(stringResource(R.string.universe_title), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
        }
        Text(
            stringResource(if (hasRead) R.string.universe_heading_started else R.string.universe_heading_first),
            style = MaterialTheme.typography.displayLarge, color = Cosmos.InkOnDark
        )
        Text(
            stringResource(if (hasRead) R.string.universe_subtitle_started else R.string.universe_subtitle_first),
            style = MaterialTheme.typography.bodyLarge, color = Cosmos.MutedOnDark
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


        if (hasRead) YellowNote(stringResource(R.string.universe_kept_note, universe.traces.size))

        UniverseCanvas(traces = universe.traces, onOpenTrace = onOpenTrace, onEnterSystem = onEnterSystem)

        Text(
            stringResource(if (hasRead) R.string.universe_hint_started else R.string.universe_hint_first),
            style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark
        )

        // docs/product/ui-system.md sec.5b: the dock's own Keep destination is the real Traces
        // list now (see KeepScreen.kt); the canvas above already draws one body per kept Trace,
        // so this screen no longer duplicates the list textually as well.

        // Audit A3 (#72): the previous two stacked full-width controls ("Clear Scroll history"
        // and "Sign out this device") pushed against the dock and buried the explanatory copy.
        // Replaced with a compact disclosure block: a one-line explanation and two 48dp pills in
        // a single row so both Clear and Sign-out remain reachable above the dock at every
        // supported width. Confirmation semantics (modal dialogs, retry envelopes, purge on
        // confirm) are preserved verbatim -- only the position of the buttons changed.
        PrivacyDisclosure(
            historyClear = historyClear,
            signOut = signOut,
            onRequestHistoryClear = onRequestHistoryClear,
            onRetryHistoryClear = onRetryHistoryClear,
            onRequestSignOut = onRequestSignOut,
            onRetrySignOut = onRetrySignOut
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

/** Flow layout shares the page scroll, so every Trace remains reachable at any collection size. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UniverseCanvas(traces: List<Trace>, onOpenTrace: (Trace) -> Unit, onEnterSystem: () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        FlowRow(
            modifier = Modifier.fillMaxWidth().heightIn(min = 200.dp).padding(vertical = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            if (traces.isEmpty()) {
                DustBody(stringResource(R.string.universe_body_angle))
                RealBody(stringResource(R.string.universe_body_possibility),
                    stringResource(R.string.universe_body_possibility_helper), null)
                DustBody(stringResource(R.string.universe_body_surprise))
            } else traces.forEach { trace ->
                RealBody(trace.title.ifBlank { stringResource(R.string.trace_unknown_title) }, null,
                    onClick = { onOpenTrace(trace) })
            }
        }
        SystemViewButton(onEnterSystem)
    }
}

/**
 * docs/product/ui-system.md sec.5c: Living Observatory's own `#scaleLabel` names which navigable
 * depth the reader is at ("SYSTEM VIEW" when only the universe level existed to name). #116 built
 * the system level for real (ADR-0028/#113), so -- matching the web lane's own change to this
 * exact control (`claude/116-system-view`'s `UniverseScreen.tsx`) -- the label becomes what the
 * reference always made it: a control that goes there. Section 4b overrides the reference's own
 * ~34px hit area with the Android platform's 48dp minimum.
 */
@Composable
private fun SystemViewButton(onClick: () -> Unit) {
    val description = stringResource(R.string.system_view_description)
    Surface(
        color = Cosmos.SpaceRaised, contentColor = Cosmos.MutedOnDark,
        shape = RoundedCornerShape(percent = 50),
        border = BorderStroke(1.dp, Cosmos.Sea2),
        modifier = Modifier.heightIn(min = 48.dp)
            .clickable(onClickLabel = description, onClick = onClick)
            .semantics { contentDescription = description }
    ) {
        Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.universe_view_label), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
        }
    }
}

/** Equal-size saved-Trace markers; a Keep is not evidence of world growth. */
@Composable
private fun RealBody(title: String, subLabel: String?, onClick: (() -> Unit)?, modifier: Modifier = Modifier) {
    Box(if (onClick != null) modifier.clickable(onClick = onClick) else modifier, contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.widthIn(max = 128.dp)) {
            val bodyModifier = Modifier.size(40.dp).background(androidx.compose.ui.graphics.Brush.radialGradient(listOf(Cosmos.Teal2, Cosmos.Teal, Cosmos.Deep)), CircleShape)
            Box(bodyModifier.semantics { contentDescription = title })
            Text(title, style = MaterialTheme.typography.titleMedium, color = Cosmos.InkOnDark, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            if (subLabel != null) Text(subLabel, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun DustBody(label: String, modifier: Modifier = Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.widthIn(max = 120.dp)) {
            Box(Modifier.size(28.dp).background(Cosmos.MutedOnDark.copy(alpha = 0.28f), CircleShape))
            Text(label, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark.copy(alpha = 0.7f), maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        }
    }
}

/**
 * Audit A3 (#72): compact privacy disclosure that keeps both Clear and Sign-out reachable
 * above the dock at every supported width. The disclosure copy is one short paragraph that
 * names both actions and what each one does, then two pills side by side. Each pill is its own
 * modal-confirmation flow (privacy / sign-out confirmation semantics are unchanged); the
 * progress and retry copy lives beneath the buttons so it does not push them off-screen on a
 * shorter canvas. The full-width stacked layout the audit found pushing against the dock is
 * gone.
 */
@Composable
private fun PrivacyDisclosure(
    historyClear: HistoryClearState,
    signOut: SignOutState,
    onRequestHistoryClear: () -> Unit,
    onRetryHistoryClear: () -> Unit,
    onRequestSignOut: () -> Unit,
    onRetrySignOut: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.privacy_heading),
            style = MaterialTheme.typography.labelMedium,
            color = Cosmos.MutedOnDark
        )
        Text(
            stringResource(R.string.privacy_disclosure),
            style = MaterialTheme.typography.bodyMedium,
            color = Cosmos.MutedOnDark
        )
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            OutlinedButton(
                onClick = onRequestHistoryClear,
                enabled = historyClear !is HistoryClearState.Clearing && historyClear !is HistoryClearState.Retryable && historyClear !is HistoryClearState.ReconcileUnavailable && historyClear !is HistoryClearState.SessionUnavailable,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).semantics { contentDescription = "Clear Scroll history" }
            ) {
                Text(
                    stringResource(R.string.clear_history_action),
                    fontWeight = FontWeight(800),
                    style = MaterialTheme.typography.labelLarge
                )
            }
            OutlinedButton(
                onClick = onRequestSignOut,
                enabled = signOut is SignOutState.Idle,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).semantics { contentDescription = "Sign out this device" }
            ) {
                Text(
                    stringResource(R.string.sign_out_action),
                    fontWeight = FontWeight(800),
                    style = MaterialTheme.typography.labelLarge
                )
            }
        }
        when (historyClear) {
            is HistoryClearState.Clearing -> Text(stringResource(R.string.clear_history_progress), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            is HistoryClearState.Retryable -> {
                Text(historyClear.message, style = MaterialTheme.typography.labelMedium, color = Cosmos.Coral)
                OutlinedButton(
                    onClick = onRetryHistoryClear,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Retry the same history clear request" }
                ) { Text(stringResource(R.string.clear_history_retry), fontWeight = FontWeight(800), style = MaterialTheme.typography.labelLarge) }
            }
            is HistoryClearState.ReconcileUnavailable -> {
                Text(historyClear.message, style = MaterialTheme.typography.labelMedium, color = Cosmos.Coral)
                OutlinedButton(
                    onClick = onRetryHistoryClear,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Retry privacy reconciliation" }
                ) { Text(stringResource(R.string.action_retry), fontWeight = FontWeight(800), style = MaterialTheme.typography.labelLarge) }
            }
            is HistoryClearState.NeedsConfirmation -> Text(historyClear.message, style = MaterialTheme.typography.labelMedium, color = Cosmos.Coral)
            is HistoryClearState.SessionUnavailable -> Text(historyClear.message, style = MaterialTheme.typography.labelMedium, color = Cosmos.Coral)
            else -> Unit
        }
        when (signOut) {
            is SignOutState.Revoking -> Text(stringResource(R.string.sign_out_progress), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            is SignOutState.Retryable -> {
                Text(signOut.message, style = MaterialTheme.typography.labelMedium, color = Cosmos.Coral)
                OutlinedButton(
                    onClick = onRetrySignOut,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Retry sign out this device" }
                ) { Text(stringResource(R.string.sign_out_retry), fontWeight = FontWeight(800), style = MaterialTheme.typography.labelLarge) }
            }
            else -> Unit
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
