package com.knowscroll.mobile.ui.branch

import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.EncounterBranches
import com.knowscroll.mobile.data.LiveBranch
import com.knowscroll.mobile.data.ScrollItem
import com.knowscroll.mobile.ui.BranchAvailability
import com.knowscroll.mobile.ui.EncounterBranch

/**
 * #131/#134 — pure mapping from the server's continuations to PR130's `BranchRail` seam. Kept
 * out of the ViewModel so the copy and the empty/conflict rules are unit-testable, and so the
 * rail never shows anything the API did not send.
 */
data class BranchPanel(
    /** The encounter these continuations belong to; a panel for another asset is never shown. */
    val assetId: String,
    val availability: BranchAvailability,
    val branches: List<LiveBranch> = emptyList(),
    /** The branch currently being opened, if any: the rail is disabled until it settles. */
    val opening: String? = null,
    /** A visible, honest note after a failure (e.g. the connection was withdrawn). */
    val message: String? = null,
)

fun branchAvailabilityOf(result: EncounterBranches, parent: ScrollItem): BranchAvailability {
    if (result.branches.isEmpty()) return BranchAvailability.Empty(emptyReasonText(result.emptyReason))
    return BranchAvailability.Ready(result.branches.map { branch ->
        EncounterBranch(
            id = branch.branchId,
            parentAssetId = parent.assetId,
            parentRevision = parent.revision,
            targetAssetId = branch.targetAssetId,
            title = railLabel(branch),
            relationEvidence = branch.mechanism,
        )
    })
}

/** "Explains Tides", "Is explained by Gravity", "Is like Homeostasis". */
fun railLabel(branch: LiveBranch): String =
    "${branch.relationPhrase.replaceFirstChar { it.uppercaseChar() }} ${branch.toName}"

fun emptyReasonText(reason: String?): String = when (reason) {
    "no_semantic_annotation" -> "This Scroll has not been mapped to ideas yet, so no connection is offered."
    "no_admitted_bridge" -> "No connection leads on from this idea yet."
    "no_eligible_target" -> "A connection exists, but no Scroll about the other side is available yet."
    else -> "No connection is available here."
}

enum class BranchOpenConflict { StaleEpoch, Unavailable }

/** A 409 from `POST /v1/branches` is either a privacy-epoch change (reconcile) or a connection
 * that was withdrawn, suppressed or reused (refresh the list). Neither purges the reader. */
fun branchOpenConflict(error: ApiException.Server): BranchOpenConflict? {
    if (error.statusCode != 409) return null
    val body = error.message ?: ""
    return if (body.contains("privacy epoch", ignoreCase = true)) BranchOpenConflict.StaleEpoch else BranchOpenConflict.Unavailable
}
