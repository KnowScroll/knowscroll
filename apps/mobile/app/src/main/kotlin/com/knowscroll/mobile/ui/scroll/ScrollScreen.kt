package com.knowscroll.mobile.ui.scroll

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.theme.Cosmos

@Composable
fun ScrollScreen(
    state: ScrollState,
    onKeep: () -> Unit,
    onReturn: () -> Unit,
    onNext: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize().background(Cosmos.Dark)) {
        when (state) {
            is ScrollState.Reading -> ReadingSheet(state.item, state.keep, onKeep, onReturn, onNext)
            is ScrollState.Unavailable -> UnavailableColumn(state.message, onReturn, onRetry)
            else -> Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp)
            }
        }
    }
}

@Composable
private fun UnavailableColumn(message: String, onReturn: () -> Unit, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(stringResource(R.string.scroll_unavailable), style = MaterialTheme.typography.titleLarge, color = Cosmos.Coral)
        Text(message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.action_retry)) }
            OutlinedButton(onClick = onReturn) { Text(stringResource(R.string.action_return)) }
        }
    }
}

@Composable
private fun ReadingSheet(item: ScrollItem, keep: KeepState, onKeep: () -> Unit, onReturn: () -> Unit, onNext: () -> Unit) {
    val context = LocalContext.current
    Surface(
        color = Cosmos.Cream,
        contentColor = Cosmos.InkOnCream,
        shape = RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp),
        modifier = Modifier.fillMaxSize().padding(top = 24.dp)
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 24.dp)) {
            Column(
                modifier = Modifier.fillMaxWidth().weight(1f, fill = true).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text("SCROLL · ${item.truthState.uppercase()}", style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                Text(item.title, style = MaterialTheme.typography.headlineMedium, color = Cosmos.InkOnCream)
                Text(item.reason, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
                Text(item.summary, style = MaterialTheme.typography.titleMedium, color = Cosmos.MutedOnCream)
                Text(item.body, style = MaterialTheme.typography.bodyLarge, color = Cosmos.InkOnCream)
                SourceRow(item.sourceTitle, item.sourceUrl) {
                    runCatching {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(item.sourceUrl))
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(intent)
                    }
                }
            }
            ActionRow(keep, onKeep, onReturn, onNext)
        }
    }
}

@Composable
private fun SourceRow(sourceTitle: String, sourceUrl: String, onOpenSource: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("SOURCE", style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
        OutlinedButton(
            onClick = onOpenSource,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .semantics { contentDescription = "Open $sourceTitle in browser" }
        ) {
            Text("${stringResource(R.string.action_open_source)} · $sourceTitle", style = MaterialTheme.typography.titleMedium)
        }
        Text(sourceUrl, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
    }
}

@Composable
private fun ActionRow(keep: KeepState, onKeep: () -> Unit, onReturn: () -> Unit, onNext: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val keepLabel = when (keep) {
            is KeepState.Kept -> stringResource(R.string.action_kept)
            is KeepState.Saving -> stringResource(R.string.keep_pending)
            else -> stringResource(R.string.action_keep)
        }
        val keepEnabled = keep is KeepState.Idle || keep is KeepState.Failed || keep is KeepState.Conflict
        Button(
            onClick = onKeep,
            enabled = keepEnabled,
            colors = ButtonDefaults.buttonColors(
                containerColor = when (keep) {
                    is KeepState.Kept -> Cosmos.CreamDim
                    is KeepState.Failed -> Cosmos.Coral
                    is KeepState.Conflict -> Cosmos.Coral
                    else -> Cosmos.Teal
                },
                contentColor = if (keep is KeepState.Kept) Cosmos.InkOnCream else Cosmos.Dark
            ),
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)
                .semantics { contentDescription = "Keep this Scroll" }
        ) { Text(keepLabel, style = MaterialTheme.typography.titleMedium) }
        when (keep) {
            is KeepState.Failed -> Text(
                stringResource(R.string.keep_failed) + " — " + keep.message,
                style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral
            )
            is KeepState.Conflict -> Text(keep.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
            is KeepState.Kept -> Text(
                "Kept for your return.",
                style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream
            )
            else -> Unit
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(
                onClick = onReturn,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                    .semantics { contentDescription = "Return to the universe" }
            ) { Text(stringResource(R.string.action_return)) }
            OutlinedButton(
                onClick = onNext,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                enabled = keep !is KeepState.Saving && keep !is KeepState.Failed && keep !is KeepState.Conflict,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                    .semantics { contentDescription = "Get the next Scroll" }
            ) { Text(stringResource(R.string.action_next)) }
        }
    }
}
