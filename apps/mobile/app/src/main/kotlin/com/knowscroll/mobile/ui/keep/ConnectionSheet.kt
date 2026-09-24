package com.knowscroll.mobile.ui.keep

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.InquiryFound
import com.knowscroll.mobile.data.Relic
import com.knowscroll.mobile.ui.theme.Cosmos
import com.knowscroll.mobile.ui.theme.Poster
import com.knowscroll.mobile.ui.theme.PosterTheme

/** The controls a found connection's sheet offers; every decision is [ReturnViewModel]'s. */
data class ConnectionActions(
    val onKeep: (String) -> Unit,
    val onRetryKeep: (String) -> Unit,
    val onSeemsWrong: (String) -> Unit,
    val onRetrySeemsWrong: (String) -> Unit,
)

/**
 * #134 (ADR-0039): the bottom sheet a found connection (on the Atlas) or a Relic (on Keep) opens,
 * in the place sheet's own form (`PlaceDetail`): a back pill, the two places, the bridge's validated
 * sentence and the claims it was admitted on, then the reader's choices. Tapping above the sheet
 * dismisses it and never reaches what is beneath. [bordered] draws the poster ink edge Keep's paper
 * ground needs to set the sheet apart.
 */
@Composable
internal fun ReturnSheet(onDismiss: () -> Unit, bordered: Boolean = false, content: @Composable () -> Unit) {
    val dismissDescription = stringResource(R.string.connection_dismiss_description)
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().clickable(onClick = onDismiss).semantics { contentDescription = dismissDescription })
        Surface(
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(max = 520.dp),
            color = Cosmos.Cream,
            contentColor = Cosmos.InkOnCream,
            border = if (bordered) BorderStroke(2.dp, Poster.Ink) else null,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        ) { PosterTheme { content() } }
    }
}

/** A connection found while the reader was away: "Keep" and "Seems wrong" while it still stands. */
@Composable
internal fun FoundConnectionSheet(found: InquiryFound, state: ConnectionState, actions: ConnectionActions, onClose: () -> Unit, paused: Boolean = false) {
    SheetColumn {
        SheetHeader(stringResource(R.string.connection_back_atlas), stringResource(R.string.connection_kicker), onClose)
        SheetTitle(found)
        ConnectionEvidence(found)
        if (state.kept) Text(stringResource(R.string.connection_kept), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight(700))
        if (state.markedWrong) Text(stringResource(R.string.relic_state_doubted), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight(700))
        // Only an admitted connection can be kept or doubted; a withdrawn one is shown, not offered.
        val admitted = found.bridgeStatus == "admitted"
        // While recording is paused nothing new is kept (ADR-0030); a "seems wrong" is a correction and stays.
        if (admitted && paused && !state.kept && !state.markedWrong)
            Text(stringResource(R.string.connection_paused), style = MaterialTheme.typography.bodyMedium)
        if (admitted && !paused && !state.kept && !state.markedWrong && !state.keep.retryable()) {
            val keepDescription = stringResource(R.string.connection_keep_description)
            Button(
                onClick = { actions.onKeep(found.bridgeId) },
                enabled = state.keep !is ReturnActionState.Working,
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Teal, contentColor = Cosmos.Dark),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = keepDescription },
            ) { Text(stringResource(R.string.connection_keep), fontWeight = FontWeight(800), style = MaterialTheme.typography.labelLarge) }
        }
        ActionFeedback(state.keep, stringResource(R.string.connection_retry_keep_description)) { actions.onRetryKeep(found.bridgeId) }
        if (admitted && !state.markedWrong && !state.seemsWrong.retryable()) {
            val wrongDescription = stringResource(R.string.connection_seems_wrong_description)
            OutlinedButton(
                onClick = { actions.onSeemsWrong(found.bridgeId) },
                enabled = state.seemsWrong !is ReturnActionState.Working,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = wrongDescription },
            ) { Text(stringResource(R.string.connection_seems_wrong)) }
        }
        ActionFeedback(state.seemsWrong, stringResource(R.string.connection_retry_seems_wrong_description)) { actions.onRetrySeemsWrong(found.bridgeId) }
    }
}

/** A kept Relic: its state, when it was kept and by which validator, its kept form, and "Let go". */
@Composable
internal fun RelicSheet(relic: Relic, release: ReturnActionState, onLetGo: (String) -> Unit, onRetryLetGo: (String) -> Unit, onClose: () -> Unit) {
    SheetColumn {
        SheetHeader(stringResource(R.string.connection_back_keep), stringResource(R.string.relic_kicker), onClose)
        SheetTitle(relic.connection)
        Text(stringResource(relicStateRes(relic.state)), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight(700))
        Text(
            stringResource(R.string.relic_kept_on, humanDate(relic.keptAt), relic.provenance.validatorVersion),
            style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream,
        )
        ConnectionEvidence(relic.connection)
        if (!release.retryable()) {
            val letGoDescription = stringResource(R.string.relic_let_go_description)
            OutlinedButton(
                onClick = { onLetGo(relic.relicId) },
                enabled = release !is ReturnActionState.Working,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = letGoDescription },
            ) { Text(stringResource(R.string.relic_let_go)) }
        }
        ActionFeedback(release, stringResource(R.string.relic_retry_let_go_description)) { onRetryLetGo(relic.relicId) }
    }
}

private fun ReturnActionState.retryable(): Boolean = (this as? ReturnActionState.Failed)?.canRetry == true

@Composable
private fun SheetColumn(content: @Composable () -> Unit) {
    // The dock stays drawn over the sheet's lower edge: the last action scrolls clear of it.
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 120.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}

@Composable
private fun SheetHeader(backLabel: String, kicker: String, onClose: () -> Unit) {
    val closeDescription = stringResource(R.string.connection_close_description)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Surface(
            color = Cosmos.Cream.copy(alpha = 0.94f),
            contentColor = Cosmos.InkOnCream,
            shape = RoundedCornerShape(percent = 50),
            modifier = Modifier.heightIn(min = 48.dp)
                .clickable(onClickLabel = closeDescription, onClick = onClose)
                .semantics { contentDescription = closeDescription },
        ) {
            Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                Text(backLabel, fontWeight = FontWeight(800), style = MaterialTheme.typography.bodyMedium)
            }
        }
        Text(kicker, style = MaterialTheme.typography.labelLarge, color = Cosmos.MutedOnCream, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun SheetTitle(found: InquiryFound) {
    Text(
        stringResource(R.string.inquiry_pair, found.fromConcept.name, found.toConcept.name),
        style = MaterialTheme.typography.headlineMedium, color = Cosmos.InkOnCream,
        modifier = Modifier.fillMaxWidth().semantics { heading() },
    )
}

/** The bridge's sentence, any correction since, and each cited claim once -- never its source (#161). */
@Composable
private fun ConnectionEvidence(found: InquiryFound) {
    Text(found.sentence, style = MaterialTheme.typography.bodyLarge, color = Cosmos.InkOnCream)
    when (found.bridgeStatus) {
        "revoked" -> Text(stringResource(R.string.inquiry_found_revoked), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight(700))
        "superseded" -> Text(stringResource(R.string.inquiry_found_superseded), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight(700))
    }
    Text(stringResource(R.string.connection_evidence_heading), style = MaterialTheme.typography.labelLarge, color = Cosmos.MutedOnCream)
    found.evidence.distinctBy { it.statement }.forEach {
        Text(it.statement, style = MaterialTheme.typography.bodyMedium, color = Cosmos.InkOnCream)
    }
}

/** "Working…", or what failed -- with Retry of the same request only when it may have landed. */
@Composable
private fun ActionFeedback(state: ReturnActionState, retryDescription: String, onRetry: () -> Unit) {
    when (state) {
        ReturnActionState.Idle -> Unit
        ReturnActionState.Working -> Text(stringResource(R.string.privacy_working), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
        is ReturnActionState.Failed -> {
            Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
            if (state.canRetry)
                OutlinedButton(
                    onClick = onRetry,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
                ) { Text(stringResource(R.string.action_retry)) }
        }
    }
}
