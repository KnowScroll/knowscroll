package com.knowscroll.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription

/** Integration seam: only a server-authorized relationship may populate live continuations. */
data class EncounterBranch(
    val id: String,
    val parentAssetId: String,
    val parentRevision: Int,
    val targetAssetId: String,
    val title: String,
    val relationEvidence: String,
)

sealed interface BranchAvailability {
    data object Unavailable : BranchAvailability

    /** #131: the server answered honestly that nothing leads on from here, and why. */
    data class Empty(val reason: String) : BranchAvailability

    data object Loading : BranchAvailability

    data class Ready(val branches: List<EncounterBranch>) : BranchAvailability

    data object Failed : BranchAvailability
}

enum class SupplyStatus {
    Requested,
    Queued,
    Generating,
    PreviewAvailable,
    Ready,
    Failed,
    Retryable,
}

fun SupplyStatus.consumerMessage(): String =
    when (this) {
        SupplyStatus.Requested -> "Your request has been received."
        SupplyStatus.Queued -> "Waiting to be made."
        SupplyStatus.Generating -> "Your continuation is being made."
        SupplyStatus.PreviewAvailable -> "A preview is available."
        SupplyStatus.Ready -> "Ready to explore."
        SupplyStatus.Failed -> "This continuation could not be made."
        SupplyStatus.Retryable -> "This continuation could not be made. You can try again."
    }

/** Horizontal gestures live in this rail, so maps/sliders and vertical prose own their input. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BranchRail(
    availability: BranchAvailability = BranchAvailability.Unavailable,
    onBranch: (EncounterBranch) -> Unit = {},
    modifier: Modifier = Modifier,
    /** False while a chosen continuation is opening, so a second tap cannot race it. */
    enabled: Boolean = true,
) {
    var explanation by remember { mutableStateOf(false) }
    val threshold = with(LocalDensity.current) { 64.dp.toPx() }
    val choices = (availability as? BranchAvailability.Ready)?.branches.orEmpty()
    var drag by remember { mutableFloatStateOf(0f) }
    Column(modifier) {
        Text("Continue this idea →", style = MaterialTheme.typography.labelLarge)
        Row(
            Modifier.fillMaxWidth().semantics { contentDescription = "Branch gesture rail" }.pointerInput(choices, threshold) {
                detectHorizontalDragGestures(
                    onDragStart = { drag = 0f },
                    onDragCancel = { drag = 0f },
                    onDragEnd = {
                        if (enabled && kotlin.math.abs(drag) > threshold) {
                            if (choices.isNotEmpty())
                                onBranch(if (drag < 0) choices.first() else choices.last())
                            else explanation = true
                        }
                        drag = 0f
                    },
                ) { change, amount ->
                    change.consume()
                    drag += amount
                }
            },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            when (availability) {
                BranchAvailability.Loading -> Text("Finding a continuation…")
                BranchAvailability.Failed -> Text("Continuations are unavailable right now.")
                is BranchAvailability.Empty -> Text(availability.reason, style = MaterialTheme.typography.bodyMedium)
                is BranchAvailability.Ready ->
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        choices.forEach { branch ->
                            OutlinedButton(
                                onClick = { onBranch(branch) },
                                enabled = enabled,
                                border = androidx.compose.foundation.BorderStroke(2.dp, LocalContentColor.current),
                                shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
                                colors =
                                    ButtonDefaults.outlinedButtonColors(
                                        contentColor = LocalContentColor.current
                                    ),
                            ) {
                                Text(branch.title)
                            }
                        }
                    }
                BranchAvailability.Unavailable ->
                    OutlinedButton(
                        onClick = { explanation = true },
                        colors =
                            ButtonDefaults.outlinedButtonColors(
                                contentColor = LocalContentColor.current
                            ),
                    ) {
                        Text("About continuations")
                    }
            }
        }
    }
    BackHandler(enabled = explanation) { explanation = false }
    if (explanation)
        AlertDialog(
            containerColor = com.knowscroll.mobile.ui.theme.Cosmos.Cream,
            titleContentColor = com.knowscroll.mobile.ui.theme.Cosmos.InkOnCream,
            textContentColor = com.knowscroll.mobile.ui.theme.Cosmos.InkOnCream,
            onDismissRequest = { explanation = false },
            title = { Text("Continue this idea") },
            text = {
                Text(
                    "Linked continuations are not available in this library yet. Your place is preserved; next discovery explores something else."
                )
            },
            confirmButton = {
                TextButton(onClick = { explanation = false }) { Text("Back to this encounter") }
            },
        )
}
