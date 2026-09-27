package com.knowscroll.mobile.data

import org.json.JSONObject

/** Existing ADR-0025 wire payload. Never an arbitrary remote URL or provider credential. */
data class ReelMedia(
    val path: String,
    val durationSeconds: Double,
    val aspect: String,
    val simulated: Boolean,
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

    companion object {
        fun parse(value: JSONObject): ReelMedia {
            require(value.getBoolean("generatedLabel"))
            return ReelMedia(
                value.getString("mediaUrl"),
                value.getDouble("durationSeconds"),
                value.getString("aspect"),
                value.getBoolean("simulated"),
            )
        }
    }
}

sealed interface EncounterContent {
    data class Document(val body: String) : EncounterContent

    data class Video(val media: ReelMedia) : EncounterContent
}
