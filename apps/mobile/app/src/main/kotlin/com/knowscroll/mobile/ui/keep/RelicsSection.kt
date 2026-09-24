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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
    /** Reading the next older page (ADR-0044 M8). */
    val older: ReturnActionState = ReturnActionState.Idle,
    val onShowOlder: () -> Unit = {},
)

/**
 * #134/#165 (ADR-0039 §4, §6; ADR-0044): Keep lists Relics above Traces -- connections, places,
 * passages and answers -- each with its kind and state: a correction is never hidden, and neither is
 * the reader's own doubt. Older Relics are a page away, so the oldest can still be let go. Nothing at
 * all when there are none (Traces keep their own empty line) or while loading; a failed load says
 * so, since silence would read as "no Relics". Rendering only; tapping a card opens [RelicSheet].
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
            val response = state.response
            if (response.relics.isNotEmpty()) Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    stringResource(R.string.relics_heading), style = MaterialTheme.typography.titleLarge, color = Poster.Ink,
                    modifier = Modifier.semantics { heading() },
                )
                response.relics.forEach { RelicCard(it, onOpen) }
                if (response.nextPage != null && controls.older !is ReturnActionState.Failed) {
                    val olderDescription = stringResource(R.string.relics_older_description)
                    TextButton(
                        onClick = controls.onShowOlder,
                        enabled = controls.older !is ReturnActionState.Working,
                        colors = ButtonDefaults.textButtonColors(contentColor = Poster.Ink),
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = olderDescription },
                    ) { Text(stringResource(R.string.relics_older)) }
                }
                ActionFeedback(controls.older, stringResource(R.string.relics_retry_older_description), controls.onShowOlder)
            }
        }
    }
}

/** A Trace card's poster form: the Relic's kind, what it keeps, and its state beneath. */
@Composable
private fun RelicCard(relic: Relic, onOpen: (String) -> Unit) {
    val context = LocalContext.current
    val description = relicDescription(relic, context)
    val stateLine = stringResource(relicStateRes(relic))
    val openLabel = stringResource(R.string.relic_open_label)
    Surface(
        color = Poster.Paper,
        border = BorderStroke(2.dp, Poster.Ink),
        contentColor = Poster.Ink,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            // M8: the click says what it does, not only what the card is.
            .clickable(onClickLabel = openLabel) { onOpen(relic.relicId) }
            // The description names it; the state is announced with it, so TalkBack never drops a correction.
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
                Text(stringResource(relicKindRes(relic)), style = MaterialTheme.typography.labelMedium, color = Poster.Muted)
                Text(relicTitle(relic, context), style = MaterialTheme.typography.titleMedium, color = Poster.Ink, maxLines = 3)
                Text(stateLine, style = MaterialTheme.typography.bodyMedium, color = if (relic.state == "current") Poster.Muted else Poster.Ink)
            }
        }
    }
}
