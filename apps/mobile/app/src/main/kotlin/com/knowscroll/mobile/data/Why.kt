package com.knowscroll.mobile.data

import org.json.JSONObject

/**
 * #133 — "why this appeared" (`GET /v1/decisions/:id/why`, ADR-0032 §4–§5), read back exactly as
 * the Composer recorded it: the family that chose it, the rendered reason, and the evidence path
 * built from recorded acts. The client adds nothing — no interest, profile or guessed motive — and
 * refuses a payload the server could not have recorded.
 */
sealed interface WhyStep {
    data class Mark(val markKind: String, val assetId: String, val title: String, val at: String, val eventId: String) : WhyStep
    data class Bridge(val bridgeId: String, val sentence: String) : WhyStep
    data class Question(val concept: String) : WhyStep
    data class Outside(val domain: String) : WhyStep
}

data class EncounterWhy(
    val decisionId: String,
    val assetId: String,
    val family: String,
    val reason: String,
    val steps: List<WhyStep>,
    /** The corrections this encounter supports: `less_like_this`, `wrong_connection`, or none. */
    val corrections: List<String>,
)

data class EncounterFeedbackReceipt(val feedbackId: String, val kind: String, val suppressedUntil: String)

internal val WHY_FAMILIES = setOf("continue", "deepen", "bridge", "challenge", "revisit", "frontier", "seed", "fallback")
internal val ENCOUNTER_CORRECTIONS = setOf("less_like_this", "wrong_connection")

internal fun parseWhy(o: JSONObject): EncounterWhy {
    val family = o.getString("family")
    require(family in WHY_FAMILIES) { "Unknown Composer family" }
    val evidence = o.getJSONArray("evidence")
    val steps = (0 until evidence.length()).map { i ->
        val s = evidence.getJSONObject(i)
        when (s.getString("kind")) {
            "mark" -> WhyStep.Mark(s.getString("markKind"), s.getString("assetId"), s.getString("title"), s.getString("at"), s.getString("eventId")).also {
                require(it.markKind in setOf("keep", "branch", "ask")) { "Unknown act in the evidence path" }
                require(it.eventId.isNotBlank()) { "A cited act must name its recorded event" }
            }
            "bridge" -> WhyStep.Bridge(s.getString("bridgeId"), s.getString("sentence"))
            "question" -> WhyStep.Question(s.getString("concept"))
            "outside" -> WhyStep.Outside(s.getString("domain"))
            else -> throw IllegalArgumentException("Unknown evidence step")
        }
    }
    val correctionsJson = o.getJSONArray("corrections")
    val corrections = (0 until correctionsJson.length()).map { correctionsJson.getString(it) }
    require(corrections.all { it in ENCOUNTER_CORRECTIONS }) { "Unknown correction" }
    require(family != "fallback" || corrections.isEmpty()) { "An unmapped encounter has no route to correct" }
    require("wrong_connection" !in corrections || steps.any { it is WhyStep.Bridge }) { "Only a connection can be wrong" }
    return EncounterWhy(o.getString("decisionId"), o.getString("assetId"), family, o.getString("reason"), steps, corrections)
}
