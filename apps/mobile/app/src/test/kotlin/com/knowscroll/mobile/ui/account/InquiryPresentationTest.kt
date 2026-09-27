package com.knowscroll.mobile.ui.account

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #132 (ADR-0038): every reason the server can give today has its own plain phrase -- the
 * validator's closed vocabulary (`bridgeRejectionReason`), the reply's shape rules, the execution
 * failures and the withdrawals. A code added later is still named, never hidden (see
 * `InquiriesSectionTest.anUnknownReasonIsNamedRatherThanHidden`). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InquiryPresentationTest {
    private val validator = listOf(
        "concept_unknown", "same_concept", "hierarchy_not_bridge", "mechanism_is_label", "evidence_unresolved", "evidence_unsupported",
        "from_side_unsupported", "to_side_unsupported", "mechanism_unsupported", "direction_unsupported", "contradicted_by_substrate",
        "analogy_limit_missing", "counterevidence_unresolved", "counterevidence_ignored", "counterevidence_cited_as_support",
        "duplicate_admitted", "stale_read_set", "foreign_scope", "stale_epoch",
    )
    private val shape = listOf("not_one_json_object", "reply_keys", "payload_invalid", "pair_not_offered", "claim_not_offered", "storage_refused")
    private val failures = listOf(
        "request_too_large", "context_refused", "outcome_unknown", "provider_error", "provider_refusal", "apply_failed", "not_sent",
        "expired", "worker_stopped", "no_candidate_pair",
        // stale_context is followed by what changed:
        "place_changed", "pair_connected", "claim_changed", "route_disabled", "inquiry_closed", "obsolete_epoch", "changed_policy",
        "corrupt_seal", "missing", "foreign", "unsupported", "bounds_exceeded", "malformed", "lease_lost", "private_state_gone",
    )
    private val withdrawals = listOf("consent_off", "recording_paused")

    @Test
    fun everyKnownReasonHasItsOwnPhrase() {
        for (code in validator + shape + failures + withdrawals) assertNotNull(code, inquiryReasonRes(code))
    }

    @Test
    fun markersThatOnlyIntroduceAMoreSpecificCodeAreNotRepeated() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assertEquals(listOf(context.getString(inquiryReasonRes("claim_not_offered")!!)), inquiryReasonPhrases(listOf("shape", "claim_not_offered"), context::getString))
        assertEquals(listOf(context.getString(inquiryReasonRes("pair_connected")!!)), inquiryReasonPhrases(listOf("stale_context", "pair_connected"), context::getString))
        // Alone, a marker still says something true.
        assertEquals(1, inquiryReasonPhrases(listOf("stale_context"), context::getString).size)
        assertEquals(1, inquiryReasonPhrases(listOf("shape"), context::getString).size)
        assertNull(inquiryReasonRes("brand_new_rule"))
    }
}
