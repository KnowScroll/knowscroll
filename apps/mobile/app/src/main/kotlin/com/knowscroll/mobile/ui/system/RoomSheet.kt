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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.data.RoomChronicleEntry
import com.knowscroll.mobile.data.RoomDetail
import com.knowscroll.mobile.ui.RoomSetAsideState
import com.knowscroll.mobile.ui.RoomState
import com.knowscroll.mobile.ui.theme.Cosmos

/** What the room sheet shows and offers (#163, ADR-0045); every decision is `AppViewModel`'s. */
data class RoomControls(
    val state: RoomState,
    val setAside: RoomSetAsideState,
    val onOpen: (String) -> Unit,
    val onClose: () -> Unit,
    val onRequestSetAside: () -> Unit,
    val onCancelSetAside: () -> Unit,
    val onConfirmSetAside: () -> Unit,
)

/**
 * #163: one Idea Room (ADR-0045), opened from its place's sheet, in the same poster frame as
 * [PlaceDetail]: the reader's own question, its state in words, each inhabitant as a role with the
 * sentences it holds, the room's chronicle (each line opens its evidence, which the room response
 * already carries) and "Set this room aside" -- never while recording is paused. A claim is its
 * sentence; nothing here says where it came from.
 */
@Composable
internal fun RoomSheet(controls: RoomControls, paused: Boolean) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Surface(
                color = Cosmos.Cream.copy(alpha = 0.94f),
                contentColor = Cosmos.InkOnCream,
                shape = RoundedCornerShape(percent = 50),
                modifier =
                    Modifier.heightIn(min = 48.dp)
                        .clickable(onClickLabel = "Close the room and return to its place", onClick = controls.onClose)
                        .semantics { contentDescription = "Close the room and return to its place" },
            ) {
                Box(Modifier.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                    Text("‹ Place", fontWeight = FontWeight(800), style = MaterialTheme.typography.bodyMedium)
                }
            }
            Text(ROOM_MARK, style = MaterialTheme.typography.labelLarge, color = Cosmos.MutedOnCream, modifier = Modifier.weight(1f))
        }
        when (val state = controls.state) {
            RoomState.Closed -> Unit
            is RoomState.Loading -> Text("Opening the room…", style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
            is RoomState.Failed -> {
                Text(state.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                OutlinedButton(
                    onClick = { controls.onOpen(state.roomId) },
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Retry opening the room" },
                ) { Text("Retry") }
            }
            is RoomState.Loaded -> RoomBody(state.room, controls, paused)
        }
    }
}

@Composable
private fun RoomBody(room: RoomDetail, controls: RoomControls, paused: Boolean) {
    Text(
        "\"${room.question}\"",
        style = MaterialTheme.typography.headlineSmall,
        color = Cosmos.InkOnCream,
        modifier = Modifier.fillMaxWidth().semantics { heading() },
    )
    Text("${roomStateWords(room.state)} · ${room.placeName}", style = MaterialTheme.typography.labelLarge, color = Cosmos.MutedOnCream)
    room.inhabitants.forEach { inhabitant ->
        Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(roomRoleTitle(inhabitant.role), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight(700))
            inhabitant.claims.forEach { Text(roomClaimLine(it), style = MaterialTheme.typography.bodyMedium) }
        }
    }
    Text("What happened here", style = MaterialTheme.typography.labelLarge, color = Cosmos.InkOnCream)
    room.chronicle.forEach { RoomChronicleLine(it) }
    if (room.state == "opened" || room.state == "arguing") RoomSetAside(room, controls, paused)
}

/** A line and, when tapped, what it rests on -- already in the room response, so nothing is fetched. */
@Composable
private fun RoomChronicleLine(entry: RoomChronicleEntry) {
    var open by rememberSaveable(entry.deltaId) { mutableStateOf(false) }
    Column(Modifier.padding(vertical = 2.dp)) {
        Text(
            entry.line,
            style = MaterialTheme.typography.bodyMedium,
            color = Cosmos.InkOnCream,
            modifier =
                Modifier.clickable(onClickLabel = if (open) "Hide evidence" else "Show evidence") { open = !open }
                    .heightIn(min = 48.dp)
                    .semantics { contentDescription = "${if (open) "Hide" else "Show"} evidence: ${entry.line}" },
        )
        if (open) Text(roomEvidenceSummary(entry), style = MaterialTheme.typography.bodySmall, color = Cosmos.MutedOnCream)
    }
}

/** "Set this room aside", with its confirmation step; while recording is paused, a line saying why not. */
@Composable
private fun RoomSetAside(room: RoomDetail, controls: RoomControls, paused: Boolean) {
    val setAside = controls.setAside
    val confirming = (setAside as? RoomSetAsideState.Confirming)?.takeIf { it.roomId == room.roomId }
    val sending = (setAside as? RoomSetAsideState.Sending)?.takeIf { it.roomId == room.roomId }
    val failed = (setAside as? RoomSetAsideState.Failed)?.takeIf { it.roomId == room.roomId }
    when {
        paused ->
            Text("Recording is paused, so this room can't be set aside until you resume.", style = MaterialTheme.typography.bodyMedium, color = Cosmos.MutedOnCream)
        confirming != null || sending != null -> {
            Text(
                "Set this room aside? The questions it holds won't open a room here again unless you clear your history.",
                style = MaterialTheme.typography.bodyMedium,
                color = Cosmos.InkOnCream,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = controls.onConfirmSetAside,
                    colors = ButtonDefaults.buttonColors(containerColor = Cosmos.Coral, contentColor = Cosmos.Dark),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Confirm setting this room aside" },
                ) { Text(if (sending != null) "Setting aside…" else "Set aside", fontWeight = FontWeight(800)) }
                OutlinedButton(
                    onClick = controls.onCancelSetAside,
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Cancel setting this room aside" },
                ) { Text("Cancel") }
            }
        }
        else -> {
            OutlinedButton(
                onClick = controls.onRequestSetAside,
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Set this room aside" },
            ) { Text("Set this room aside") }
            if (failed != null) Text(failed.message, style = MaterialTheme.typography.labelMedium, color = Cosmos.Coral)
        }
    }
}
