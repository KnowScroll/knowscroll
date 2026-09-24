package com.knowscroll.mobile.ui.account

import android.content.Context
import androidx.annotation.StringRes
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.Inquiry
import com.knowscroll.mobile.data.InquiryConsent
import com.knowscroll.mobile.data.InquiryPair

/**
 * #132 (ADR-0038): the plain words for what KnowScroll looked for. Everything comes from the
 * server's status and reason codes; the client adds no claim of its own. Reason codes are
 * translated one by one (the validator's closed vocabulary, the reply's shape rules, execution
 * failures and withdrawals); a code this client does not know yet is named, never hidden.
 */

/** Codes that only introduce a more specific one (`shape` + rule, `stale_context` + what changed). */
private val REASON_MARKERS = setOf("shape", "stale_context")

@StringRes
internal fun inquiryReasonRes(code: String): Int? = when (code) {
    // bridge-validator-v1 (`bridgeRejectionReason`)
    "concept_unknown" -> R.string.inquiry_reason_concept_unknown
    "same_concept" -> R.string.inquiry_reason_same_concept
    "hierarchy_not_bridge" -> R.string.inquiry_reason_hierarchy_not_bridge
    "mechanism_is_label" -> R.string.inquiry_reason_mechanism_is_label
    "evidence_unresolved" -> R.string.inquiry_reason_evidence_unresolved
    "evidence_unsupported" -> R.string.inquiry_reason_evidence_unsupported
    "from_side_unsupported" -> R.string.inquiry_reason_from_side_unsupported
    "to_side_unsupported" -> R.string.inquiry_reason_to_side_unsupported
    "mechanism_unsupported" -> R.string.inquiry_reason_mechanism_unsupported
    "direction_unsupported" -> R.string.inquiry_reason_direction_unsupported
    "contradicted_by_substrate" -> R.string.inquiry_reason_contradicted_by_substrate
    "analogy_limit_missing" -> R.string.inquiry_reason_analogy_limit_missing
    "counterevidence_unresolved" -> R.string.inquiry_reason_counterevidence_unresolved
    "counterevidence_ignored" -> R.string.inquiry_reason_counterevidence_ignored
    "counterevidence_cited_as_support" -> R.string.inquiry_reason_counterevidence_cited_as_support
    "duplicate_admitted" -> R.string.inquiry_reason_duplicate_admitted
    "stale_read_set" -> R.string.inquiry_reason_stale_read_set
    "foreign_scope" -> R.string.inquiry_reason_foreign_scope
    "stale_epoch", "obsolete_epoch", "private_state_gone" -> R.string.inquiry_reason_history_cleared
    // The reply's shape (`shape` + rule) and storage
    "shape" -> R.string.inquiry_reason_shape
    "not_one_json_object", "reply_keys" -> R.string.inquiry_reason_reply_form
    "payload_invalid" -> R.string.inquiry_reason_payload_invalid
    "pair_not_offered" -> R.string.inquiry_reason_pair_not_offered
    "claim_not_offered" -> R.string.inquiry_reason_claim_not_offered
    "storage_refused" -> R.string.inquiry_reason_storage_refused
    // Execution
    "no_candidate_pair" -> R.string.inquiry_reason_no_candidate_pair
    "request_too_large" -> R.string.inquiry_reason_request_too_large
    "context_refused" -> R.string.inquiry_reason_context_refused
    "outcome_unknown" -> R.string.inquiry_reason_outcome_unknown
    "provider_error" -> R.string.inquiry_reason_provider_error
    "provider_refusal" -> R.string.inquiry_reason_provider_refusal
    "apply_failed" -> R.string.inquiry_reason_apply_failed
    "not_sent" -> R.string.inquiry_reason_not_sent
    "expired" -> R.string.inquiry_reason_expired
    "worker_stopped", "lease_lost" -> R.string.inquiry_reason_worker_stopped
    // A sealed fact that no longer held (`stale_context` + this)
    "stale_context" -> R.string.inquiry_reason_stale_context
    "place_changed" -> R.string.inquiry_reason_place_changed
    "pair_connected" -> R.string.inquiry_reason_pair_connected
    "claim_changed" -> R.string.inquiry_reason_claim_changed
    "route_disabled" -> R.string.inquiry_reason_route_disabled
    "inquiry_closed" -> R.string.inquiry_reason_inquiry_closed
    "changed_policy" -> R.string.inquiry_reason_changed_policy
    "corrupt_seal", "missing", "foreign", "unsupported", "malformed", "bounds_exceeded" -> R.string.inquiry_reason_seal
    // Withdrawal
    "consent_off" -> R.string.inquiry_reason_consent_off
    "recording_paused" -> R.string.inquiry_reason_recording_paused
    else -> null
}

/** One plain phrase per reason, markers dropped when a specific code follows, repeats merged. */
internal fun inquiryReasonPhrases(codes: List<String>, text: (Int) -> String): List<String> {
    val specific = codes.filter { it !in REASON_MARKERS }
    return (specific.ifEmpty { codes }).map { code ->
        inquiryReasonRes(code)?.let(text) ?: text(R.string.inquiry_reason_unknown).format(code)
    }.distinct()
}

/** "The Sun and Gravity · Orbit and Tides", or "Your places" before (or without) a chosen pair. */
internal fun inquiryPairsTitle(pairs: List<InquiryPair>, context: Context): String =
    if (pairs.isEmpty()) context.getString(R.string.inquiry_pairs_none)
    else pairs.joinToString(" · ") { context.getString(R.string.inquiry_pair, it.a.name, it.b.name) }

/** The one status line under each inquiry. A `waiting` inquiry is waiting either for its
 * coalescing delay or, once today's limit is used, for tomorrow (ADR-0038 §3-4). */
internal fun inquiryStatusLine(inquiry: Inquiry, consent: InquiryConsent, context: Context): String {
    val reasons = { inquiryReasonPhrases(inquiry.reasons, context::getString).joinToString("; ") }
    return when (inquiry.status) {
        "waiting" -> context.getString(
            if (consent.enabled && consent.usedToday >= consent.dailyLimit) R.string.inquiry_status_waiting_limit else R.string.inquiry_status_waiting,
        )
        "looking" -> context.getString(R.string.inquiry_status_looking)
        "found" -> context.getString(R.string.inquiry_status_found)
        "nothing_found" -> context.getString(R.string.inquiry_status_nothing_found)
        "did_not_hold_up" -> context.getString(R.string.inquiry_status_did_not_hold_up, reasons())
        "nothing_to_ask" -> context.getString(R.string.inquiry_status_nothing_to_ask)
        "failed" -> context.getString(R.string.inquiry_status_failed, reasons())
        "withdrawn" -> when (inquiry.reasons) {
            listOf("consent_off") -> context.getString(R.string.inquiry_status_withdrawn_consent_off)
            listOf("recording_paused") -> context.getString(R.string.inquiry_status_withdrawn_recording_paused)
            else -> context.getString(R.string.inquiry_status_withdrawn, reasons())
        }
        // Unreachable: the parser refuses any other status.
        else -> error("Unknown inquiry status")
    }
}
