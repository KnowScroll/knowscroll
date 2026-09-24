package com.knowscroll.mobile.ui.system

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.ui.AtlasEvidenceState
import com.knowscroll.mobile.ui.theme.Cosmos

/**
 * #134 review I3/I2 — the Places layer's own "List" sheet content (`SpatialAtlas`'s
 * `listSheetContent` slot): every live place, planets first and each of their regions/sightings
 * indented under it regardless of nesting depth (`placeListRows`) -- `regionAreasOf`/the map only
 * ever draw a planet's *direct* regions and a sighting whose parent is a planet marker, so a region
 * inside a region, or a sighting of one, is otherwise never reachable. Each row opens that place's
 * own sheet. A system-wide "Recent changes" list follows, every chronicle line the atlas carries --
 * including one for a place that is no longer live (set aside, retired) -- each opening its evidence.
 */
@Composable
internal fun PlacesListSheetContent(
    atlas: AtlasResponse,
    evidenceState: AtlasEvidenceState,
    onOpenEvidence: (String) -> Unit,
    onOpenPlace: (placeId: String) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        placeListRows(atlas.places).forEach { row ->
            val kindPrefix = when (row.kind) {
                "sighting" -> "Sighting: "
                "region" -> "Region: "
                else -> ""
            }
            OutlinedButton(
                onClick = { onOpenPlace(row.placeId) },
                modifier =
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = (row.depth * 16).dp),
            ) {
                Column(Modifier.fillMaxWidth()) {
                    Text("$kindPrefix${row.name}")
                    Text(row.detail, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        if (atlas.chronicle.isNotEmpty()) {
            Text(
                "Recent changes",
                style = MaterialTheme.typography.labelLarge,
                color = Cosmos.InkOnCream,
                modifier = Modifier.padding(top = 8.dp),
            )
            atlas.chronicle.forEach { entry -> ChronicleLine(entry.deltaId, entry.line, evidenceState, onOpenEvidence) }
        }
    }
}
