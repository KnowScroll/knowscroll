package com.knowscroll.mobile.ui.keep

import android.content.Context
import androidx.annotation.StringRes
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.AwayItem
import com.knowscroll.mobile.data.InquiryPair
import com.knowscroll.mobile.ui.account.inquiryReasonPhrases

/**
 * #134 (ADR-0039): the plain words for the return and Relics. Every line comes only from an item's
 * type and fields -- concept names, the validator's reason codes (translated as the inquiry list
 * translates them), a delta's own chronicle line -- so the client never adds a claim of its own.
 */
internal fun awayItemLine(item: AwayItem, context: Context): String = when (item) {
    is AwayItem.ConnectionFound -> context.getString(R.string.away_found, item.found.fromConcept.name, item.found.toConcept.name)
    is AwayItem.ConnectionDidNotHoldUp -> context.getString(
        R.string.away_did_not_hold_up, awayPairsText(item.pairs, context),
        inquiryReasonPhrases(item.reasons, context::getString).joinToString("; "),
    )
    is AwayItem.NothingFound -> context.getString(R.string.away_nothing_found, awayPairsText(item.pairs, context))
    // The chronicle's own deterministic line (ADR-0036), verbatim.
    is AwayItem.PlaceChanged -> item.line
    is AwayItem.ConnectionCorrected -> context.getString(
        if (item.status == "revoked") R.string.away_corrected_revoked else R.string.away_corrected_superseded,
        item.fromConcept.name, item.toConcept.name,
    )
}

/** "The Sun and Gravity", or "The Sun and Gravity, or Orbit and Tides" for an inquiry that offered more. */
internal fun awayPairsText(pairs: List<InquiryPair>, context: Context): String =
    pairs.joinToString(context.getString(R.string.away_pairs_separator)) { context.getString(R.string.inquiry_pair, it.a.name, it.b.name) }

/** How many items the collapsed section leaves out: the rest of this list, and the older ones the
 * server counted but did not send. */
internal fun awayHiddenCount(listed: Int, shown: Int, more: Long): Long = (listed - shown).coerceAtLeast(0) + more

/** The one line under each Relic: a correction is never hidden, and neither is the reader's doubt. */
@StringRes
internal fun relicStateRes(state: String): Int = when (state) {
    "current" -> R.string.relic_state_current
    "corrected" -> R.string.relic_state_corrected
    "doubted" -> R.string.relic_state_doubted
    // Unreachable: the parser refuses any other state.
    else -> error("Unknown Relic state")
}
