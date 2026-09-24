package com.knowscroll.mobile.ui.keep

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.Relic
import com.knowscroll.mobile.ui.theme.Cosmos
import com.knowscroll.mobile.ui.theme.Poster

/** What Keep's Relics show and offer; every decision is [ReturnViewModel]'s. */
data class RelicControls(
    val state: RelicsState,
    /** "Let go", by Relic id. */
    val releases: Map<String, ReturnActionState>,
    val onLetGo: (String) -> Unit,
    val onRetryLetGo: (String) -> Unit,
    val onRetryLoad: () -> Unit,
)

/**
 * #134 (ADR-0039 §4, §6): Keep lists Relics above Traces, each with its state -- a correction is
 * never hidden, and neither is the reader's own doubt. Nothing at all when there are none (Traces
 * keep their own empty line) or while loading; a failed load says so, since silence would read as
 * "no Relics". Rendering only; tapping a card opens [RelicSheet].
 */
@Composable
internal fun RelicsSection(controls: RelicControls, onOpen: (String) -> Unit) {
    when (val state = controls.state) {
        RelicsState.Loading -> Unit
        is RelicsState.Unavailable -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
            val retryDescription = stringResource(R.string.relics_retry_description)
            OutlinedButton(
                onClick = controls.onRetryLoad,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Poster.Ink),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
            ) { Text(stringResource(R.string.action_retry)) }
        }
        is RelicsState.Loaded -> {
            val relics = state.response.relics
            if (relics.isNotEmpty()) Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    stringResource(R.string.relics_heading), style = MaterialTheme.typography.titleLarge, color = Poster.Ink,
                    modifier = Modifier.semantics { heading() },
                )
                relics.forEach { RelicCard(it, onOpen) }
            }
        }
    }
}

/** A Trace card's poster form, titled by the two places, with the Relic's state beneath. */
@Composable
private fun RelicCard(relic: Relic, onOpen: (String) -> Unit) {
    val from = relic.connection.fromConcept.name
    val to = relic.connection.toConcept.name
    val description = stringResource(R.string.relic_description, from, to)
    val stateLine = stringResource(relicStateRes(relic.state))
    Surface(
        color = Poster.Paper,
        border = BorderStroke(2.dp, Poster.Ink),
        contentColor = Poster.Ink,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .clickable { onOpen(relic.relicId) }
            // The title names it; the state is announced with it, so TalkBack never drops a correction.
            .semantics { contentDescription = description; stateDescription = stateLine },
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val marker = when (relic.state) {
                "corrected" -> Cosmos.Coral
                "doubted" -> Poster.Muted
                else -> Cosmos.Teal
            }
            Box(modifier = Modifier.size(8.dp).background(marker, CircleShape))
            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(R.string.inquiry_pair, from, to), style = MaterialTheme.typography.titleMedium, color = Poster.Ink)
                Text(stateLine, style = MaterialTheme.typography.bodyMedium, color = if (relic.state == "current") Poster.Muted else Poster.Ink)
            }
        }
    }
}
