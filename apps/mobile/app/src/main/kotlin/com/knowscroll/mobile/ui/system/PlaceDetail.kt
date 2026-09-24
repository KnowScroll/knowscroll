package com.knowscroll.mobile.ui.system

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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.data.AtlasPlace
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.ui.AtlasEvidenceState
import com.knowscroll.mobile.ui.PlaceRejectState
import com.knowscroll.mobile.ui.theme.Cosmos

/* #134: the reader's place sheet (ADR-0036) -- a place, what led to it, its sightings and the
 * reader's "set aside". Split from SystemScreen.kt, which keeps the source-world sheet. */
/**
 * #134: the reader's own place sheet, reusing [WorldDetail]'s pattern (back pill, headline, body,
 * a `verticalScroll` column) for a planet or region instead of a source world: its basis-formed
 * sightings, its typed relations to other live places, its chronicle and each line's evidence, and
 * "Set aside" for the whole place.
 */
@Composable
internal fun PlaceDetail(
    place: AtlasPlace,
    atlas: AtlasResponse,
    rejectState: PlaceRejectState,
    evidenceState: AtlasEvidenceState,
    onClose: () -> Unit,
    onRequestSetAside: (String) -> Unit,
    onCancelSetAside: () -> Unit,
    onConfirmSetAside: () -> Unit,
    onOpenEvidence: (String) -> Unit,
    onCloseEvidence: () -> Unit,
) {
    val sightings = atlas.places.filter { it.kind == "sighting" && it.parentPlaceId == place.placeId }
    val connections = placeConnections(place, atlas)
    val chronicle = chronicleFor(atlas, place.placeId)
    val attention = place.attention
    Surface(
        color = androidx.compose.ui.graphics.Color.Transparent,
        contentColor = Cosmos.InkOnCream,
        shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            Modifier.fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Surface(
                    color = Cosmos.Cream.copy(alpha = 0.94f),
                    contentColor = Cosmos.InkOnCream,
                    shape = RoundedCornerShape(percent = 50),
                    modifier =
                        Modifier.heightIn(min = 48.dp)
                            .clickable(onClickLabel = "Close place detail and return to the system") { onCloseEvidence(); onClose() }
                            .semantics { contentDescription = "Close place detail and return to the system" },
                ) {
                    Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                        Text("‹ System", fontWeight = FontWeight(800), style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Text(
                    if (place.kind == "region") "Region" else "Place",
                    style = MaterialTheme.typography.labelLarge,
                    color = Cosmos.MutedOnCream,
                    modifier = Modifier.weight(1f),
                )
            }
            Text(
                place.anchor.name,
                style = MaterialTheme.typography.headlineLarge,
                color = Cosmos.InkOnCream,
                modifier = Modifier.fillMaxWidth().semantics { heading() },
            )
            Text(place.anchor.description, style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
            place.basis?.let { basis ->
                // Only a sighting carries its own basis -- what it connects to and why it is offered.
                Text(basisSentence(basis), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight(700))
                val support = basis.claim?.let { "\"${it.text}\" — ${it.sourceTitle}" } ?: basis.bridge?.mechanism
                if (support != null) Text(support, style = MaterialTheme.typography.bodySmall, color = Cosmos.MutedOnCream)
            }
            if (attention != null)
                Text(
                    "Read on ${attention.daysActive} ${if (attention.daysActive == 1) "day" else "days"} · " +
                        "${attention.sourceFamilies} ${if (attention.sourceFamilies == 1) "source" else "sources"}",
                    style = MaterialTheme.typography.labelLarge,
                    color = Cosmos.MutedOnCream,
                )
            Text(placeMarkerDetail(place), style = MaterialTheme.typography.labelLarge, color = Cosmos.MutedOnCream)

            val holdsUp = holdsUpLine(place, atlas.places)
            val foundation = place.foundation
            if (holdsUp != null && foundation != null) {
                Text("Foundation", style = MaterialTheme.typography.labelLarge, color = Cosmos.InkOnCream)
                Text(holdsUp, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight(700))
                foundation.relations.forEach { relation ->
                    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(basisSentence(relation), style = MaterialTheme.typography.bodyMedium)
                        val support = relation.claim?.let { "\"${it.text}\" — ${it.sourceTitle}" } ?: relation.bridge?.mechanism
                        if (support != null) Text(support, style = MaterialTheme.typography.bodySmall, color = Cosmos.MutedOnCream)
                    }
                }
            }

            if (sightings.isNotEmpty()) {
                Text("Sightings", style = MaterialTheme.typography.labelLarge, color = Cosmos.InkOnCream)
                sightings.forEach { sighting ->
                    val basis = sighting.basis
                    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(sighting.anchor.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight(700))
                        if (basis != null) {
                            Text(basisSentence(basis), style = MaterialTheme.typography.bodyMedium)
                            val support = basis.claim?.let { "\"${it.text}\" — ${it.sourceTitle}" } ?: basis.bridge?.mechanism
                            if (support != null) Text(support, style = MaterialTheme.typography.bodySmall, color = Cosmos.MutedOnCream)
                        }
                    }
                }
            }

            if (connections.isNotEmpty()) {
                Text("Connections", style = MaterialTheme.typography.labelLarge, color = Cosmos.InkOnCream)
                connections.forEach { (sentence, relation) ->
                    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(sentence, style = MaterialTheme.typography.bodyMedium)
                        val support = relation.claim?.let { "\"${it.text}\" — ${it.sourceTitle}" } ?: relation.bridge?.mechanism
                        if (support != null) Text(support, style = MaterialTheme.typography.bodySmall, color = Cosmos.MutedOnCream)
                    }
                }
            }

            if (chronicle.isNotEmpty()) {
                Text("What happened here", style = MaterialTheme.typography.labelLarge, color = Cosmos.InkOnCream)
                chronicle.forEach { entry -> ChronicleLine(entry.deltaId, entry.line, evidenceState, onOpenEvidence) }
            }

            // A sighting cannot be set aside (the server refuses it) -- only its own sheet, opened
            // from the Places list, would otherwise show a button that quietly does nothing.
            if (place.kind != "sighting")
                PlaceSetAside(place, rejectState, onRequestSetAside, onCancelSetAside, onConfirmSetAside)
        }
    }
}

/** Reused by the system-level "Recent changes" list (`PlacesListSheet.kt`) so every chronicle line
 * -- for a place still live or one that is now gone -- opens its evidence the same way. */
@Composable
internal fun ChronicleLine(
    deltaId: String,
    line: String,
    evidenceState: AtlasEvidenceState,
    onOpenEvidence: (String) -> Unit,
) {
    val open = evidenceState is AtlasEvidenceState.Loaded && evidenceState.deltaId == deltaId
    val loading = evidenceState is AtlasEvidenceState.Loading && evidenceState.deltaId == deltaId
    val failed = (evidenceState as? AtlasEvidenceState.Failed)?.takeIf { it.deltaId == deltaId }
    Column(Modifier.padding(vertical = 2.dp)) {
        Text(
            line,
            style = MaterialTheme.typography.bodyMedium,
            color = Cosmos.InkOnCream,
            modifier =
                Modifier.clickable(onClickLabel = if (open) "Hide evidence" else "Show evidence") { onOpenEvidence(deltaId) }
                    .heightIn(min = 48.dp)
                    .semantics { contentDescription = "${if (open) "Hide" else "Show"} evidence: $line" },
        )
        if (loading)
            Text("Loading evidence…", style = MaterialTheme.typography.bodySmall, color = Cosmos.MutedOnCream)
        else if (failed != null)
            Text(failed.message, style = MaterialTheme.typography.bodySmall, color = Cosmos.Coral)
        else if (open && evidenceState is AtlasEvidenceState.Loaded)
            Text(evidenceSummary(evidenceState.delta), style = MaterialTheme.typography.bodySmall, color = Cosmos.MutedOnCream)
    }
}

/** "Set aside" on a live planet/region, with the confirmation step the brief names verbatim. */
@Composable
private fun PlaceSetAside(
    place: AtlasPlace,
    rejectState: PlaceRejectState,
    onRequestSetAside: (String) -> Unit,
    onCancelSetAside: () -> Unit,
    onConfirmSetAside: () -> Unit,
) {
    val confirming = (rejectState as? PlaceRejectState.Confirming)?.takeIf { it.placeId == place.placeId }
    val sending = (rejectState as? PlaceRejectState.Sending)?.takeIf { it.placeId == place.placeId }
    val failed = (rejectState as? PlaceRejectState.Failed)?.takeIf { it.placeId == place.placeId }
    if (confirming != null || sending != null) {
        Text(
            "Set ${place.anchor.name} aside? It won't form again unless you clear your history.",
            style = MaterialTheme.typography.bodyMedium,
            color = Cosmos.InkOnCream,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = onConfirmSetAside,
                colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Coral, contentColor = Cosmos.Dark),
                modifier =
                    Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Confirm setting ${place.anchor.name} aside" },
            ) { Text(if (sending != null) "Setting aside…" else "Set aside", fontWeight = FontWeight(800)) }
            OutlinedButton(
                onClick = onCancelSetAside,
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Cancel setting aside" },
            ) { Text("Cancel") }
        }
    } else {
        OutlinedButton(
            onClick = { onRequestSetAside(place.placeId) },
            modifier =
                Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Set ${place.anchor.name} aside" },
        ) { Text("Set aside") }
        if (failed != null)
            Text(failed.message, style = MaterialTheme.typography.labelMedium, color = Cosmos.Coral)
    }
}
