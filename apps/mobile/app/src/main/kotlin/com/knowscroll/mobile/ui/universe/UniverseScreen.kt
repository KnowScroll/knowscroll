package com.knowscroll.mobile.ui.universe

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.HistoryClearState
import com.knowscroll.mobile.ui.SignOutState
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos

@Composable
fun UniverseScreen(
    state: UniverseState,
    historyClear: HistoryClearState,
    signOut: SignOutState,
    onEnterScroll: () -> Unit,
    onOpenTrace: (com.knowscroll.mobile.data.Trace) -> Unit,
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
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            Text("KNOWSCROLL", style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Text(stringResource(R.string.universe_title), style = MaterialTheme.typography.displayLarge, color = Cosmos.InkOnDark)
            when (state) {
                is UniverseState.Loading -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.universe_loading), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                }
                is UniverseState.Unavailable -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.universe_unavailable), style = MaterialTheme.typography.titleLarge, color = Cosmos.Coral)
                    Text(stringResource(R.string.universe_unavailable_help), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                    Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                    OutlinedButton(
                        onClick = onRetry,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                        modifier = Modifier.semantics { contentDescription = "Retry loading the universe" }
                    ) { Text(stringResource(R.string.action_retry)) }
                }
                is UniverseState.Loaded -> LoadedBlock(state.universe,onEnterScroll,onOpenTrace)
            }
            if(state is UniverseState.Loaded || historyClear !is HistoryClearState.Idle || signOut !is SignOutState.Idle){
                PrivacyControls(historyClear,onRequestHistoryClear,onRetryHistoryClear)
                SignOutControls(signOut,onRequestSignOut,onRetrySignOut)
            }
        }
        if(historyClear is HistoryClearState.Confirming) ClearHistoryConfirmation(
            onCancel=onCancelHistoryClear,onConfirm=onConfirmHistoryClear
        )
        if(signOut is SignOutState.Confirming) SignOutConfirmation(
            onCancel=onCancelSignOut,onConfirm=onConfirmSignOut
        )
    }
}

@Composable
private fun LoadedBlock(
    universe: Universe,
    onEnterScroll: () -> Unit,
    onOpenTrace: (com.knowscroll.mobile.data.Trace) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        if (universe.traces.isEmpty()) {
            Text(stringResource(R.string.universe_empty), style = MaterialTheme.typography.bodyLarge, color = Cosmos.MutedOnDark)
        } else {
            Text(stringResource(R.string.traces_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                universe.traces.forEach { trace ->
                    val traceDescription = stringResource(R.string.trace_revisit_action, trace.eventId)
                    Surface(
                        color = Color(0xFF0A1B26),
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
        Spacer(modifier = Modifier.height(8.dp))
        Button(
            onClick = onEnterScroll,
            colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Teal, contentColor = Cosmos.Dark),
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Enter Scroll" }
        ) { Text(stringResource(R.string.action_enter_scroll), style = MaterialTheme.typography.titleMedium) }
    }
}

@Composable
private fun PrivacyControls(
    state:HistoryClearState,
    onRequestHistoryClear:()->Unit,
    onRetryHistoryClear:()->Unit
){
    Column(verticalArrangement=Arrangement.spacedBy(10.dp)){
        Text(stringResource(R.string.privacy_heading),style=MaterialTheme.typography.labelMedium,color=Cosmos.MutedOnDark)
        OutlinedButton(
            onClick=onRequestHistoryClear,
            enabled=state !is HistoryClearState.Clearing && state !is HistoryClearState.Retryable && state !is HistoryClearState.ReconcileUnavailable && state !is HistoryClearState.SessionUnavailable,
            colors=ButtonDefaults.outlinedButtonColors(contentColor=Cosmos.Cream),
            modifier=Modifier.fillMaxWidth().semantics{contentDescription="Clear Scroll history"}
        ){Text(stringResource(R.string.clear_history_action))}
        when(state){
            is HistoryClearState.Clearing -> Text(stringResource(R.string.clear_history_progress),style=MaterialTheme.typography.bodyMedium,color=Cosmos.MutedOnDark)
            is HistoryClearState.Retryable -> {
                Text(state.message,style=MaterialTheme.typography.bodyMedium,color=Cosmos.Coral)
                OutlinedButton(
                    onClick=onRetryHistoryClear,
                    colors=ButtonDefaults.outlinedButtonColors(contentColor=Cosmos.Cream),
                    modifier=Modifier.fillMaxWidth().semantics{contentDescription="Retry the same history clear request"}
                ){Text(stringResource(R.string.clear_history_retry))}
            }
            is HistoryClearState.ReconcileUnavailable -> {
                Text(state.message,style=MaterialTheme.typography.bodyMedium,color=Cosmos.Coral)
                OutlinedButton(
                    onClick=onRetryHistoryClear,
                    colors=ButtonDefaults.outlinedButtonColors(contentColor=Cosmos.Cream),
                    modifier=Modifier.fillMaxWidth().semantics{contentDescription="Retry privacy reconciliation"}
                ){Text(stringResource(R.string.action_retry))}
            }
            is HistoryClearState.NeedsConfirmation -> Text(state.message,style=MaterialTheme.typography.bodyMedium,color=Cosmos.Coral)
            is HistoryClearState.SessionUnavailable -> Text(state.message,style=MaterialTheme.typography.bodyMedium,color=Cosmos.Coral)
            else -> Unit
        }
    }
}

/** Sign out this device (#91). Distinct from Clear History: it ends only this
 * device's session; it never erases recorded Scroll history. */
@Composable
private fun SignOutControls(
    state:SignOutState,
    onRequestSignOut:()->Unit,
    onRetrySignOut:()->Unit
){
    Column(verticalArrangement=Arrangement.spacedBy(10.dp)){
        OutlinedButton(
            onClick=onRequestSignOut,
            enabled=state is SignOutState.Idle,
            colors=ButtonDefaults.outlinedButtonColors(contentColor=Cosmos.Cream),
            modifier=Modifier.fillMaxWidth().heightIn(min=48.dp).semantics{contentDescription="Sign out this device"}
        ){Text(stringResource(R.string.sign_out_action))}
        when(state){
            is SignOutState.Revoking -> Text(stringResource(R.string.sign_out_progress),style=MaterialTheme.typography.bodyMedium,color=Cosmos.MutedOnDark)
            is SignOutState.Retryable -> {
                Text(state.message,style=MaterialTheme.typography.bodyMedium,color=Cosmos.Coral)
                OutlinedButton(
                    onClick=onRetrySignOut,
                    colors=ButtonDefaults.outlinedButtonColors(contentColor=Cosmos.Cream),
                    modifier=Modifier.fillMaxWidth().semantics{contentDescription="Retry sign out this device"}
                ){Text(stringResource(R.string.sign_out_retry))}
            }
            else -> Unit
        }
    }
}

@Composable
private fun SignOutConfirmation(onCancel:()->Unit,onConfirm:()->Unit){
    AlertDialog(
        onDismissRequest=onCancel,
        title={Text(stringResource(R.string.sign_out_title))},
        text={Text(stringResource(R.string.sign_out_effects))},
        confirmButton={
            Button(
                onClick=onConfirm,
                colors=ButtonDefaults.buttonColors(containerColor=Cosmos.Coral,contentColor=Cosmos.Dark),
                modifier=Modifier.heightIn(min=48.dp).semantics{contentDescription="Confirm sign out this device"}
            ){Text(stringResource(R.string.sign_out_confirm))}
        },
        dismissButton={
            OutlinedButton(
                onClick=onCancel,
                modifier=Modifier.heightIn(min=48.dp).semantics{contentDescription="Cancel sign out this device"}
            ){Text(stringResource(R.string.sign_out_cancel))}
        }
    )
}

@Composable
private fun ClearHistoryConfirmation(onCancel:()->Unit,onConfirm:()->Unit){
    AlertDialog(
        onDismissRequest=onCancel,
        title={Text(stringResource(R.string.clear_history_title))},
        text={Text(stringResource(R.string.clear_history_effects))},
        confirmButton={
            Button(
                onClick=onConfirm,
                colors=ButtonDefaults.buttonColors(containerColor=Cosmos.Coral,contentColor=Cosmos.Dark),
                modifier=Modifier.semantics{contentDescription="Confirm clear Scroll history"}
            ){Text(stringResource(R.string.clear_history_confirm))}
        },
        dismissButton={
            OutlinedButton(
                onClick=onCancel,
                modifier=Modifier.semantics{contentDescription="Cancel clear Scroll history"}
            ){Text(stringResource(R.string.clear_history_cancel))}
        }
    )
}
