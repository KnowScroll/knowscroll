package com.knowscroll.mobile.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * #131/#134 — live continuations (`GET /v1/assets/:id/branches`, ADR-0031). Every branch here
 * is an admitted, source-backed bridge the server re-checks again when it is opened; the client
 * never invents one, ranks one, or fills an empty list with something unrelated.
 */
data class BranchEvidence(val statement: String, val supports: String, val sourceTitle: String, val sourceUrl: String)

data class BranchLimitation(val kind: String, val statement: String)

data class LiveBranch(
    val branchId: String,
    val bridgeId: String,
    val relationType: String,
    val direction: String,
    val relationPhrase: String,
    val fromName: String,
    val toName: String,
    val mechanism: String,
    val limitations: List<BranchLimitation>,
    val prerequisites: List<String>,
    val evidence: List<BranchEvidence>,
    val targetAssetId: String,
    val targetRevision: Int,
    val targetTitle: String,
    val targetSummary: String,
    val targetSourceTitle: String,
    val seen: Boolean,
) {
    /** "Gravity explains Tides" — the relation in the reader's travel order, from API fields only. */
    val relationSentence: String get() = "$fromName $relationPhrase $toName"
}

data class EncounterBranches(
    val assetId: String,
    val revision: Int,
    val privacyEpoch: Long,
    val branches: List<LiveBranch>,
    /** `no_semantic_annotation` | `no_admitted_bridge` | `no_eligible_target`, or null when not empty. */
    val emptyReason: String?,
)

/** The persisted retry envelope for `POST /v1/branches`: written before dispatch, retried with
 * the same key after ambiguity, discarded when the privacy scope changes. */
data class BranchOpenRequest(
    val clientBranchId: String,
    val fromExposureId: String,
    val bridgeId: String,
    val targetAssetId: String,
    val expectedPrivacyEpoch: Long,
    val universeId: String,
)

data class BranchOpenReceipt(
    val feed: FeedResponse,
    val branchOpenId: String?,
    /** False while recording is paused: served, but nothing personal was kept. */
    val recorded: Boolean,
    val bridgeId: String,
    val relationType: String,
    val direction: String,
)

/** Where a branch-opened Scroll came from, carried on its session so origin and exact return
 * survive recreation and process death. */
data class BranchFrom(
    val fromAssetId: String,
    val fromTitle: String,
    val relationSentence: String,
    val bridgeId: String,
    val recorded: Boolean,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("fromAssetId", fromAssetId); put("fromTitle", fromTitle); put("relationSentence", relationSentence)
        put("bridgeId", bridgeId); put("recorded", recorded)
    }

    companion object {
        fun parse(o: JSONObject) = BranchFrom(
            o.getString("fromAssetId"), o.getString("fromTitle"), o.getString("relationSentence"),
            o.getString("bridgeId"), o.getBoolean("recorded"),
        )
    }
}

internal fun parseEncounterBranches(o: JSONObject): EncounterBranches {
    val arr = o.getJSONArray("branches")
    val branches = List(arr.length()) { i -> parseLiveBranch(arr.getJSONObject(i)) }
    val emptyReason = if (o.isNull("emptyReason")) null else o.getString("emptyReason")
    require(branches.isEmpty() == (emptyReason != null)) { "An empty continuation list must say why, and only an empty one" }
    require(emptyReason == null || emptyReason in setOf("no_semantic_annotation", "no_admitted_bridge", "no_eligible_target")) { "Unknown empty reason" }
    return EncounterBranches(o.getString("assetId"), o.getInt("revision"), o.getLong("privacyEpoch"), branches, emptyReason)
}

private fun parseLiveBranch(o: JSONObject): LiveBranch {
    val from = o.getJSONObject("fromConcept")
    val to = o.getJSONObject("toConcept")
    val target = o.getJSONObject("target")
    val direction = o.getString("direction")
    require(direction == "forward" || direction == "reverse") { "Unknown branch direction" }
    require(target.getString("kind") == "Scroll") { "Only Scroll continuations are supported" }
    val evidence = o.getJSONArray("evidence").objects().map {
        BranchEvidence(it.getString("statement"), it.getString("supports"), it.getString("sourceTitle"), it.getString("sourceUrl"))
    }
    require(evidence.isNotEmpty()) { "A continuation must carry its evidence" }
    return LiveBranch(
        branchId = o.getString("branchId"), bridgeId = o.getString("bridgeId"),
        relationType = o.getString("relationType"), direction = direction, relationPhrase = o.getString("relationPhrase"),
        fromName = from.getString("name"), toName = to.getString("name"), mechanism = o.getString("mechanism"),
        limitations = o.getJSONArray("limitations").objects().map { BranchLimitation(it.getString("kind"), it.getString("statement")) },
        prerequisites = o.getJSONArray("prerequisites").strings(), evidence = evidence,
        targetAssetId = target.getString("assetId"), targetRevision = target.getInt("revision"),
        targetTitle = target.getString("title"), targetSummary = target.getString("summary"),
        targetSourceTitle = target.getString("sourceTitle"), seen = o.getBoolean("seen"),
    )
}

private fun JSONArray.objects(): List<JSONObject> = List(length()) { getJSONObject(it) }
private fun JSONArray.strings(): List<String> = List(length()) { getString(it) }
