package com.knowscroll.mobile.ui.scroll

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.AnswerStatus
import com.knowscroll.mobile.data.AnswerView
import com.knowscroll.mobile.data.questionIsValid
import com.knowscroll.mobile.ui.ask.AskPanel
import com.knowscroll.mobile.ui.ask.AskStage
import com.knowscroll.mobile.ui.theme.Cosmos

/** #132 — ADR-0033: the Ask sheet's recorded inputs, grouped like [WhyControls] so the reader's
 * parameters stay readable at the call site. */
data class AskControls(
    val panel: AskPanel? = null,
    val onOpen: () -> Unit = {},
    val onAsk: (String) -> Unit = {},
    val onGetAnswer: () -> Unit = {},
    val onCancel: () -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * #132 — ADR-0033: a reader's question about the Scroll on screen, and (as a separate, explicit
 * action) an authorized answer service's answer to it. Everything shown in a result comes from
 * the server's own recorded view; the client adds nothing and claims nothing it was not told.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AskSheet(controls: AskControls, onDismiss: () -> Unit) {
    val closeDescription = stringResource(R.string.ask_close_description)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Cosmos.Cream, contentColor = Cosmos.InkOnCream,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp)
                .semantics {
                    contentDescription = "Ask panel"
                    stateDescription = com.knowscroll.mobile.ui.ask.askStateDescription(controls.panel?.stage)
                },
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.ask_sheet_title), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
            AskBody(controls.panel, controls.onAsk, controls.onGetAnswer, controls.onCancel)
            OutlinedButton(
                onClick = onDismiss,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = closeDescription },
            ) { Text(stringResource(R.string.ask_close)) }
        }
    }
}

@Composable
private fun AskBody(panel: AskPanel?, onAsk: (String) -> Unit, onGetAnswer: () -> Unit, onCancel: () -> Unit) {
    when (val stage = panel?.stage ?: AskStage.Composing) {
        AskStage.Composing, is AskStage.Error -> {
            var text by rememberSaveable(panel?.assetId) { mutableStateOf(panel?.question ?: "") }
            OutlinedTextField(
                value = text, onValueChange = { text = it },
                label = { Text(stringResource(R.string.ask_question_label)) },
                modifier = Modifier.fillMaxWidth(),
            )
            if (stage is AskStage.Error) Text(
                stage.message, style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            val submitDescription = stringResource(R.string.ask_submit_description)
            Button(
                onClick = { onAsk(text) },
                enabled = questionIsValid(text),
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Dark, contentColor = Cosmos.Cream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = submitDescription },
            ) { Text(stringResource(R.string.ask_submit_action)) }
        }
        AskStage.Recording -> Progress(stringResource(R.string.ask_recording))
        is AskStage.Recorded -> {
            Text(stringResource(R.string.ask_recorded_explanation), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
            Button(
                onClick = onGetAnswer,
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Dark, contentColor = Cosmos.Cream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.ask_get_answer_action)) }
        }
        AskStage.Requesting -> Progress(stringResource(R.string.ask_requesting))
        is AskStage.Waiting -> {
            Progress(stringResource(if (stage.status == "running") R.string.ask_waiting_running else R.string.ask_waiting_queued))
            if (stage.status == "queued") OutlinedButton(
                onClick = onCancel,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.ask_cancel_action)) }
        }
        is AskStage.TimedOut -> Text(stringResource(R.string.ask_unavailable), style = MaterialTheme.typography.bodyLarge)
        is AskStage.Final -> AskResult(stage.view)
    }
}

@Composable
private fun Progress(label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.size(20.dp), color = Cosmos.Dark, strokeWidth = 2.dp)
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

/** #132: the answer service's own recorded view -- exactly what it returned, nothing inferred. */
@Composable
private fun AskResult(view: AnswerView) {
    when (val status = view.status) {
        is AnswerStatus.Answered -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(status.answer, style = MaterialTheme.typography.bodyLarge)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.ask_basis_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                status.basis.forEach { Text("· ${it.quote}", style = MaterialTheme.typography.bodyMedium) }
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.ask_limits_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                Text(status.limits, style = MaterialTheme.typography.bodyMedium)
            }
        }
        is AnswerStatus.NotInSource -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.ask_not_in_source), style = MaterialTheme.typography.bodyLarge)
            Text(status.limits, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
        }
        is AnswerStatus.Rejected -> Text(stringResource(R.string.ask_rejected), style = MaterialTheme.typography.bodyLarge)
        is AnswerStatus.Failed -> Text(stringResource(R.string.ask_failed), style = MaterialTheme.typography.bodyLarge)
        is AnswerStatus.Cancelled -> Text(stringResource(R.string.ask_cancelled), style = MaterialTheme.typography.bodyLarge)
        AnswerStatus.Unavailable -> Text(stringResource(R.string.ask_unavailable), style = MaterialTheme.typography.bodyLarge)
        // The polling loop only ever settles into a Final stage from a terminal status; queued/
        // running never reach here (see AppViewModel.pollAnswer / stageAfterPoll).
        AnswerStatus.Queued, AnswerStatus.Running -> Unit
    }
}
