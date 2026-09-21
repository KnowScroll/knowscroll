package com.knowscroll.mobile.ui.keep

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.Trace
import com.knowscroll.mobile.ui.UniverseState
import com.knowscroll.mobile.ui.common.BottomCompass
import com.knowscroll.mobile.ui.common.CompassTab
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos

/**
 * docs/product/ui-system.md section 5b: the dock's real destinations are "**Cable** (read),
 * **Atlas** (universe), **Keep** (Traces)" -- the same three the web build (#110) shipped. This
 * is that third destination: the real kept Traces (`GET /v1/universe`'s `traces`), the only
 * content this client is honestly able to put here (section 6). No invented history, no count
 * that is not the real list's own size.
 */
@Composable
fun KeepScreen(
    state: UniverseState,
    onOpenTrace: (Trace) -> Unit,
    onSelectAtlas: () -> Unit,
    onSelectCable: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Text(stringResource(R.string.keep_kicker), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
                    Text(stringResource(R.string.keep_title), style = MaterialTheme.typography.displayLarge, color = Cosmos.InkOnDark)
                    when (state) {
                        is UniverseState.Loading -> Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            CircularProgressIndicator(color = Cosmos.Teal, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.universe_loading), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                        }
                        is UniverseState.Unavailable -> Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                        is UniverseState.Loaded -> {
                            val traces = state.universe.traces
                            if (traces.isEmpty()) {
                                Text(stringResource(R.string.keep_empty), style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnDark)
                            } else {
                                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    traces.forEach { trace ->
                                        val traceDescription = stringResource(R.string.trace_revisit_action, trace.eventId)
                                        Surface(
                                            color = Cosmos.SpaceRaised,
                                            contentColor = Cosmos.InkOnDark,
                                            shape = MaterialTheme.shapes.medium,
                                            modifier = Modifier.fillMaxWidth()
                                                .clickable { onOpenTrace(trace) }
                                                .semantics { contentDescription = traceDescription }
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
                        }
                    }
                }
            }
            BottomCompass(
                selected = CompassTab.Keep,
                onSelectAtlas = onSelectAtlas,
                onSelectCable = onSelectCable,
                onSelectKeep = {}
            )
        }
    }
}
