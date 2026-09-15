package com.knowscroll.mobile.ui.universe

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.Universe
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos

@Composable
fun UniverseScreen(state: UniverseState, onEnterScroll: () -> Unit, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            Text("KNOWSCROLL", style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Text(stringResource(R.string.universe_title), style = MaterialTheme.typography.displayLarge, color = Cosmos.InkOnDark)
            when (state) {
                is UniverseState.Loading -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.universe_loading), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                }
                is UniverseState.Unavailable -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.universe_unavailable), style = MaterialTheme.typography.titleLarge, color = Cosmos.Coral)
                    Text(stringResource(R.string.universe_unavailable_help), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                    Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                    OutlinedButton(
                        onClick = onRetry,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                        modifier = Modifier.semantics { contentDescription = "Retry loading the universe" }
                    ) { Text(stringResource(R.string.action_retry)) }
                }
                is UniverseState.Loaded -> LoadedBlock(state.universe, onEnterScroll)
            }
        }
    }
}

@Composable
private fun LoadedBlock(universe: Universe, onEnterScroll: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        if (universe.traces.isEmpty()) {
            Text(stringResource(R.string.universe_empty), style = MaterialTheme.typography.bodyLarge, color = Cosmos.MutedOnDark)
        } else {
            Text(stringResource(R.string.traces_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            LazyColumn(
                modifier = Modifier.fillMaxWidth().height(280.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(vertical = 4.dp)
            ) {
                items(items = universe.traces, key = { it.eventId }) { trace ->
                    Surface(
                        color = Color(0xFF0A1B26),
                        contentColor = Cosmos.InkOnDark,
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Box(modifier = Modifier.size(8.dp).background(Cosmos.Yellow, CircleShape))
                            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(
                                    trace.title.ifBlank { stringResource(R.string.trace_unknown_title) },
                                    style = MaterialTheme.typography.titleMedium, color = Cosmos.InkOnDark
                                )
                                Text(trace.createdAt, style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
                            }
                        }
                    }
                }
            }
        }
        Spacer(modifier = Modifier.height(8.dp))
        Button(
            onClick = onEnterScroll,
            colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Teal, contentColor = Cosmos.Dark),
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Enter Scroll" }
        ) { Text(stringResource(R.string.action_enter_scroll), style = MaterialTheme.typography.titleMedium) }
    }
}
