package com.knowscroll.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.ui.theme.*

/** Explicit admitted kind; selecting does not itself record an exposure. */
@Composable
fun CableControls(mode: String, onMode: (String) -> Unit, onPreview: (() -> Unit)? = null) {
    PosterTheme {
        Surface(color = Poster.Paper, contentColor = Poster.Ink) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                Row(
                    Modifier.fillMaxWidth().selectableGroup(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf("Scroll", "Reel").forEach { kind ->
                        Surface(
                            color = if (kind == mode) Poster.Cobalt else Poster.Paper,
                            contentColor = if (kind == mode) Poster.Paper else Poster.Ink,
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(2.dp, Poster.Ink),
                            modifier =
                                Modifier.weight(1f)
                                    .heightIn(min = 48.dp)
                                    .selectable(kind == mode, role = Role.Tab) { onMode(kind) }
                                    .semantics {
                                        contentDescription = "Cable $kind"
                                        stateDescription =
                                            if (kind == mode) "Active" else "Inactive"
                                    },
                        ) {
                            Box(
                                Modifier.padding(12.dp),
                                contentAlignment = androidx.compose.ui.Alignment.Center,
                            ) {
                                Text(kind, style = MaterialTheme.typography.titleMedium)
                            }
                        }
                    }
                }
                if (onPreview != null)
                    TextButton(
                        onClick = onPreview,
                        modifier =
                            Modifier.semantics {
                                contentDescription = "Open authored interaction preview"
                            },
                        contentPadding = PaddingValues(vertical = 0.dp),
                    ) {
                        Text(
                            "Authored preview →",
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
            }
        }
    }
}
