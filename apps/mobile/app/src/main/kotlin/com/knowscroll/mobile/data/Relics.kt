package com.knowscroll.mobile.data

import org.json.JSONObject

/**
 * #134 — Relics (ADR-0039 §3-5): durable, private things the reader deliberately keeps, with
 * provenance and a truth state that shows any later correction. First kind: `connection`, one
 * admitted bridge. Strict, mirroring `packages/contracts/src/relics.ts` (`.strict()` on every
 * object): an unknown kind or state, an unexpected key, a missing field, a value out of bounds, or
 * a state the contract's refinement forbids ("corrected" exactly when the connection is no longer
 * admitted) all throw, like [parseInquiriesResponse], whose found-bridge parsing this reuses.
 */
data class RelicProvenance(
    /** The background inquiry that found it, when it came from one (ADR-0038). */
    val inquiryId: String?,
    val validatorVersion: String,
    val citedClaimKeys: List<String>,
)

data class Relic(
    val relicId: String,
    val keptAt: String,
    /** One of [RELIC_STATES]: `current`; `corrected` (a source correction revoked or superseded it
     * after it was kept -- the kept form stays readable); `doubted` (the reader marked it "seems
     * wrong" after keeping it). */
    val state: String,
    /** The connection as it reads now, with the evidence it was admitted on. */
    val connection: InquiryFound,
    val provenance: RelicProvenance,
)

data class RelicsResponse(val privacyEpoch: Long, val relics: List<Relic>)

data class RelicKeepResponse(val privacyEpoch: Long, val relic: Relic)

data class RelicReleaseResponse(val privacyEpoch: Long, val relicId: String)

/** One explicit "Keep" of a connection (kind `connection`). Idempotent server-side by
 * [clientRequestId]: an ambiguous failure re-sends exactly this. */
data class RelicKeepRequest(val clientRequestId: String, val expectedPrivacyEpoch: Long, val bridgeId: String)

/** "Let go": releasing one that is already gone answers the same, so a retry is this again. */
data class RelicReleaseRequest(val relicId: String, val expectedPrivacyEpoch: Long)

/** "Seems wrong" on a connection (ADR-0031, ADR-0039 §5): personal suppression, never a retraction
 * of shared knowledge. Idempotent server-side by [clientFeedbackId]. */
data class ConnectionFeedbackRequest(val clientFeedbackId: String, val bridgeId: String, val expectedPrivacyEpoch: Long, val objection: String = "seems_wrong")

const val RELIC_LIST_LIMIT = 100

internal val RELIC_STATES = setOf("current", "corrected", "doubted")

internal fun parseRelicsResponse(o: JSONObject): RelicsResponse {
    o.requireKeys("privacyEpoch", "relics")
    val relics = o.array("relics").strictObjects().map(::parseRelic)
    require(relics.size <= RELIC_LIST_LIMIT) { "The Relic list exceeds its $RELIC_LIST_LIMIT-row cap" }
    return RelicsResponse(o.epoch("privacyEpoch"), relics)
}

internal fun parseRelicKeepResponse(o: JSONObject): RelicKeepResponse {
    o.requireKeys("privacyEpoch", "relic")
    return RelicKeepResponse(o.epoch("privacyEpoch"), parseRelic(o.obj("relic")))
}

internal fun parseRelicReleaseResponse(o: JSONObject): RelicReleaseResponse {
    o.requireKeys("privacyEpoch", "relicId", "released")
    require(o.bool("released")) { "A release receipt says it was released" }
    return RelicReleaseResponse(o.epoch("privacyEpoch"), o.uuid("relicId"))
}

internal fun parseRelic(o: JSONObject): Relic {
    o.requireKeys("relicId", "kind", "keptAt", "state", "connection", "provenance")
    require(o.string("kind") == "connection") { "Unknown Relic kind" }
    val state = o.string("state")
    require(state in RELIC_STATES) { "Unknown Relic state" }
    val connection = parseInquiryFound(o.obj("connection"))
    // The contract's own refinement (`relicWire.superRefine`): a correction is never hidden, and
    // never claimed for a connection that still stands.
    require((state == "corrected") == (connection.bridgeStatus != "admitted")) { "Corrected exactly when the connection is no longer admitted" }
    val p = o.obj("provenance")
    p.requireKeys("inquiryId", "validatorVersion", "citedClaimKeys")
    val validatorVersion = p.string("validatorVersion")
    require(validatorVersion.isNotEmpty() && validatorVersion.length <= 80) { "Invalid validator version" }
    val keysArray = p.array("citedClaimKeys")
    val cited = List(keysArray.length()) { i ->
        (keysArray.get(i) as? String)?.takeIf { it.isNotEmpty() && it.length <= 200 } ?: throw IllegalArgumentException("Invalid claim key")
    }
    require(cited.size in 1..12) { "A Relic cites the claims it was admitted on" }
    val inquiryId = if (p.isNull("inquiryId")) null else p.uuid("inquiryId")
    return Relic(o.uuid("relicId"), o.datetime("keptAt"), state, connection, RelicProvenance(inquiryId, validatorVersion, cited))
}
