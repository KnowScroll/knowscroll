package com.knowscroll.mobile.data

import org.json.JSONObject

/** Existing ADR-0025 wire payload. Never an arbitrary remote URL or provider credential. */
data class ReelMedia(
    val path: String,
    val durationSeconds: Double,
    val aspect: String,
    val simulated: Boolean,
    /** #199: the engine that made this Reel checked its own work (publication-v2). Shown as
     * "Engine-checked", never as an independent review. */
    val engineChecked: Boolean = false,
) {
    init {
        require(path.matches(Regex("/v1/media/[0-9a-f]{64}")))
        require(durationSeconds.isFinite() && durationSeconds > 0)
        require(aspect.matches(Regex("[1-9][0-9]{0,4}:[1-9][0-9]{0,4}")))
    }

    fun toJson() =
        JSONObject()
            .put("mediaUrl", path)
            .put("durationSeconds", durationSeconds)
            .put("aspect", aspect)
            .put("simulated", simulated)
            .put("generatedLabel", true)
            .apply { if (engineChecked) put("check", JSONObject().put("by", "engine")) }

    companion object {
        /** #199: only a check by the engine itself is recognised; anything else is no check. */
        fun engineChecked(by: String?): Boolean = by == "engine"

        fun parse(value: JSONObject): ReelMedia {
            require(value.getBoolean("generatedLabel"))
            return ReelMedia(
                value.getString("mediaUrl"),
                value.getDouble("durationSeconds"),
                value.getString("aspect"),
                value.getBoolean("simulated"),
                engineChecked(value.optJSONObject("check")?.optString("by")),
            )
        }
    }
}

sealed interface EncounterContent {
    data class Document(val body: String) : EncounterContent

    data class Video(val media: ReelMedia) : EncounterContent
}
