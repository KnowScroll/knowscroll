package com.knowscroll.mobile.ui.why

import com.knowscroll.mobile.data.EncounterWhy
import com.knowscroll.mobile.data.WhyStep

/** #133: one line per recorded evidence step, from API fields only. */
internal fun whyStepText(step: WhyStep): String = when (step) {
    is WhyStep.Mark -> when (step.markKind) {
        "keep" -> "You kept “${step.title}”"
        "branch" -> "You followed a connection from “${step.title}”"
        else -> "You asked about “${step.title}”"
    }
    is WhyStep.Bridge -> step.sentence
    is WhyStep.Question -> "A question you asked that has no answer yet"
    is WhyStep.Outside -> "Somewhere you have not been shown before"
    is WhyStep.Demand -> "You had already seen everything here"
}

/** The why panel for the encounter on screen. `Unrecorded` is honest absence, not a failure. */
sealed interface WhyAvailability {
    data object Loading : WhyAvailability
    data class Ready(val why: EncounterWhy) : WhyAvailability
    data object Unrecorded : WhyAvailability
    data object Failed : WhyAvailability
}

data class WhyPanel(
    val decisionId: String,
    val assetId: String,
    val availability: WhyAvailability,
    /** The correction being sent, if any: its control is disabled until it settles. */
    val sending: String? = null,
    /** Corrections this reader already made here, so none is offered twice; the others stay available. */
    val corrected: Set<String> = emptySet(),
    val message: String? = null,
)

internal fun correctionLabel(kind: String): String = when (kind) {
    "less_like_this" -> "Less like this"
    else -> "Wrong connection"
}

internal fun correctedText(kind: String): String = when (kind) {
    "less_like_this" -> "You will see less of this route for 14 days. Nothing shared changed."
    else -> "This connection is hidden for you. Nothing shared changed."
}
