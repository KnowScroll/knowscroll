package com.knowscroll.mobile.ui.scroll

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.DiscoveryState
import com.knowscroll.mobile.ui.KeepState
import com.knowscroll.mobile.ui.ScrollState
import com.knowscroll.mobile.ui.canRequestDiscovery
import com.knowscroll.mobile.ui.theme.Cosmos
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged

@Composable
fun ScrollScreen(
    state: ScrollState,
    onKeep: () -> Unit,
    onReturn: () -> Unit,
    onNext: () -> Unit,
    onRetry: () -> Unit,
    onReadingPosition: (String, Int) -> Unit,
    modifier: Modifier = Modifier
) {
    Box(modifier.fillMaxSize().background(Cosmos.Dark)) {
        when (state) {
            is ScrollState.Reading -> key(state.item.assetId) {
                ReadingSheet(state, onKeep, onReturn, onNext, onReadingPosition)
            }
            is ScrollState.Unavailable -> RestScreen(false, state.message, onReturn, onRetry)
            is ScrollState.Exhausted -> RestScreen(true, null, onReturn, onRetry)
            else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp)
            }
        }
    }
}

@Composable
private fun RestScreen(exhausted: Boolean, message: String?, onReturn: () -> Unit, onRetry: () -> Unit) {
    val homeDescription = stringResource(R.string.reader_home_description)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
        Text(stringResource(R.string.reader_origin), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
        Spacer(Modifier.height(24.dp))
        Text(
            stringResource(if (exhausted) R.string.reader_library_end else R.string.scroll_unavailable),
            style = MaterialTheme.typography.headlineMedium, color = if (exhausted) Cosmos.Cream else Cosmos.Coral
        )
        Text(message ?: stringResource(R.string.reader_library_end_detail), color = Cosmos.MutedOnDark)
        OutlinedButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(if (exhausted) R.string.reader_check_library else R.string.action_retry))
        }
        OutlinedButton(
            onClick = onReturn,
            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = homeDescription }
        ) { Text(stringResource(R.string.action_home)) }
    }
}

@Composable
private fun ReadingSheet(
    state: ScrollState.Reading,
    onKeep: () -> Unit,
    onReturn: () -> Unit,
    onNext: () -> Unit,
    onReadingPosition: (String, Int) -> Unit
) {
    val contentLabel = stringResource(R.string.reader_content_description)
    val item = state.item
    val readingScroll = rememberScrollState(state.readingPosition)
    val positionDescription = stringResource(R.string.reader_position_description, readingScroll.value)
    var sourcesOpen by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(item.assetId, readingScroll) {
        snapshotFlow { readingScroll.value }.distinctUntilChanged().collectLatest {
            delay(200)
            onReadingPosition(item.assetId, it)
        }
    }
    DisposableEffect(item.assetId, readingScroll) {
        onDispose { onReadingPosition(item.assetId, readingScroll.value) }
    }
    BackHandler(enabled = sourcesOpen) { sourcesOpen = false }

    Column(Modifier.fillMaxSize()) {
        Text(
            stringResource(R.string.reader_origin),
            style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark,
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 14.dp)
        )
        Surface(
            color = Cosmos.Cream, contentColor = Cosmos.InkOnCream,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            modifier = Modifier.weight(1f).fillMaxWidth()
        ) {
            Column(Modifier.fillMaxSize()) {
                Column(
                    Modifier.weight(1f).fillMaxWidth().verticalScroll(readingScroll)
                        .semantics {
                            contentDescription = contentLabel
                            stateDescription = positionDescription
                        }.padding(horizontal = 24.dp, vertical = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp)
                ) {
                    Text(
                        stringResource(R.string.reader_truth_label, item.truthState.uppercase()),
                        style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream
                    )
                    Text(item.title, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
                    if (item.reason.isNotBlank()) Text(item.reason, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
                    Text(item.summary, style = MaterialTheme.typography.titleMedium, color = Cosmos.MutedOnCream)
                    Text(item.body, style = MaterialTheme.typography.bodyLarge)
                    HorizontalDivider(color = Cosmos.CreamDim)
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.reader_source_marker), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
                        Text(item.sourceTitle, style = MaterialTheme.typography.bodyMedium)
                        Text(stringResource(R.string.reader_attribution_note), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
                    }
                    DiscoveryThreshold(state.keep, state.discovery, onNext)
                }
                ReaderControls(state.keep, state.discovery, onKeep, onReturn) { sourcesOpen = true }
            }
        }
    }
    if (sourcesOpen) SourceSheet(item) { sourcesOpen = false }
}

@Composable
private fun DiscoveryThreshold(keep: KeepState, state: DiscoveryState, onNext: () -> Unit) {
    val nextDescription = stringResource(R.string.reader_next_description)
    Surface(color = Cosmos.CreamDim, contentColor = Cosmos.InkOnCream, shape = RoundedCornerShape(20.dp)) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                stringResource(if (state is DiscoveryState.Exhausted) R.string.reader_library_end else R.string.reader_threshold_title),
                style = MaterialTheme.typography.titleLarge
            )
            Text(
                stringResource(when (state) {
                    DiscoveryState.Failed -> R.string.reader_next_failed
                    DiscoveryState.Exhausted -> R.string.reader_library_end_detail
                    else -> R.string.reader_threshold_detail
                }),
                style = MaterialTheme.typography.bodyMedium,
                color = if (state is DiscoveryState.Failed) Cosmos.InkOnCream else Cosmos.MutedOnCream
            )
            if (state is DiscoveryState.Loading) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Cosmos.Dark, strokeWidth = 2.dp)
                    Text(stringResource(R.string.reader_next_loading), style = MaterialTheme.typography.bodyMedium)
                }
            }
            Button(
                onClick = onNext,
                enabled = canRequestDiscovery(keep, state),
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Dark, contentColor = Cosmos.Cream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .semantics { contentDescription = nextDescription }
            ) {
                Text(stringResource(when (state) {
                    DiscoveryState.Failed -> R.string.reader_next_retry
                    DiscoveryState.Exhausted -> R.string.reader_check_library
                    else -> R.string.action_next
                }))
            }
        }
    }
}

@Composable
private fun ReaderControls(keep: KeepState, discovery: DiscoveryState, onKeep: () -> Unit, onReturn: () -> Unit, onSources: () -> Unit) {
    val homeDescription = stringResource(R.string.reader_home_description)
    val keepDescription = stringResource(R.string.reader_keep_description)
    val sourcesDescription = stringResource(R.string.reader_sources_description)
    val keepLabel = stringResource(when (keep) {
        is KeepState.Kept -> R.string.action_kept
        is KeepState.Saving -> R.string.reader_keep_pending
        else -> R.string.action_keep
    })
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (keep is KeepState.Failed || keep is KeepState.Conflict) Text(
            if (keep is KeepState.Failed) keep.message else (keep as KeepState.Conflict).message,
            color = Cosmos.InkOnCream, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 12.dp)
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(
                onClick = onReturn,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).semantics { contentDescription = homeDescription },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream)
            ) { Text(stringResource(R.string.action_home)) }
            Button(
                onClick = onKeep,
                enabled = keep !is KeepState.Saving && keep !is KeepState.Kept && discovery !is DiscoveryState.Loading,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).semantics { contentDescription = keepDescription },
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Teal, contentColor = Cosmos.Dark)
            ) { Text(keepLabel) }
            TextButton(
                onClick = onSources,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).semantics { contentDescription = sourcesDescription },
                colors = ButtonDefaults.textButtonColors(contentColor = Cosmos.InkOnCream)
            ) { Text(stringResource(R.string.action_sources)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SourceSheet(item: ScrollItem, onDismiss: () -> Unit) {
    val openDescription = stringResource(R.string.reader_open_source_description, item.sourceTitle)
    val closeDescription = stringResource(R.string.reader_close_sources_description)
    val context = LocalContext.current
    var browserUnavailable by remember { mutableStateOf(false) }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Cosmos.Cream, contentColor = Cosmos.InkOnCream
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(stringResource(R.string.reader_source_sheet_title), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
            Text(item.title, style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.reader_truth_label, item.truthState.uppercase()), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnCream)
            Text(item.sourceTitle, style = MaterialTheme.typography.titleLarge)
            Text(item.sourceUrl, style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.reader_attribution_note), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
            Button(
                onClick = {
                    browserUnavailable = runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(item.sourceUrl)))
                    }.isFailure
                },
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Dark, contentColor = Cosmos.Cream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .semantics { contentDescription = openDescription }
            ) { Text(stringResource(R.string.action_open_source)) }
            if (browserUnavailable) Text(stringResource(R.string.reader_browser_unavailable), color = Cosmos.InkOnCream)
            OutlinedButton(
                onClick = onDismiss,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.InkOnCream),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = closeDescription }
            ) { Text(stringResource(R.string.reader_close_sources)) }
        }
    }
}
