package com.knowscroll.mobile.ui

/** "Why this appeared" (#91). Every sentence here is built only from fields the API
 * actually returned (the feed/Trace `reason`, `truthState` and the client's own
 * discovery/saved-Trace origin). No interest, learning, profile or evidence path is
 * invented (Law 4, Law 11, Law 13). Kept as pure functions so state transitions and
 * copy stay unit-testable without an Android runtime. */

/** Verbatim reason text, or null when the API sent nothing to show. */
internal fun explainReasonText(reason: String): String? = reason.trim().ifEmpty { null }

internal const val NO_REASON_RECORDED = "No explanation was recorded for this Scroll."

/** Definition section 12's fixed meaning per truth state, worded (#161) so it never points the
 * reader at a source. An unrecognized state returns null rather than guessing a meaning the API
 * did not send. */
internal fun truthStateMeaning(truthState: String): String? = when (truthState) {
    "documented" -> "Directly supported by strong cited evidence."
    "synthesis" -> "An evidence-grounded explanation produced by the system."
    "interpretation" -> "A reasoned perspective rather than settled fact."
    "disputed" -> "Credible evidence materially disagrees."
    "modelled" -> "Produced by an explicit simulation or causal model."
    "counterfactual" -> "Explores a world that did not occur."
    "fictional" -> "Invented for narrative or play."
    else -> null
}

/** Origin sentence: deliberate discovery, or the saved Trace's own kept date. Never a
 * personalization/interest claim (Law 13). */
internal fun explainOriginText(origin: ReaderOrigin): String = when (origin) {
    ReaderOrigin.Discovery -> "You opened this Scroll through deliberate discovery from your universe."
    is ReaderOrigin.SavedTrace -> "This is a saved Trace you kept, from ${origin.keptAt}."
    is ReaderOrigin.Branch -> "You chose a connection from \u201c${origin.fromTitle}\u201d: ${origin.relationSentence}." +
        if (origin.recorded) "" else " Recording was paused, so this step was not kept in your history."
}
