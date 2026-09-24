package com.knowscroll.mobile.ui.keep

import android.content.Context
import androidx.annotation.StringRes
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.AwayItem
import com.knowscroll.mobile.data.DoubtTarget
import com.knowscroll.mobile.data.InquiryPair
import com.knowscroll.mobile.data.Relic
import com.knowscroll.mobile.data.RelicTarget
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
    // The chronicle's own deterministic line (ADR-0036), verbatim; a room's is the Keeper's (ADR-0045).
    is AwayItem.PlaceChanged -> item.line
    is AwayItem.RoomChanged -> item.line
    is AwayItem.ConnectionCorrected -> context.getString(
        if (item.status == "revoked") R.string.away_corrected_revoked else R.string.away_corrected_superseded,
        item.fromConcept.name, item.toConcept.name,
    )
}

/** "The Sun and Gravity", or "The Sun and Gravity, or Orbit and Tides" for an inquiry that offered more. */
internal fun awayPairsText(pairs: List<InquiryPair>, context: Context): String =
    pairs.joinToString(context.getString(R.string.away_pairs_separator)) { context.getString(R.string.inquiry_pair, it.a.name, it.b.name) }

/** How many items the collapsed section leaves out: the rest of the pages read, and the older ones
 * the server counted but has not sent yet. */
internal fun awayHiddenCount(listed: Int, shown: Int, more: Long): Long = (listed - shown).coerceAtLeast(0) + more

/** The one line under each Relic: a correction is never hidden, and neither is the reader's doubt --
 * for a place, that they set it aside. */
@StringRes
internal fun relicStateRes(relic: Relic): Int = when (relic.state) {
    "current" -> R.string.relic_state_current
    "corrected" -> R.string.relic_state_corrected
    "doubted" -> if (relic is Relic.Place) R.string.relic_state_set_aside else R.string.relic_state_doubted
    // Unreachable: the parser refuses any other state.
    else -> error("Unknown Relic state")
}

/** #165: what a Relic's card is titled by -- the two places, the place, the claim, the question. */
internal fun relicTitle(relic: Relic, context: Context): String = when (relic) {
    is Relic.Connection -> context.getString(R.string.inquiry_pair, relic.connection.fromConcept.name, relic.connection.toConcept.name)
    is Relic.Place -> relic.anchor.name
    is Relic.Passage -> relic.statement
    is Relic.Answer -> relic.question
}

/** What TalkBack reads for a Relic's card: its kind and what it keeps. */
internal fun relicDescription(relic: Relic, context: Context): String = when (relic) {
    is Relic.Connection -> context.getString(R.string.relic_description, relic.connection.fromConcept.name, relic.connection.toConcept.name)
    is Relic.Place -> context.getString(R.string.relic_place_description, relic.anchor.name)
    is Relic.Passage -> context.getString(R.string.relic_passage_description, relic.title)
    is Relic.Answer -> context.getString(R.string.relic_answer_description, relic.question)
}

@StringRes
internal fun relicKindRes(relic: Relic): Int = when (relic) {
    is Relic.Connection -> R.string.relic_kind_connection
    is Relic.Place -> R.string.relic_kind_place
    is Relic.Passage -> R.string.relic_kind_passage
    is Relic.Answer -> R.string.relic_kind_answer
}

/** What TalkBack reads for Keep, and for its retry, on each kind of thing. */
internal fun keepDescriptions(target: RelicTarget): Pair<Int, Int> = when (target) {
    is RelicTarget.Connection -> R.string.connection_keep_description to R.string.connection_retry_keep_description
    is RelicTarget.Place -> R.string.place_keep_description to R.string.place_retry_keep_description
    is RelicTarget.Passage -> R.string.passage_keep_description to R.string.passage_retry_keep_description
    is RelicTarget.Answer -> R.string.answer_keep_description to R.string.answer_retry_keep_description
}

/** What TalkBack reads for "Seems wrong", and for its retry. A place has none: setting it aside is its doubt. */
internal fun doubtDescriptions(target: DoubtTarget): Pair<Int, Int> = when (target) {
    is RelicTarget.Connection -> R.string.connection_seems_wrong_description to R.string.connection_retry_seems_wrong_description
    is RelicTarget.Passage -> R.string.passage_seems_wrong_description to R.string.passage_retry_seems_wrong_description
    is RelicTarget.Answer -> R.string.answer_seems_wrong_description to R.string.answer_retry_seems_wrong_description
}
