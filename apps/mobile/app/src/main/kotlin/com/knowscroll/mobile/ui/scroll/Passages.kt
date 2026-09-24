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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.RelicTarget
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.keep.KeepChoices
import com.knowscroll.mobile.ui.keep.KeepControls
import com.knowscroll.mobile.ui.keep.PassagesState
import com.knowscroll.mobile.ui.keep.Withdrawn
import com.knowscroll.mobile.ui.theme.Cosmos

/** #165 — ADR-0044: the passages of the Scroll on screen, and Keep and "Seems wrong" on each. */
data class PassagesControls(
    val state: PassagesState = PassagesState.Loading,
    val keeps: KeepControls = KeepControls(),
    /** Reads the passages of the Scroll with this asset id. */
    val onOpen: (String) -> Unit = {},
)

/**
 * #165 — ADR-0044: what the Scroll on screen says, one claim at a time, each with Keep (a passage
 * Relic: that claim, at the revision the reader read) and "Seems wrong". A claim whose support was
 * withdrawn is marked and not offered; a Scroll revised since it was read offers nothing until it is
 * read again. Only the claims are shown -- never where a claim came from (#161).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PassagesSheet(item: ScrollItem, controls: PassagesControls, onDismiss: () -> Unit) {
    val closeDescription = stringResource(R.string.passages_close_description)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Cosmos.Cream, contentColor = Cosmos.InkOnCream,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.passages_sheet_title), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.passages_explanation), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
            when (val state = controls.state) {
                PassagesState.Loading -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Cosmos.Dark, strokeWidth = 2.dp)
                    Text(stringResource(R.string.passages_loading), style = MaterialTheme.typography.bodyMedium)
                }
                is PassagesState.Unavailable -> {
                    Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                    val retryDescription = stringResource(R.string.passages_retry_description)
                    OutlinedButton(
                        onClick = { controls.onOpen(item.assetId) },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
                    ) { Text(stringResource(R.string.action_retry)) }
                }
                is PassagesState.Loaded -> {
                    val response = state.response
                    // A passage is kept only at the revision the reader read.
                    val asRead = response.revision == item.revision
                    if (!asRead) Text(stringResource(R.string.passages_changed), style = MaterialTheme.typography.bodyMedium)
                    if (response.passages.isEmpty()) Text(stringResource(R.string.passages_empty), style = MaterialTheme.typography.bodyMedium)
                    if (asRead && controls.keeps.paused) Text(stringResource(R.string.connection_paused), style = MaterialTheme.typography.bodyMedium)
                    response.passages.forEach { passage ->
                        HorizontalDivider(color = Cosmos.CreamDim)
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(passage.statement, style = MaterialTheme.typography.bodyLarge)
                            if (passage.withdrawn) Withdrawn()
                            KeepChoices(RelicTarget.Passage(item.assetId, item.revision, passage.claimKey), controls.keeps, offered = asRead && !passage.withdrawn, sayPaused = false)
                        }
                    }
                }
            }
            OutlinedButton(
                onClick = onDismiss,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = closeDescription },
            ) { Text(stringResource(R.string.passages_close)) }
        }
    }
}
