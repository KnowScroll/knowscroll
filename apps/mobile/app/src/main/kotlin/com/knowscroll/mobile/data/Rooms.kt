package com.knowscroll.mobile.data

import org.json.JSONObject

/**
 * #163 — Idea Rooms (ADR-0045): a place's live rooms on the atlas (`GET /v1/atlas`) and one room
 * with its chronicle and each line's evidence (`GET /v1/rooms/:roomId`). Strict, mirroring
 * `packages/contracts/src/rooms.ts`, which is `.strict()` on every object: an unknown role, state,
 * kind or support, an unexpected key, a missing field, a bound the contract sets, or a ladder that
 * does not follow the doubter all throw, exactly like [parseAwayResponse]. A claim is its sentence
 * and truth state; nothing here can carry where it came from.
 */
data class RoomClaim(
    val key: String,
    val statement: String,
    val truthState: String,
    /** `supports` the room's anchor, or a source `qualifies` or `contradicts` it. */
    val supportKind: String,
)

/** A seat of evidence access (`reader_of_record`, `doubter`, `connector`) and the claims it holds. */
data class RoomInhabitant(val role: String, val claims: List<RoomClaim>)

/** A live room as its place carries it. [question] is the reader's own words. */
data class AtlasRoom(
    val roomId: String,
    val question: String,
    /** `opened` | `arguing`: two readings disagree exactly when the doubter is seated. */
    val state: String,
    val inhabitants: List<RoomInhabitant>,
    val openedAt: String,
)

data class RoomAskEvidence(val askId: String, val day: String)

/** What a chronicle line rests on: the Asks that carried the question, or the claims a seat holds
 * now and held before. */
data class RoomEvidence(val asks: List<RoomAskEvidence>, val claims: List<RoomClaim>, val previous: List<RoomClaim>)

data class RoomChronicleEntry(
    val deltaId: String,
    val kind: String,
    val causalClass: String,
    /** The seat a change is about; `null` for a change to the room itself. */
    val role: String?,
    val at: String,
    /** The Keeper's own deterministic line, never model text. */
    val line: String,
    val evidence: RoomEvidence,
)

data class RoomDetail(
    val roomId: String,
    val placeId: String,
    val placeName: String,
    val question: String,
    /** `opened` | `arguing` | `set_aside` | `retired`. */
    val state: String,
    val inhabitants: List<RoomInhabitant>,
    val openedAt: String,
    /** Newest first. */
    val chronicle: List<RoomChronicleEntry>,
)

internal val ROOM_ROLES = listOf("reader_of_record", "doubter", "connector")
internal val ROOM_STATES = setOf("opened", "arguing", "set_aside", "retired")
internal val ROOM_DELTA_KINDS =
    setOf("room_opened", "question_joined", "inhabitant_seated", "position_changed", "inhabitant_unseated", "room_set_aside", "room_retired")
internal val ROOM_SUPPORT_KINDS = setOf("supports", "qualifies", "contradicts")
internal val CLAIM_TRUTH_STATES = setOf("documented", "synthesis", "interpretation", "disputed", "modelled", "counterfactual", "fictional")
private val ISO_DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")
const val ROOM_CHRONICLE_LIMIT = 50

internal fun parseAtlasRoom(o: JSONObject): AtlasRoom {
    o.requireKeys("roomId", "question", "state", "inhabitants", "openedAt")
    val state = o.string("state")
    require(state == "opened" || state == "arguing") { "Only a live room is on its place" }
    val inhabitants = parseInhabitants(o, state)
    return AtlasRoom(o.uuid("roomId"), question(o), state, inhabitants, o.datetime("openedAt"))
}

internal fun parseRoomResponse(o: JSONObject): RoomDetail {
    o.requireKeys("roomId", "placeId", "placeName", "question", "state", "inhabitants", "openedAt", "chronicle")
    val state = o.string("state")
    require(state in ROOM_STATES) { "Unknown room state" }
    val placeName = o.string("placeName")
    require(placeName.isNotEmpty() && placeName.length <= 80) { "Invalid place name" }
    val chronicle = o.array("chronicle").strictObjects().map(::parseRoomChronicleEntry)
    require(chronicle.size in 1..ROOM_CHRONICLE_LIMIT) { "A room's chronicle has one to $ROOM_CHRONICLE_LIMIT lines" }
    return RoomDetail(o.uuid("roomId"), o.uuid("placeId"), placeName, question(o), state, parseInhabitants(o, state), o.datetime("openedAt"), chronicle)
}

private fun question(o: JSONObject): String =
    o.string("question").also { require(it.isNotEmpty() && it.length <= 4096) { "Invalid question" } }

/** One seat per role, one to four claims each; a live room argues exactly when its doubter is
 * seated, and a room set aside or retired seats no one (the contract's own ladder refinement). */
private fun parseInhabitants(o: JSONObject, state: String): List<RoomInhabitant> {
    val inhabitants = o.array("inhabitants").strictObjects().map { i ->
        i.requireKeys("role", "claims")
        val role = i.string("role")
        require(role in ROOM_ROLES) { "Unknown room role" }
        RoomInhabitant(role, i.array("claims").strictObjects().map(::parseRoomClaim).also { require(it.size in 1..4) { "A seat holds one to four claims" } })
    }
    require(inhabitants.map { it.role }.toSet().size == inhabitants.size) { "One seat per role" }
    val live = state == "opened" || state == "arguing"
    require(if (live) (state == "arguing") == inhabitants.any { it.role == "doubter" } else inhabitants.isEmpty()) { "The ladder follows the doubter" }
    return inhabitants
}

internal fun parseRoomClaim(o: JSONObject): RoomClaim {
    o.requireKeys("key", "statement", "truthState", "supportKind")
    val key = o.string("key")
    require(key.isNotEmpty() && key.length <= 80) { "Invalid claim key" }
    val statement = o.string("statement")
    require(statement.isNotEmpty() && statement.length <= 400) { "Invalid claim statement" }
    val truthState = o.string("truthState")
    require(truthState in CLAIM_TRUTH_STATES) { "Unknown truth state" }
    val supportKind = o.string("supportKind")
    require(supportKind in ROOM_SUPPORT_KINDS) { "Unknown support kind" }
    return RoomClaim(key, statement, truthState, supportKind)
}

internal fun parseRoomChronicleEntry(o: JSONObject): RoomChronicleEntry {
    o.requireKeys("deltaId", "kind", "causalClass", "role", "at", "line", "evidence")
    val kind = o.string("kind")
    require(kind in ROOM_DELTA_KINDS) { "Unknown room change" }
    val causalClass = o.string("causalClass")
    require(causalClass in ATLAS_CAUSAL_CLASSES) { "Unknown causal class" }
    val role = if (o.isNull("role")) null else o.string("role").also { require(it in ROOM_ROLES) { "Unknown room role" } }
    val line = o.string("line")
    require(line.isNotEmpty() && line.length <= 600) { "Invalid chronicle line" }
    val evidence = o.obj("evidence").also { it.requireKeys("asks", "claims", "previous") }
    val asks = evidence.array("asks").strictObjects().map { a ->
        a.requireKeys("askId", "day")
        RoomAskEvidence(a.uuid("askId"), a.string("day").also { require(ISO_DAY.matches(it)) { "Invalid day" } })
    }
    val claims = { name: String -> evidence.array(name).strictObjects().map(::parseRoomClaim).also { require(it.size <= 4) { "At most four claims" } } }
    return RoomChronicleEntry(o.uuid("deltaId"), kind, causalClass, role, o.datetime("at"), line, RoomEvidence(asks, claims("claims"), claims("previous")))
}
