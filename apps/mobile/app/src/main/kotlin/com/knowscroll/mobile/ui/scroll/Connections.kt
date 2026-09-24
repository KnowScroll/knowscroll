package com.knowscroll.mobile.ui.scroll

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.LiveBranch
import com.knowscroll.mobile.ui.BranchAvailability
import com.knowscroll.mobile.ui.BranchRail
import com.knowscroll.mobile.ui.branch.BranchPanel
import com.knowscroll.mobile.ui.theme.Cosmos

/**
 * #131/#134 — the reader's live continuations, drawn in PR130's existing `BranchRail` seam.
 * Everything shown comes from the server's admitted bridges; the sheet shows the mechanism,
 * where the connection stops and the cited evidence, and lets the reader hide a connection for
 * themselves without claiming the sources are wrong.
 */
@Composable
internal fun BranchSection(
    panel: BranchPanel?,
    onOpenBranch: (String) -> Unit,
    onRetry: () -> Unit,
    onWhy: () -> Unit,
) {
    val availability = panel?.availability ?: BranchAvailability.Unavailable
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BranchRail(
            availability = availability,
            onBranch = { onOpenBranch(it.id) },
            enabled = panel?.opening == null,
        )
        if (panel?.opening != null) Text(stringResource(R.string.branch_opening), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
        panel?.message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Cosmos.InkOnCream) }
        when (availability) {
            is BranchAvailability.Ready -> TextButton(
                onClick = onWhy,
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.branch_why_action)) }
            BranchAvailability.Failed -> TextButton(
                onClick = onRetry,
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.branch_retry)) }
            else -> Unit
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConnectionSheet(
    branches: List<LiveBranch>,
    onOpenBranch: (String) -> Unit,
    onObject: (bridgeId: String, objection: String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Cosmos.Cream, contentColor = Cosmos.InkOnCream,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(stringResource(R.string.connection_sheet_title), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
            branches.forEach { branch -> ConnectionCard(branch, onOpenBranch, onObject) }
            Text(stringResource(R.string.connection_feedback_note), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
            OutlinedButton(
                onClick = onDismiss,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.connection_close)) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConnectionCard(branch: LiveBranch, onOpenBranch: (String) -> Unit, onObject: (String, String) -> Unit) {
    Surface(color = Cosmos.CreamDim, contentColor = Cosmos.InkOnCream, shape = RoundedCornerShape(20.dp)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(branch.relationSentence, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            Text("→ ${branch.targetTitle}", style = MaterialTheme.typography.titleSmall, color = Cosmos.MutedOnCream)
            Labeled(stringResource(R.string.connection_mechanism_heading)) { Text(branch.mechanism, style = MaterialTheme.typography.bodyLarge) }
            if (branch.prerequisites.isNotEmpty()) Labeled(stringResource(R.string.connection_prerequisites_heading)) {
                branch.prerequisites.forEach { Text("· $it", style = MaterialTheme.typography.bodyMedium) }
            }
            Labeled(stringResource(R.string.connection_limits_heading)) {
                branch.limitations.forEach { Text("· ${it.statement}", style = MaterialTheme.typography.bodyMedium) }
            }
            Labeled(stringResource(R.string.connection_evidence_heading)) {
                // One claim can support several roles (from, to, mechanism); show each claim once.
                branch.evidence.distinctBy { it.statement }.forEach { e ->
                    Text(e.statement, style = MaterialTheme.typography.bodyMedium)
                    Text(e.sourceTitle, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Button(
                    onClick = { onOpenBranch(branch.branchId) },
                    colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Dark, contentColor = Cosmos.Cream),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Follow: ${branch.relationSentence}" },
                ) { Text(stringResource(R.string.connection_open)) }
                TextButton(
                    onClick = { onObject(branch.bridgeId, "not_useful") },
                    colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(stringResource(R.string.connection_not_useful)) }
                TextButton(
                    onClick = { onObject(branch.bridgeId, "seems_wrong") },
                    colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(stringResource(R.string.connection_seems_wrong)) }
            }
        }
    }
}

@Composable
private fun Labeled(label: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
        content()
    }
}
