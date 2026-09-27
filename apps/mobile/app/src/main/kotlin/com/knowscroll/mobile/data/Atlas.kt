package com.knowscroll.mobile.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * #134 — the reader's places (ADR-0036, `GET /v1/atlas`, `GET /v1/atlas/deltas/:deltaId`). Strict,
 * mirroring `packages/contracts/src/atlas.ts`: every kind and enum is checked against the wire
 * contract and a missing required field throws, exactly like [parseEncounterBranches]/[parseWhy].
 * The client invents no place, no relation and no chronicle line -- only what the Cartographer
 * actually formed and recorded a delta for. #164: each place carries the reader's live need for more
 * about it ([PlaceDemand]), strict like `packages/contracts/src/inventory.ts`.
 */
data class AtlasAnchor(val code: String, val name: String, val description: String)

data class AtlasClaim(val text: String, val sourceTitle: String)

data class AtlasBridgeSupport(val mechanism: String)

data class AtlasBasis(
    val kind: String,
    val from: String,
    val to: String,
    val claim: AtlasClaim?,
    val bridge: AtlasBridgeSupport?,
)

data class AtlasAttention(val state: String, val episodes: Int, val daysActive: Int, val sourceFamilies: Int)

data class AtlasScrollCounts(val total: Int, val seen: Int)

/** ADR-0037: a live planet or region that explains, or comes before, what the reader's other places
 * are about -- [holdsUp] are those places' ids, [relations] the sourced connections that say so. */
data class AtlasFoundation(val holdsUp: List<String>, val relations: List<AtlasBasis>)

/** #164 (ADR-0046 §6): a Scroll bound to the reader's need, ready for them. */
data class BoundScroll(val assetId: String, val title: String)

/**
 * #164 (ADR-0046 §6): the reader's live need for more about a place's anchor. [status] is `waiting`
 * (a Scroll is being written), `bound` ([scroll] is ready) or `cannot_meet` ([reason] says why: one of
 * [CANNOT_MEET_REASONS]). [withdrawn]: the last Scroll bound to this need was withdrawn because what it
 * was based on changed. It names a concept's place and, once bound, a Scroll: never a source.
 */
data class PlaceDemand(val demandId: String, val status: String, val reason: String?, val scroll: BoundScroll?, val withdrawn: Boolean)

data class AtlasPlace(
    val placeId: String,
    /** `planet` | `region` | `sighting`. */
    val kind: String,
    val parentPlaceId: String?,
    val anchor: AtlasAnchor,
    val basis: AtlasBasis?,
    val attention: AtlasAttention?,
    val scrolls: AtlasScrollCounts,
    val formedAt: String,
    val formedBy: String,
    /** `null` unless the Cartographer recognised this place as a foundation; never on a sighting. */
    val foundation: AtlasFoundation? = null,
    /** #163 (ADR-0045): the reader's live Idea Rooms here, oldest first; never on a sighting. */
    val rooms: List<AtlasRoom> = emptyList(),
    /** `null` unless the reader's reading recorded a need for more about this place's anchor. */
    val demand: PlaceDemand? = null,
)

data class AtlasRelation(
    val fromPlaceId: String,
    val toPlaceId: String,
    val kind: String,
    val claim: AtlasClaim?,
    val bridge: AtlasBridgeSupport?,
)

data class AtlasChronicleEntry(
    val deltaId: String,
    val placeId: String,
    /** The place this change belonged to at the time (a sighting's/released region's parent);
     * `null` for a planet or a change with no parent. */
    val parentPlaceId: String?,
    val kind: String,
    val causalClass: String,
    val at: String,
    val line: String,
)

data class AtlasResponse(
    val policyVersion: String,
    val places: List<AtlasPlace>,
    val relations: List<AtlasRelation>,
    val chronicle: List<AtlasChronicleEntry>,
)

/** One delta's evidence (`atlasDeltaSchema`). [kind]/[causalClass] are wider than the chronicle's
 * enum (e.g. `sighting_promoted`), so only non-blank is required, matching the server contract. */
data class AtlasDelta(
    val deltaId: String,
    val placeId: String,
    val kind: String,
    val causalClass: String,
    val policyVersion: String,
    val at: String,
    val anchorCode: String,
    val anchorName: String,
    val before: Map<String, Any?>?,
    val after: Map<String, Any?>,
    val evidence: Map<String, Any?>,
)

internal val ATLAS_PLACE_KINDS = setOf("planet", "region", "sighting")
internal val ATLAS_RELATION_KINDS =
    setOf("prerequisite_for", "explains", "contradicts", "analogous_in", "applies_to", "compares_mechanism")
internal val ATLAS_ATTENTION_STATES = setOf("seen", "anchored", "dormant")
internal val ATLAS_CHRONICLE_KINDS =
    setOf(
        "place_formed", "sighting_appeared", "sighting_retired", "place_rejected", "place_released",
        "foundation_recognised", "foundation_withdrawn",
    )
internal val ATLAS_CAUSAL_CLASSES =
    setOf("personal_exploration", "substrate_neighbourhood", "source_correction", "reader_correction")
internal val PLACE_DEMAND_STATUSES = setOf("waiting", "bound", "cannot_meet")
/** `packages/contracts/src/inventory.ts`'s `cannotMeetReason`. */
internal val CANNOT_MEET_REASONS = setOf("no_route", "no_budget", "no_material", "checks_failed", "request_failed")

internal fun parseAtlasResponse(o: JSONObject): AtlasResponse {
    val places = o.getJSONArray("places").objects().map(::parseAtlasPlace)
    val relations = o.getJSONArray("relations").objects().map(::parseAtlasRelation)
    val chronicle = o.getJSONArray("chronicle").objects().map(::parseChronicleEntry)
    require(chronicle.size <= 20) { "Atlas chronicle exceeds its 20-line cap" }
    require(o.getString("policyVersion").isNotBlank()) { "Atlas is missing its policy version" }
    return AtlasResponse(o.getString("policyVersion"), places, relations, chronicle)
}

internal fun parseAtlasPlace(o: JSONObject): AtlasPlace {
    val kind = o.getString("kind")
    require(kind in ATLAS_PLACE_KINDS) { "Unknown place kind" }
    val anchorObj = o.getJSONObject("anchor")
    val anchor = AtlasAnchor(anchorObj.getString("code"), anchorObj.getString("name"), anchorObj.getString("description"))
    val basis = if (o.isNull("basis")) null else parseAtlasBasis(o.getJSONObject("basis"))
    val attentionObj = if (o.isNull("attention")) null else o.getJSONObject("attention")
    val attention = attentionObj?.let {
        val state = it.getString("state")
        require(state in ATLAS_ATTENTION_STATES) { "Unknown attention state" }
        AtlasAttention(state, it.getInt("episodes"), it.getInt("daysActive"), it.getInt("sourceFamilies"))
    }
    require(kind != "sighting" || attention == null) { "A sighting is something the reader has not been shown" }
    // Nullable, not optional: every place says whether it is a foundation (ADR-0037).
    require(o.has("foundation")) { "A place must say whether it is a foundation" }
    val foundation = if (o.isNull("foundation")) null else parseAtlasFoundation(o.getJSONObject("foundation"))
    require(kind != "sighting" || foundation == null) { "A sighting holds nothing up: it has not been met" }
    // Required, like `foundation`: every place says which rooms it holds (ADR-0045).
    require(o.has("rooms")) { "A place must say which rooms it holds" }
    val rooms = o.getJSONArray("rooms").strictObjects().map(::parseAtlasRoom)
    require(rooms.size <= 3 && (kind != "sighting" || rooms.isEmpty())) { "A place holds at most three live rooms, and a sighting none" }
    // Nullable, not optional: every place says whether the reader needs more about it (ADR-0046).
    require(o.has("demand")) { "A place must say whether there is a need for more about it" }
    val demand = if (o.isNull("demand")) null else parsePlaceDemand(o.getJSONObject("demand"))
    val scrollsObj = o.getJSONObject("scrolls")
    val scrolls = AtlasScrollCounts(scrollsObj.getInt("total"), scrollsObj.getInt("seen"))
    return AtlasPlace(
        placeId = o.getString("placeId"), kind = kind,
        parentPlaceId = if (o.isNull("parentPlaceId")) null else o.getString("parentPlaceId"),
        anchor = anchor, basis = basis, attention = attention, scrolls = scrolls,
        formedAt = o.getString("formedAt").also { require(it.isNotBlank()) { "A place must carry when it formed" } },
        formedBy = o.getString("formedBy").also { require(it.isNotBlank()) { "A place must carry why it formed" } },
        foundation = foundation,
        rooms = rooms,
        demand = demand,
    )
}

/** Strict, like the contract's `placeDemand`: exactly its keys, and only a bound need names a Scroll
 * and only one that cannot be met a reason. */
internal fun parsePlaceDemand(o: JSONObject): PlaceDemand {
    o.requireKeys("demandId", "status", "reason", "scroll", "withdrawn")
    val status = o.string("status")
    require(status in PLACE_DEMAND_STATUSES) { "Unknown demand status" }
    val reason = if (o.isNull("reason")) null else o.string("reason")
    require((status == "cannot_meet") == (reason != null) && (reason == null || reason in CANNOT_MEET_REASONS)) { "Only a need that cannot be met says why" }
    val scroll = if (o.isNull("scroll")) null else o.obj("scroll").let {
        it.requireKeys("assetId", "title")
        BoundScroll(it.uuid("assetId"), it.nonEmpty("title"))
    }
    require((status == "bound") == (scroll != null)) { "Only a bound need names a Scroll" }
    return PlaceDemand(o.uuid("demandId"), status, reason, scroll, o.bool("withdrawn"))
}

internal fun parseAtlasFoundation(o: JSONObject): AtlasFoundation {
    val holdsUp = o.getJSONArray("holdsUp").let { a -> List(a.length()) { a.getString(it) } }
    require(holdsUp.isNotEmpty() && holdsUp.all { it.isNotBlank() }) { "A foundation holds at least one place up" }
    val relations = o.getJSONArray("relations").objects().map(::parseAtlasBasis)
    require(relations.isNotEmpty()) { "A foundation cites the connections that make it one" }
    return AtlasFoundation(holdsUp, relations)
}

internal fun parseAtlasBasis(o: JSONObject): AtlasBasis {
    val kind = o.getString("kind")
    require(kind in ATLAS_RELATION_KINDS) { "Unknown relation kind" }
    val (claim, bridge) = parseSupport(o)
    return AtlasBasis(kind, o.getString("from"), o.getString("to"), claim, bridge)
}

internal fun parseAtlasRelation(o: JSONObject): AtlasRelation {
    val kind = o.getString("kind")
    require(kind in ATLAS_RELATION_KINDS) { "Unknown relation kind" }
    val (claim, bridge) = parseSupport(o)
    return AtlasRelation(o.getString("fromPlaceId"), o.getString("toPlaceId"), kind, claim, bridge)
}

/** `{claim, bridge}`: both nullable, never both non-null in practice, but the wire shape always
 * carries both keys (mirrors `packages/contracts/src/atlas.ts`'s shared `support` object). */
private fun parseSupport(o: JSONObject): Pair<AtlasClaim?, AtlasBridgeSupport?> {
    val claim = if (o.isNull("claim")) null else o.getJSONObject("claim").let { AtlasClaim(it.getString("text"), it.getString("sourceTitle")) }
    val bridge = if (o.isNull("bridge")) null else o.getJSONObject("bridge").let { AtlasBridgeSupport(it.getString("mechanism")) }
    return claim to bridge
}

internal fun parseChronicleEntry(o: JSONObject): AtlasChronicleEntry {
    val kind = o.getString("kind")
    require(kind in ATLAS_CHRONICLE_KINDS) { "Unknown chronicle kind" }
    val causalClass = o.getString("causalClass")
    require(causalClass in ATLAS_CAUSAL_CLASSES) { "Unknown causal class" }
    return AtlasChronicleEntry(
        o.getString("deltaId"), o.getString("placeId"),
        if (o.isNull("parentPlaceId")) null else o.getString("parentPlaceId"),
        kind, causalClass,
        o.getString("at").also { require(it.isNotBlank()) { "A chronicle line must carry when it happened" } },
        o.getString("line").also { require(it.isNotBlank()) { "A chronicle line must carry its own text" } },
    )
}

internal fun parseAtlasDelta(o: JSONObject): AtlasDelta {
    val kind = o.getString("kind"); require(kind.isNotBlank()) { "A delta must carry its kind" }
    val causalClass = o.getString("causalClass"); require(causalClass.isNotBlank()) { "A delta must carry its causal class" }
    val policyVersion = o.getString("policyVersion"); require(policyVersion.isNotBlank()) { "A delta must carry its policy version" }
    val anchor = o.getJSONObject("anchor")
    return AtlasDelta(
        deltaId = o.getString("deltaId"), placeId = o.getString("placeId"), kind = kind, causalClass = causalClass,
        policyVersion = policyVersion, at = o.getString("at"),
        anchorCode = anchor.getString("code"), anchorName = anchor.getString("name"),
        before = if (o.isNull("before")) null else o.getJSONObject("before").toPlainMap(),
        after = o.getJSONObject("after").toPlainMap(),
        evidence = o.getJSONObject("evidence").toPlainMap(),
    )
}

private fun JSONArray.objects(): List<JSONObject> = List(length()) { getJSONObject(it) }

/** A structurally-equal, Compose-state-friendly copy of a `z.record(z.string(), z.unknown())`
 * payload -- `org.json.JSONObject`/`JSONArray` have no structural `equals`, which would otherwise
 * defeat both recomposition and plain test assertions on [AtlasDelta.before]/[after]/[evidence]. */
internal fun JSONObject.toPlainMap(): Map<String, Any?> {
    val names = keys()
    val result = LinkedHashMap<String, Any?>()
    while (names.hasNext()) {
        val key = names.next()
        result[key] = plainJsonValue(get(key))
    }
    return result
}

private fun plainJsonValue(value: Any?): Any? = when (value) {
    JSONObject.NULL, null -> null
    is JSONObject -> value.toPlainMap()
    is JSONArray -> List(value.length()) { plainJsonValue(value.get(it)) }
    else -> value
}
