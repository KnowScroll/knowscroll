package com.knowscroll.mobile.ui.account

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Every control this screen offers, bundled the way [com.knowscroll.mobile.ui.scroll.WhyControls]
 * already bundles a smaller related group -- the screen below is rendering only; every decision
 * lives in [AccountViewModel]. */
data class PrivacyActions(
    val onBack: () -> Unit,
    val onRetryLoad: () -> Unit,
    val onRequestPause: () -> Unit,
    val onRetryPause: () -> Unit,
    val onRequestResume: () -> Unit,
    val onRetryResume: () -> Unit,
    val onRequestExport: () -> Unit,
    val onRetryExport: () -> Unit,
    val onExportSaved: () -> Unit,
    val onRequestResetConfirmation: () -> Unit,
    val onCancelReset: () -> Unit,
    val onConfirmReset: () -> Unit,
    val onRetryReset: () -> Unit,
    val onRequestDeleteConfirmation: () -> Unit,
    val onCancelDelete: () -> Unit,
    val onConfirmDelete: () -> Unit,
    val onRetryDelete: () -> Unit,
    val onRequestSignOutConfirmation: () -> Unit,
    val onCancelSignOut: () -> Unit,
    val onConfirmSignOut: () -> Unit,
    val onRetrySignOut: () -> Unit,
)

/**
 * #135 (ADR-0028/0030/0034/0035): parity with the web settings surface. Reachable from the same
 * place the existing Clear-History/Sign-out disclosure lives (`UniverseScreen`'s
 * `PrivacyDisclosure`, `docs/product` audit A3). Every destructive action (Reset, Delete account)
 * has its own deliberate confirmation step with its own literal, matching Clear History's existing
 * pattern in this codebase; export never shares its content anywhere this screen does not
 * explicitly send it to (the Storage Access Framework's own picker).
 */
@Composable
fun PrivacyScreen(
    privacy: PrivacyState,
    pause: PrivacyOperationState,
    resume: PrivacyOperationState,
    export: ExportState,
    reset: PrivacyOperationState,
    delete: PrivacyOperationState,
    signOut: PrivacyOperationState,
    actions: PrivacyActions,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var pendingExportJson by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(export) { pendingExportJson = (export as? ExportState.Ready)?.json }
    val saveExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val json = pendingExportJson
        if (uri != null && json != null) {
            runCatching {
                context.contentResolver.openOutputStream(uri)?.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            }
        }
        actions.onExportSaved()
    }
    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            val backDescription = stringResource(R.string.privacy_screen_back_description)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(
                    onClick = actions.onBack,
                    modifier = Modifier.semantics { contentDescription = backDescription },
                ) { Text("‹ Back", color = Cosmos.Cream) }
            }
            Text(
                stringResource(R.string.privacy_screen_title), style = MaterialTheme.typography.displayLarge,
                color = Cosmos.InkOnDark, modifier = Modifier.semantics { heading() },
            )
            when (privacy) {
                is PrivacyState.Loading -> Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp, modifier = Modifier.padding(2.dp))
                    Text("Loading your privacy state…", color = Cosmos.MutedOnDark)
                }
                is PrivacyState.Unavailable -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(privacy.message, color = Cosmos.Coral)
                    OutlinedButton(onClick = actions.onRetryLoad, colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream)) {
                        Text(stringResource(R.string.action_retry))
                    }
                }
                is PrivacyState.Loaded -> Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
                    RecordingSection(privacy.recordingPausedAt, pause, resume, actions)
                    HorizontalDivider(color = Cosmos.Sea2)
                    ExportSection(export, actions, saveExport::launch)
                    HorizontalDivider(color = Cosmos.Sea2)
                    ResetSection(reset, actions)
                    HorizontalDivider(color = Cosmos.Sea2)
                    DeleteSection(delete, actions)
                    HorizontalDivider(color = Cosmos.Sea2)
                    SignOutSection(signOut, actions)
                }
            }
        }
    }
}

@Composable
private fun RecordingSection(recordingPausedAt: String?, pause: PrivacyOperationState, resume: PrivacyOperationState, actions: PrivacyActions) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.privacy_recording_heading), style = MaterialTheme.typography.titleLarge, color = Cosmos.Cream)
        Text(
            if (recordingPausedAt != null) stringResource(R.string.privacy_recording_paused, recordingPausedAt)
            else stringResource(R.string.privacy_recording_active),
            color = Cosmos.MutedOnDark,
        )
        if (recordingPausedAt == null) {
            OutlinedButton(
                onClick = actions.onRequestPause, enabled = pause !is PrivacyOperationState.Working,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Pause recording" },
            ) { Text(stringResource(R.string.privacy_pause_action)) }
        } else {
            OutlinedButton(
                onClick = actions.onRequestResume, enabled = resume !is PrivacyOperationState.Working,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Resume recording" },
            ) { Text(stringResource(R.string.privacy_resume_action)) }
        }
        operationStatus(pause, actions.onRetryPause, "Retry pause recording")
        operationStatus(resume, actions.onRetryResume, "Retry resume recording")
    }
}

@Composable
private fun ExportSection(export: ExportState, actions: PrivacyActions, launchSave: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.privacy_export_heading), style = MaterialTheme.typography.titleLarge, color = Cosmos.Cream)
        Text(stringResource(R.string.privacy_export_body), color = Cosmos.MutedOnDark)
        when (export) {
            is ExportState.Ready -> Button(
                onClick = { launchSave(exportFileName()) },
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Yellow, contentColor = Cosmos.InkOnCream),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Save the export file" },
            ) { Text(stringResource(R.string.privacy_export_save_action)) }
            is ExportState.Working -> Text(stringResource(R.string.privacy_export_working), color = Cosmos.MutedOnDark)
            is ExportState.Failed -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(export.message, color = Cosmos.Coral)
                OutlinedButton(
                    onClick = actions.onRetryExport, colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Retry export my data" },
                ) { Text(stringResource(R.string.action_retry)) }
            }
            is ExportState.Idle -> OutlinedButton(
                onClick = actions.onRequestExport, colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Export my data" },
            ) { Text(stringResource(R.string.privacy_export_action)) }
        }
    }
}

private fun exportFileName(): String =
    "knowscroll-export-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())}.json"

@Composable
private fun ResetSection(reset: PrivacyOperationState, actions: PrivacyActions) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.privacy_reset_heading), style = MaterialTheme.typography.titleLarge, color = Cosmos.Cream)
        Text(stringResource(R.string.privacy_reset_body), color = Cosmos.MutedOnDark)
        OutlinedButton(
            onClick = actions.onRequestResetConfirmation, enabled = reset is PrivacyOperationState.Idle || reset is PrivacyOperationState.Failed,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Coral),
            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Reset my personal history" },
        ) { Text(stringResource(R.string.privacy_reset_action)) }
        operationStatus(reset, actions.onRetryReset, "Retry reset my personal history")
    }
    if (reset is PrivacyOperationState.Confirming) DestructiveConfirmation(
        title = stringResource(R.string.privacy_reset_title), body = stringResource(R.string.privacy_reset_effects),
        confirmLabel = stringResource(R.string.privacy_reset_confirm),
        confirmDescription = "Confirm reset my personal history", cancelDescription = "Cancel reset my personal history",
        onCancel = actions.onCancelReset, onConfirm = actions.onConfirmReset,
    )
}

@Composable
private fun DeleteSection(delete: PrivacyOperationState, actions: PrivacyActions) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.privacy_delete_heading), style = MaterialTheme.typography.titleLarge, color = Cosmos.Cream)
        Text(stringResource(R.string.privacy_delete_body), color = Cosmos.MutedOnDark)
        OutlinedButton(
            onClick = actions.onRequestDeleteConfirmation, enabled = delete is PrivacyOperationState.Idle || delete is PrivacyOperationState.Failed,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Coral),
            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Delete my account" },
        ) { Text(stringResource(R.string.privacy_delete_action)) }
        operationStatus(delete, actions.onRetryDelete, "Retry delete my account")
    }
    if (delete is PrivacyOperationState.Confirming) DestructiveConfirmation(
        title = stringResource(R.string.privacy_delete_title), body = stringResource(R.string.privacy_delete_effects),
        confirmLabel = stringResource(R.string.privacy_delete_confirm),
        confirmDescription = "Confirm delete my account", cancelDescription = "Cancel delete my account",
        onCancel = actions.onCancelDelete, onConfirm = actions.onConfirmDelete,
    )
}

@Composable
private fun SignOutSection(signOut: PrivacyOperationState, actions: PrivacyActions) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.privacy_sign_out_heading), style = MaterialTheme.typography.titleLarge, color = Cosmos.Cream)
        OutlinedButton(
            onClick = actions.onRequestSignOutConfirmation, enabled = signOut is PrivacyOperationState.Idle || signOut is PrivacyOperationState.Failed,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Sign out this device from Privacy" },
        ) { Text(stringResource(R.string.privacy_sign_out_action)) }
        operationStatus(signOut, actions.onRetrySignOut, "Retry sign out this device from Privacy")
    }
    if (signOut is PrivacyOperationState.Confirming) DestructiveConfirmation(
        title = stringResource(R.string.sign_out_title), body = stringResource(R.string.sign_out_effects),
        confirmLabel = stringResource(R.string.sign_out_confirm),
        confirmDescription = "Confirm sign out this device from Privacy", cancelDescription = "Cancel sign out this device from Privacy",
        onCancel = actions.onCancelSignOut, onConfirm = actions.onConfirmSignOut,
    )
}

@Composable
private fun operationStatus(state: PrivacyOperationState, onRetry: () -> Unit, retryDescription: String) {
    when (state) {
        is PrivacyOperationState.Working -> Text(stringResource(R.string.privacy_working), color = Cosmos.MutedOnDark)
        is PrivacyOperationState.Failed -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(state.message, color = Cosmos.Coral)
            OutlinedButton(
                onClick = onRetry, colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
            ) { Text(stringResource(R.string.action_retry)) }
        }
        else -> Unit
    }
}

@Composable
private fun DestructiveConfirmation(
    title: String, body: String, confirmLabel: String,
    confirmDescription: String, cancelDescription: String,
    onCancel: () -> Unit, onConfirm: () -> Unit,
) = com.knowscroll.mobile.ui.theme.PosterTheme {
    AlertDialog(
        containerColor = Cosmos.Cream, titleContentColor = com.knowscroll.mobile.ui.theme.Cosmos.InkOnCream,
        textContentColor = com.knowscroll.mobile.ui.theme.Cosmos.InkOnCream,
        onDismissRequest = onCancel,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Coral, contentColor = Cosmos.Dark),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = confirmDescription },
            ) { Text(confirmLabel) }
        },
        dismissButton = {
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = cancelDescription },
            ) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}
