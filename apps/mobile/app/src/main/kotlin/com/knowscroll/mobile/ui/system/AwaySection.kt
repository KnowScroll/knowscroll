package com.knowscroll.mobile.ui.system

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.AwayItem
import com.knowscroll.mobile.data.InquiryFound
import com.knowscroll.mobile.ui.keep.AwayState
import com.knowscroll.mobile.ui.keep.ReturnActionState
import com.knowscroll.mobile.ui.keep.awayHiddenCount
import com.knowscroll.mobile.ui.keep.awayItemLine
import com.knowscroll.mobile.ui.theme.Cosmos

/** What the Atlas's return section shows and offers; every decision is `ReturnViewModel`'s. */
data class AwayControls(
    val state: AwayState,
    val acknowledge: ReturnActionState,
    val onMarkSeen: () -> Unit,
    val onRetryMarkSeen: () -> Unit,
    /** Reading the next earlier page (ADR-0044 M7). */
    val earlier: ReturnActionState = ReturnActionState.Idle,
    val onShowEarlier: () -> Unit = {},
)

/** At most this many items before "and N more". */
internal const val AWAY_COLLAPSED_ITEMS = 3

/** The found connection an open sheet shows, while the list still carries it. */
internal fun awayFound(state: AwayState, bridgeId: String): InquiryFound? =
    (state as? AwayState.Loaded)?.response?.items?.firstNotNullOfOrNull { (it as? AwayItem.ConnectionFound)?.found?.takeIf { f -> f.bridgeId == bridgeId } }

/**
 * #134 (ADR-0039 §1, §6): a quiet "While you were away" at the top of the Places layer, shown only
 * when something is unacknowledged -- nothing at all while loading, when empty, or when the list
 * could not be read (the map is not the place for that noise). Each item is one plain line from its
 * type and fields; a found connection opens its evidence. "Mark as seen" acknowledges through the
 * newest item shown, and while recording is paused it is replaced by a line saying why it stays.
 * At most [AWAY_COLLAPSED_ITEMS] lines until the reader asks for the rest, so the map keeps its room;
 * then earlier items a page at a time, so none is out of reach (ADR-0044 M7). The heading is read
 * once: the section carries no description of its own that would repeat it (M8).
 */
@Composable
internal fun AwaySection(controls: AwayControls, onOpenConnection: (String) -> Unit, modifier: Modifier = Modifier) {
    val response = (controls.state as? AwayState.Loaded)?.response ?: return
    if (response.items.isEmpty()) return
    var expanded by rememberSaveable { mutableStateOf(false) }
    Surface(
        color = Cosmos.Sea2, contentColor = Cosmos.InkOnDark, shape = RoundedCornerShape(16.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.away_heading), style = MaterialTheme.typography.titleMedium, color = Cosmos.Cream,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                if (!response.recordingPaused) {
                    val markDescription = stringResource(R.string.away_mark_seen_description)
                    OutlinedButton(
                        onClick = controls.onMarkSeen,
                        enabled = controls.acknowledge !is ReturnActionState.Working,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = markDescription },
                    ) { Text(stringResource(R.string.away_mark_seen)) }
                }
            }
            if (response.recordingPaused)
                Text(stringResource(R.string.away_paused), style = MaterialTheme.typography.bodyMedium, color = Cosmos.Yellow)
            when (val ack = controls.acknowledge) {
                ReturnActionState.Idle -> Unit
                ReturnActionState.Working -> Text(stringResource(R.string.privacy_working), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                is ReturnActionState.Failed -> {
                    Text(ack.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                    if (ack.canRetry) {
                        val retryDescription = stringResource(R.string.away_retry_mark_seen_description)
                        OutlinedButton(
                            onClick = controls.onRetryMarkSeen,
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
                        ) { Text(stringResource(R.string.action_retry)) }
                    }
                }
            }
            val shown = if (expanded) response.items else response.items.take(AWAY_COLLAPSED_ITEMS)
            Column(if (expanded) Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()) else Modifier) {
                shown.forEach { AwayLine(it, onOpenConnection) }
                if (expanded && response.nextPage != null) EarlierPage(response.more, controls.earlier, controls.onShowEarlier)
            }
            val hidden = awayHiddenCount(response.items.size, shown.size, response.more)
            if (!expanded && hidden > 0) {
                val moreDescription = stringResource(R.string.away_more_description)
                TextButton(
                    onClick = { expanded = true },
                    colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.Teal),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = moreDescription },
                ) { Text(stringResource(R.string.away_more, hidden)) }
            } else if (expanded && response.items.size > AWAY_COLLAPSED_ITEMS) {
                val fewerDescription = stringResource(R.string.away_fewer_description)
                TextButton(
                    onClick = { expanded = false },
                    colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.Teal),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = fewerDescription },
                ) { Text(stringResource(R.string.away_fewer)) }
            }
        }
    }
}

/** "Show N earlier": the next page, read on request; a failed read says so and offers the read again. */
@Composable
private fun EarlierPage(more: Long, earlier: ReturnActionState, onShowEarlier: () -> Unit) {
    when (earlier) {
        is ReturnActionState.Failed -> {
            Text(earlier.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
            val retryDescription = stringResource(R.string.away_retry_earlier_description)
            OutlinedButton(
                onClick = onShowEarlier,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
            ) { Text(stringResource(R.string.action_retry)) }
        }
        else -> {
            val earlierDescription = stringResource(R.string.away_earlier_description)
            TextButton(
                onClick = onShowEarlier,
                enabled = earlier !is ReturnActionState.Working,
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.Teal),
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = earlierDescription },
            ) { Text(stringResource(R.string.away_earlier, more)) }
        }
    }
}

/** One plain line; a found connection's is a 48dp target that opens its evidence. */
@Composable
private fun AwayLine(item: AwayItem, onOpenConnection: (String) -> Unit) {
    val line = awayItemLine(item, LocalContext.current)
    if (item is AwayItem.ConnectionFound) {
        val openLabel = stringResource(R.string.away_open_connection)
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClickLabel = openLabel) { onOpenConnection(item.found.bridgeId) },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(line, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Cream, modifier = Modifier.weight(1f))
            // A visual cue only: the row's click label already says it opens the evidence.
            Text("›", style = MaterialTheme.typography.titleMedium, color = Cosmos.Teal, modifier = Modifier.clearAndSetSemantics {})
        }
    } else {
        Text(line, style = MaterialTheme.typography.bodyMedium, color = Cosmos.InkOnDark, modifier = Modifier.padding(vertical = 6.dp))
    }
}
